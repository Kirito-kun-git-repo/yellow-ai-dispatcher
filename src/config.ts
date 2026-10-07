// Every tunable in one place. Each one is read once at startup so that a value
// cannot change under a running loop, and each carries the requirement it
// serves -- a constant whose purpose is not written down gets tuned by someone
// who does not know what it was protecting.

import { hostname } from 'node:os';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export const config = {
  databaseUrl: str(
    'DATABASE_URL',
    'postgres://dispatcher:dispatcher@localhost:5433/dispatcher',
  ),

  // Bounded so a slow provider cannot exhaust the pool (ADR-002).
  poolMax: int('PG_POOL_MAX', 10),

  apiPort: int('API_PORT', 3100),
  providerPort: int('PROVIDER_PORT', 4010),
  providerUrl: str('PROVIDER_URL', 'http://localhost:4010'),

  // R6. Applied to every tenant the API sees for the first time.
  rateLimitPerSec: int('RATE_LIMIT_PER_SEC', 50),

  // --- worker timing (ADR-007) ---------------------------------------------

  // No provider call may run without a deadline, or a hung provider pins a
  // worker forever (ADR-002). This is also what turns a hang into the
  // third outcome -- "unknown" -- rather than a stall.
  providerTimeoutMs: int('PROVIDER_TIMEOUT_MS', 2000),

  // Worst-case crash recovery time for R5/T3 equals this, because there is no
  // reaper: an abandoned row becomes claimable again only when its lease
  // expires. ADR-007 fixes the floor it must clear:
  //
  //   LEASE >= max( 3 * providerTimeoutMs , batchSize / rateLimitPerSec * safety )
  //
  // At the defaults that is max(6000, 400) = 6s, so 15s leaves real headroom.
  // Raise batchSize or drop rateLimitPerSec far enough and the second term
  // wins; the slot-horizon check in the worker is what keeps that safe rather
  // than silently duplicating sends.
  leaseMs: int('LEASE_MS', 15_000),

  pollIntervalMs: int('POLL_INTERVAL_MS', 250),

  // Also the worker's maximum concurrency: every message in a batch is
  // dispatched on its own promise, so that a message waiting on a provider
  // reply cannot delay another message past its reserved rate-limit slot.
  batchSize: int('BATCH_SIZE', 20),

  // Full-jitter exponential backoff: delay = random(0, base * 2^(attempts-1)),
  // capped. Jitter matters because a batch fails together -- without it every
  // message in that batch retries at the same instant, forever.
  backoffBaseMs: int('BACKOFF_BASE_MS', 500),
  backoffMaxMs: int('BACKOFF_MAX_MS', 8000),

  maxAttempts: 5, // R4, and mirrored by a CHECK constraint in schema.sql

  workerId: str('WORKER_ID', `${hostname()}-${process.pid}`),
} as const;

export type Config = typeof config;
