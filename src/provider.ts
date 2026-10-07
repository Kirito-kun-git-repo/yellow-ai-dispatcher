// Mock provider (P1, P2, P3).
//
// Deliberately shares nothing with the dispatcher: no database, no module, no
// clock source beyond the host's. It is the oracle that T1, T2 and T4 are
// argued from, so if a bug in our schema could also corrupt its records, it
// would be grading its own work. State lives in this process's memory and
// nowhere else.

import { resolve } from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';

const PORT = Number(process.env.PROVIDER_PORT ?? 4010);

// P2's rates. Overridable so a test can isolate one rule at a time -- proving
// "no send before send_at" is cleaner without 30% of the traffic failing.
const ERROR_RATE = Number(process.env.PROVIDER_ERROR_RATE ?? 0.2);
const TIMEOUT_RATE = Number(process.env.PROVIDER_TIMEOUT_RATE ?? 0.1);

// A timed-out request is answered by never answering. The socket still has to
// be let go eventually or a long run accumulates them; the caller gave up long
// before this fires.
const HANG_CLEANUP_MS = Number(process.env.PROVIDER_HANG_CLEANUP_MS ?? 30_000);

interface AcceptedSend {
  key: string;
  tenant_id: string | null;
  campaign_id: string | null;
  user_id: string | null;
  /** Milliseconds since the epoch, with sub-millisecond precision. */
  accepted_at_ms: number;
  accepted_at: string;
  /** How the request that caused this acceptance ended, for diagnostics. */
  outcome: 'replied' | 'hung';
}

/**
 * Append-only. One entry per *acceptance*, not per key.
 *
 * It would be smaller as a Map keyed by idempotency key, and that is exactly
 * what makes it the wrong shape: a Map cannot physically hold a duplicate, so
 * the test's exactly-once assertion would be true by the oracle's data
 * structure rather than by the system's behaviour. An array can hold a
 * duplicate. That the test never finds one is then a fact about the dispatcher.
 */
const acceptedLog: AcceptedSend[] = [];

/** O(1) dedupe set. The array above is the record; this is just the index. */
const acceptedKeys = new Set<string>();

/** Every /send call received, keyed by idempotency key. Diagnostics only. */
const requestCounts = new Map<string, number>();

function nowMs(): number {
  // Date.now() is integer milliseconds. At 50 sends/sec the limiter spaces
  // sends 20ms apart, so integer ms would be adequate -- but T4 slides a window
  // across these values, and a tie at a window edge is better resolved than
  // rounded. performance.timeOrigin + performance.now() keeps the fraction.
  return performance.timeOrigin + performance.now();
}

export function buildProvider() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, process: 'provider', error_rate: ERROR_RATE, timeout_rate: TIMEOUT_RATE });
  });

  app.post('/send', (req: Request, res: Response) => {
    const key = req.get('Idempotency-Key');
    if (!key) {
      return res.status(400).json({ error: 'Idempotency-Key header is required' });
    }

    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);

    // ------------------------------------------------------------------
    // The key is checked BEFORE the failure dice are rolled. This ordering
    // is a hard requirement from ADR-006, not a micro-optimisation.
    //
    // Roll first and a retry of an already-accepted key can come back 500.
    // The dispatcher would then never learn the message was accepted, would
    // keep retrying, and could reach FAILED after five attempts while the
    // recipient has the message in hand. The counts would be confidently
    // wrong, and assertion 4 of T1 -- a FAILED message appears zero times in
    // /stats -- would break.
    //
    // Real idempotent APIs replay the stored response first for this reason.
    // ------------------------------------------------------------------
    if (acceptedKeys.has(key)) {
      return res.status(200).json({ status: 'accepted', duplicate: true });
    }

    const roll = Math.random();

    // 20%: a clean refusal. Nothing is recorded, because nothing was sent.
    if (roll < ERROR_RATE) {
      return res.status(500).json({ error: 'provider transient failure' });
    }

    const record = (outcome: 'replied' | 'hung') => {
      const ms = nowMs();
      acceptedKeys.add(key);
      acceptedLog.push({
        key,
        tenant_id: req.get('X-Tenant-Id') ?? null,
        campaign_id: req.get('X-Campaign-Id') ?? null,
        user_id: req.get('X-User-Id') ?? null,
        accepted_at_ms: ms,
        accepted_at: new Date(ms).toISOString(),
        outcome,
      });
    };

    // 10%: P2 says the mock *does* send on a timeout, and simply never replies.
    // That is the case the whole retry design exists for -- the caller cannot
    // tell this apart from a message that never arrived.
    if (roll < ERROR_RATE + TIMEOUT_RATE) {
      record('hung');
      const timer = setTimeout(() => res.destroy(), HANG_CLEANUP_MS);
      // If the caller aborts first (it will, at its own deadline), drop the
      // cleanup timer so it cannot keep the event loop alive at shutdown.
      res.on('close', () => clearTimeout(timer));
      return;
    }

    record('replied');
    return res.status(200).json({ status: 'accepted', duplicate: false });
  });

  // --- P3 ------------------------------------------------------------------
  app.get('/stats', (_req, res) => {
    res.json({
      total_accepted: acceptedLog.length,
      distinct_keys_accepted: acceptedKeys.size,
      total_requests: [...requestCounts.values()].reduce((a, b) => a + b, 0),
      accepted: acceptedLog,
      request_counts: Object.fromEntries(requestCounts),
    });
  });

  // Not part of the brief. The test harness needs a known-empty oracle at the
  // start of each run, and restarting the process to get one makes the harness
  // harder to read than this three-line endpoint does.
  app.post('/reset', (_req, res) => {
    acceptedLog.length = 0;
    acceptedKeys.clear();
    requestCounts.clear();
    res.json({ ok: true });
  });

  return app;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  buildProvider().listen(PORT, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'provider listening',
        port: PORT,
        error_rate: ERROR_RATE,
        timeout_rate: TIMEOUT_RATE,
      }),
    );
  });
}
