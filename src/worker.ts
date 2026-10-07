// Worker process.
//
// One loop: sweep, claim, reserve rate-limit slots, send, record the outcome.
// Run as many copies as you like; correctness does not depend on how many.
//
// The one hard rule inherited from ADR-003: no database transaction is ever
// held open across the provider call. The claim commits, the HTTP call happens
// with nothing open, and the result is written in a second short statement.
// That is what lets `in_progress` be visible to GET /campaigns/:id while a send
// is in flight, and what lets a worker wait on a rate-limit slot without
// pinning a Postgres backend.

import { resolve } from 'node:path';
import { config } from './config.ts';
import { query, waitForDatabase, closePool } from './db.ts';
import {
  SWEEP_UNRECOVERABLE,
  CLAIM_BATCH,
  CANCELLED_AMONG,
  RESERVE_SLOTS,
  MARK_SENT,
  MARK_RETRY,
  MARK_FAILED,
  MARK_CANCELLED_CLAIMED,
  MARK_SLOT_RELEASED,
} from './sql.ts';
import { send } from './provider-client.ts';

interface ClaimedMessage {
  id: number;
  campaign_id: number;
  tenant_id: string;
  user_id: string;
  /** Already incremented by the claim, so this is the attempt about to happen. */
  attempts: number;
  send_at: Date;
}

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, worker: config.workerId, msg, ...extra }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stats = { claimed: 0, sent: 0, failed: 0, cancelled: 0, retried: 0,
                leaseLost: 0, swept: 0, released: 0 };
let running = true;

/**
 * Full-jitter exponential backoff: random(0, min(base * 2^(n-1), cap)).
 *
 * The jitter is not decoration. A batch of messages fails together -- one
 * provider hiccup rejects all twenty -- and without jitter all twenty retry at
 * the same instant, collide again, and keep marching in lockstep until they
 * exhaust their attempts together. Randomising the whole interval, not just a
 * fraction of it, is what actually spreads them.
 */
function backoffMs(attempts: number): number {
  const ceiling = Math.min(config.backoffBaseMs * 2 ** (attempts - 1), config.backoffMaxMs);
  return Math.floor(Math.random() * ceiling);
}

async function sweep(): Promise<void> {
  const r = await query(SWEEP_UNRECOVERABLE);
  if (r.rowCount) {
    stats.swept += r.rowCount;
    log('warn', 'swept unrecoverable messages', {
      count: r.rowCount,
      // Which disposition each got -- CANCELLED means the campaign was cancelled
      // under it, FAILED means it hit the attempt cap and lost its worker.
      dispositions: r.rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
    });
  }
}

async function claim(): Promise<ClaimedMessage[]> {
  const r = await query<ClaimedMessage>(CLAIM_BATCH, [
    config.workerId,
    config.leaseMs,
    config.batchSize,
  ]);
  stats.claimed += r.rowCount ?? 0;
  return r.rows;
}

/** Reserve `count` slots for one tenant; returns when the first may go and the gap after that. */
async function reserveSlots(
  tenantId: string,
  count: number,
): Promise<{ firstDelayMs: number; spacingMs: number }> {
  const r = await query(RESERVE_SLOTS, [tenantId, count]);
  const row = r.rows[0];
  if (!row) {
    // POST /campaigns creates the limiter row in the same transaction as the
    // campaign, so this cannot happen for a message that came through the API.
    // If it ever does, the safe move is to refuse to send rather than to send
    // unthrottled.
    throw new Error(`no rate limit row for tenant ${tenantId}`);
  }
  const firstSlot = new Date(row.first_slot).getTime();
  const dbNow = new Date(row.db_now).getTime();
  return {
    // Both timestamps come from the database, so this difference never depends
    // on the worker's clock agreeing with the database's.
    firstDelayMs: Math.max(0, firstSlot - dbNow),
    spacingMs: 1000 / Number(row.rate_per_sec),
  };
}

async function finish(m: ClaimedMessage, sql: string, params: unknown[]): Promise<void> {
  const r = await query(sql, params);
  if (r.rowCount === 0) {
    // The guard `AND worker_id = $2 AND status = 'IN_PROGRESS'` matched nothing:
    // this worker stalled past its lease and someone else owns the row now.
    // Writing our result would stomp theirs, so we write nothing and say so.
    stats.leaseLost += 1;
    log('warn', 'lease lost before completion; result discarded', { message_id: m.id });
  }
}

async function deliver(m: ClaimedMessage, delayMs: number): Promise<void> {
  if (delayMs > 0) await sleep(delayMs);

  const outcome = await send({
    campaignId: m.campaign_id,
    tenantId: m.tenant_id,
    userId: m.user_id,
  });

  if (outcome.kind === 'accepted') {
    stats.sent += 1;
    await finish(m, MARK_SENT, [m.id, config.workerId]);
    return;
  }

  // rejected and unknown take the same path on purpose (ADR-006b). A timeout is
  // not treated as a send: the mock happens to deliver on timeout, but a real
  // provider promises nothing, and a timeout is just as likely to mean the
  // request never landed. Retrying with the same key resolves the ambiguity --
  // the provider answers "already accepted" and the row becomes SENT with the
  // true result instead of a guessed one.
  const detail = `${outcome.kind}: ${outcome.detail}`;

  if (m.attempts >= config.maxAttempts) {
    stats.failed += 1;
    await finish(m, MARK_FAILED, [m.id, config.workerId, detail]);
    return;
  }

  const wait = backoffMs(m.attempts);
  stats.retried += 1;
  await finish(m, MARK_RETRY, [m.id, config.workerId, wait, detail]);
}

/** One pass. Returns how many messages were claimed, so the caller can pace itself. */
async function tick(): Promise<number> {
  await sweep();

  const batch = await claim();
  if (batch.length === 0) return 0;
  // Everything after this is measured against the instant the lease started.
  const claimedAt = Date.now();

  // A campaign can be cancelled between the claim and the send. These rows were
  // legitimately claimed, so they must be disposed of rather than left -- but
  // they must not be sent. R3: a cancelled campaign sends no more messages.
  const campaignIds = [...new Set(batch.map((m) => m.campaign_id))];
  const cancelledRes = await query(CANCELLED_AMONG, [campaignIds]);
  const cancelled = new Set<number>(cancelledRes.rows.map((r) => r.id));

  const toCancel = batch.filter((m) => cancelled.has(m.campaign_id));
  const toSend = batch.filter((m) => !cancelled.has(m.campaign_id));

  if (toCancel.length > 0) {
    const r = await query(MARK_CANCELLED_CLAIMED, [toCancel.map((m) => m.id), config.workerId]);
    stats.cancelled += r.rowCount ?? 0;
    log('info', 'claimed messages belonged to a cancelled campaign', { count: r.rowCount });
  }

  if (toSend.length === 0) return batch.length;

  // One reservation per tenant, not per message: a single round trip buys the
  // whole group's slots and advances the tenant's clock once.
  const byTenant = new Map<string, ClaimedMessage[]>();
  for (const m of toSend) {
    const list = byTenant.get(m.tenant_id);
    if (list) list.push(m);
    else byTenant.set(m.tenant_id, [m]);
  }

  const scheduled: Array<{ m: ClaimedMessage; delayMs: number }> = [];
  const overHorizon: Array<{ m: ClaimedMessage; delayMs: number }> = [];

  // How long this worker can still promise to hold the lease. The claim set
  // lease_until = claim time + leaseMs; a send needs up to providerTimeoutMs
  // after it starts, so anything scheduled past this point would still be
  // waiting when the lease lapses. ADR-009's slot horizon rule.
  const sinceClaim = Date.now() - claimedAt;
  const horizonMs = config.leaseMs - config.providerTimeoutMs - sinceClaim;

  for (const [tenantId, group] of byTenant) {
    const { firstDelayMs, spacingMs } = await reserveSlots(tenantId, group.length);
    group.forEach((m, i) => {
      const delayMs = firstDelayMs + i * spacingMs;
      (delayMs > horizonMs ? overHorizon : scheduled).push({ m, delayMs });
    });
  }

  // Give these back rather than wait past the lease. The slots stay reserved --
  // the limiter has already moved the tenant's clock -- so this under-sends for
  // one cycle, which is the safe direction for an upper bound.
  if (overHorizon.length > 0) {
    const soonest = Math.min(...overHorizon.map((x) => x.delayMs));
    const r = await query(MARK_SLOT_RELEASED, [
      overHorizon.map((x) => x.m.id),
      config.workerId,
      soonest,
    ]);
    stats.released += r.rowCount ?? 0;
    log('warn', 'released messages whose slot fell beyond the lease horizon', {
      count: r.rowCount,
      horizon_ms: Math.round(horizonMs),
      soonest_slot_ms: Math.round(soonest),
      hint: 'batchSize / rateLimitPerSec is approaching leaseMs; lower BATCH_SIZE or raise LEASE_MS',
    });
  }

  // Every message gets its own promise, so a message blocked on a slow provider
  // reply cannot push another message past its reserved slot. Batch size is
  // therefore also the worker's maximum concurrency -- which is why it is small.
  await Promise.all(
    scheduled.map(({ m, delayMs }) =>
      deliver(m, delayMs).catch((err) =>
        log('error', 'deliver threw', { message_id: m.id, err: String(err) }),
      ),
    ),
  );

  return batch.length;
}

async function main(): Promise<void> {
  await waitForDatabase();
  log('info', 'worker started', {
    lease_ms: config.leaseMs,
    batch_size: config.batchSize,
    poll_ms: config.pollIntervalMs,
    provider_timeout_ms: config.providerTimeoutMs,
  });

  while (running) {
    try {
      const n = await tick();
      // Only back off when there was nothing to do. A full batch means there is
      // probably more waiting, so go straight round again.
      if (n === 0) await sleep(config.pollIntervalMs);
    } catch (err) {
      log('error', 'tick failed', { err: String(err) });
      await sleep(config.pollIntervalMs);
    }
  }

  log('info', 'worker stopped', stats);
  await closePool();
  process.exit(0);
}

// SIGTERM is the graceful path: finish the batch in flight, then leave.
// T3 uses SIGKILL instead, which by design runs none of this -- the messages
// this worker holds stay IN_PROGRESS until their lease expires and another
// worker's claim query sweeps them up.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('info', 'shutdown signal received; finishing current batch', { signal: sig });
    running = false;
  });
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await main();
}
