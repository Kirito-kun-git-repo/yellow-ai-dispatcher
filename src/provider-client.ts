// The provider client exists to turn an HTTP call into exactly three outcomes.
//
// A boolean would be wrong, and it is the single most consequential type in the
// service. A provider call can end in three genuinely different states:
//
//   accepted  the provider has it. Safe to mark SENT.
//   rejected  a non-2xx reply. The provider definitely does NOT have it.
//   unknown   a timeout. The provider may or may not have it, and no amount of
//             local reasoning will tell us which.
//
// Collapsing `unknown` into either of the others loses R4. Call it rejected and
// a message the recipient already received can still be retried -- harmless only
// because of the idempotency key. Call it accepted and a message that never
// arrived is reported SENT, which is a lie the counts cannot recover from.
//
// Keeping it separate is what makes the retry meaningful: attempt 2 sends the
// same key, the provider replays "already accepted", and the true outcome is
// *discovered* rather than guessed.

import { config } from './config.ts';

export type SendOutcome =
  | { kind: 'accepted'; duplicate: boolean }
  | { kind: 'rejected'; detail: string }
  | { kind: 'unknown'; detail: string };

export interface SendRequest {
  campaignId: number;
  tenantId: string;
  userId: string;
  channel?: string;
}

/**
 * The idempotency key (ADR-004).
 *
 * Deliberately derivable from nothing but the campaign id and the recipient, so
 * the test harness can compute the expected key set from the seed data it
 * generated itself rather than from the database it is grading. A key built
 * from the message row's primary key would make the oracle a function of the
 * system under test: insert a duplicate row by mistake and you get two ids, two
 * expected keys, two accepted sends -- and a green test while one person
 * received the message twice.
 */
export function idempotencyKey(campaignId: number, userId: string): string {
  return `${campaignId}:${userId}`;
}

export async function send(req: SendRequest): Promise<SendOutcome> {
  const key = idempotencyKey(req.campaignId, req.userId);

  let res: Response;
  try {
    res = await fetch(`${config.providerUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'X-Tenant-Id': req.tenantId,
        'X-Campaign-Id': String(req.campaignId),
        'X-User-Id': req.userId,
      },
      body: JSON.stringify({ channel: req.channel ?? 'SMS', to: req.userId }),
      // No provider call runs without a deadline. Without this a hung provider
      // holds the worker and its lease forever, and the message never moves.
      signal: AbortSignal.timeout(config.providerTimeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    // AbortSignal.timeout() raises TimeoutError; an explicit abort raises
    // AbortError. Both mean the request was in flight when we gave up, so the
    // provider's state is genuinely unknown.
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { kind: 'unknown', detail: `timeout after ${config.providerTimeoutMs}ms` };
    }
    // Connection refused, DNS failure, socket reset. Some of these mean the
    // request never landed, but not all do, and we cannot tell which from here.
    // `unknown` is the honest answer; both outcomes retry anyway.
    return { kind: 'unknown', detail: `transport: ${String(err)}` };
  }

  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { duplicate?: boolean };
    return { kind: 'accepted', duplicate: body.duplicate === true };
  }

  // Every non-2xx is retryable here because the mock emits only transient
  // errors. A production client would treat 4xx as terminal and stop burning
  // attempts on a request that will never be accepted -- noted in the README as
  // a deliberate simplification rather than an oversight.
  const text = await res.text().catch(() => '');
  return { kind: 'rejected', detail: `HTTP ${res.status} ${text.slice(0, 200)}` };
}
