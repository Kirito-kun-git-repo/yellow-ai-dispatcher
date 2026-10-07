---
adr: 9
title: Rate limiter — placement and mechanism
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-009 — Rate limiter

**Status:** Accepted
**Date:** 2026-10-07

## Context

R6: each tenant has a limit of N sends per second, applying to all workers together.

T4 proves it: *"prove from the provider timestamps that no tenant went above N sends in
**any one-second window**."*

**Any** one-second window means a **sliding** window, not aligned clock seconds. That one
word eliminates the two implementations usually reached for first.

## 9a — Where the limiter sits

### Option A — immediately before each provider call
### Option B — at claim time: claim at most N rows per tenant per second

B fails T4. A worker claims 50 rows in one query and then takes 3 seconds to drain them
through the provider. The *claims* were limited; the *sends* were not. T4 reads provider
timestamps, so it measures exactly the thing B did not limit.

**Decision: A.**

## 9b — What backs it

### Option B — fixed-window counter
A row per `(tenant_id, second)`, `UPSERT ... WHERE cnt < N`.

Send N at `t = 0.99` and N more at `t = 1.01`. Both aligned windows are within limit. The
sliding window `[0.99, 1.99)` holds **2N**. T4 fails.

### Option C — token bucket, capacity N, refill N/sec
The textbook answer. Start with a full bucket, spend all N at `t = 0`, then spend each
refilled token as it arrives. By `t = 1-` the window `[0, 1)` holds `N + N ~= 2N`.

T4 fails, and it fails *because of* the burst capacity — the feature a token bucket is
chosen for.

The general rule:

```
max sends in any sliding 1-second window = burst_capacity + N
```

To land at N the burst capacity must be 1 token, not N. A capacity-1 token bucket is not a
bucket any more; it is pure spacing of `1/N` seconds between sends. That is option A.

### Option A — GCRA / next-slot reservation
One row per tenant holding `next_slot_at`:

```sql
UPDATE tenant_limits
SET next_slot_at = GREATEST(next_slot_at, clock_timestamp())
                   + (interval '1 second' / rate_per_sec)
WHERE tenant_id = $1
RETURNING next_slot_at - (interval '1 second' / rate_per_sec) AS slot;
```

Every send is spaced at least `1/N` apart, so any one-second window holds at most N. The
call never rejects — it returns the instant this send is allowed. The worker sleeps until
`slot`, then calls the provider. No reject-and-retry loop, no spinning, and it is roughly
FIFO-fair because Postgres queues row locks in arrival order.

`GREATEST(next_slot_at, clock_timestamp())` is load-bearing. Without it an idle tenant
accumulates credit in the past and the first burst after an idle period spends it all at
once, reintroducing exactly the problem option C has.

### Option D — Redis
Same algorithm math as B or C, so it fails T4 for the same reasons unless GCRA is
implemented — at which point it is option A plus a container to run, plus a second source of
truth that can disagree with Postgres after a crash.

## Scoring

| | A GCRA slot | B fixed window | C token bucket (cap N) | D Redis |
|---|---|---|---|---|
| **R6** global across workers | ✅ | ✅ | ✅ | ✅ |
| **T4** sliding window <= N | ✅ exact | ❌ up to 2N | ❌ up to 2N | ❌ unless GCRA |
| Extra infrastructure | none | none | none | one container |
| Direction of error on crash | conservative | permissive | permissive | — |

## Decision

**9a: A — gate immediately before the provider call.**
**9b: A — GCRA next-slot reservation, one row per tenant in Postgres.**

Note the crash direction: a worker that dies after reserving a slot leaves that slot
unused. The limiter under-sends and never over-sends. For a requirement phrased as an upper
bound that is the right direction to fail, and it follows from reserving before sending
rather than counting after.

## Consequences

- `tenant_limits(tenant_id PK, rate_per_sec int, next_slot_at timestamptz)`. Carried into
  [[ADR-012-schema-and-indexes]].
- The limiter `UPDATE` runs in **its own short transaction** and uses `clock_timestamp()`,
  not `now()`. Inside a longer transaction `now()` is frozen at transaction start and the
  spacing computes against a stale instant. Per [[ADR-008-clock-source]].
- **Slot horizon rule:** if the reserved slot is later than
  `lease_until - PROVIDER_TIMEOUT`, the worker releases the message back to `PENDING`
  instead of waiting. Waiting past that point means the lease expires while the message is
  held, another worker claims it, and both send. Same constraint
  [[ADR-007-timing-and-backoff]] flagged, now with a concrete rule.
- Every send takes a row lock on one row per tenant, so that row is a deliberate
  serialization point per tenant. Acceptable at N <= 100/s. At much higher rates this needs
  sharded buckets or a dedicated limiter; to be stated in the README (D3) rather than
  implying the design scales unchanged.
- **Default N = 50/s.** 1,000 messages in a single tenant cannot finish faster than
  `1000/N` seconds, so N sets the test's runtime floor: 20 seconds at 50/s, 100 seconds at
  10/s.
- [[ADR-015-test-harness]] seeds across **4 tenants**, so the limiter is exercised per
  tenant. A single-tenant test would pass even if the limiter were keyed globally.

## Related

- [[ADR-007-timing-and-backoff]]
- [[ADR-008-clock-source]]
- [[ADR-014-polling-and-batch-size]]
- [[ADR-015-test-harness]]
