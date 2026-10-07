---
adr: 3
title: Claim model — how a worker takes ownership of a message
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-003 — Claim model

**Status:** Accepted
**Date:** 2026-10-07

## Context

Two or more worker processes poll the same `messages` table. A worker must take ownership
of a due message in a way that no other worker can take it at the same time (R1), that
survives the worker being killed mid-flight (R5), and that leaves the message's state
visible to the status endpoint while work is in progress (R7).

This is the highest-priority decision in the brief.

## Options

### A. Lease / visibility timeout

Claim in a short transaction, commit, then call the provider with no transaction open.

```sql
UPDATE messages m
SET status      = 'IN_PROGRESS',
    lease_until = now() + interval '30 seconds',
    worker_id   = $1,
    attempts    = attempts + 1
WHERE m.id IN (
  SELECT id FROM messages
  WHERE status = 'PENDING'
    AND send_at <= now()
    AND next_attempt_at <= now()
  ORDER BY send_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
RETURNING m.*;
```

A reaper resets rows whose `lease_until` has passed.

- Cost: the reaper must be written.
- Cost: **zombie worker.** A worker that is alive but stalled keeps working past its lease.
  The reaper hands the row to another worker and both call the provider. The database
  cannot prevent this; the idempotency key makes it harmless.

### B. Hold the row lock across the provider call

`BEGIN` → `SELECT ... FOR UPDATE SKIP LOCKED` → HTTP call → `UPDATE` → `COMMIT`.

Crash recovery is free and immediate: `kill -9` drops the socket, Postgres rolls back and
releases the lock.

- Cost: a database transaction stays open across an HTTP call that times out 10% of the
  time. One backend process is pinned per in-flight message.
- Cost: `idle in transaction` holds back the xmin horizon, so autovacuum cannot reclaim
  dead rows while any worker waits on the provider.
- Cost: the "free" recovery only holds when the OS sends a RST. A frozen host instead
  waits on TCP keepalive, which defaults to hours.

### C. Session-level advisory locks

`pg_try_advisory_lock(message_id)` held on the connection, not the transaction.

- Cost: a pooled connection must be pinned per in-flight message.
- Cost: `SKIP LOCKED` is lost as a batch primitive — candidates are selected, then
  try-locked one at a time, a round trip per message.
- Cost: advisory locks have **no expiry**.

## Scoring against the acceptance requirements

| | A — Lease | B — Lock held | C — Advisory |
|---|---|---|---|
| **R1** exactly one send | ✅ with key | ✅ with key | ✅ with key |
| **R2** no early send | ✅ | ✅ | ✅ |
| **R4** retry ≠ second send | ✅ with key | ✅ with key | ✅ with key |
| **R5** crash, not stuck | ✅ bounded by lease | ✅ immediate | ❌ |
| **R6** rate limit | ✅ | ❌ | ✅ |
| **R7** counts correct | ✅ | ❌ | ✅ |
| **T3** `kill -9` | ✅ | ✅ | ✅ |

### Why B fails R7

A3 requires the response to carry an `in_progress` count. Under B the status change is
inside the open transaction, so it is uncommitted for the whole duration of the provider
call and invisible to any other connection. `GET /campaigns/:id` would report those
messages as `pending` while they are in flight, and `in_progress` would be permanently 0.
That is not "eventually correct" — it is wrong, and wrong during exactly the window the
reviewer is watching.

### Why B fails R6

When a tenant's rate-limit budget is exhausted the worker must wait. Under B that wait
happens with a transaction open and a row locked — Postgres backends held open purely to
sleep.

### Why C fails R5

An advisory lock has no expiry. A worker that is alive but hung holds it indefinitely and
the message is stuck forever. No reaper can be written, because from the server's side a
live connection holding a lock is indistinguishable from healthy work. The brief requires
"the message must not stay stuck".

### Why no option avoids the idempotency key

R4 states that a *retry* must not cause a second send. A retry is a second HTTP call from
the same worker holding the same lock. A lock prevents a second **worker**; it does
nothing about a second **attempt**. The key is therefore mandatory under A, B and C alike,
which removes B's only real advantage.

## Decision

**Option A — lease / visibility timeout.**

It is the only option that satisfies R5, R6 and R7 at the same time. The reaper it
requires is a few lines of SQL. The duplicate send its zombie-worker case allows is
absorbed by the idempotency key, which every option needed anyway.

## Consequences

- `messages` gains `status`, `attempts`, `lease_until`, `worker_id`, `next_attempt_at`.
  See [[ADR-012-schema-and-indexes]].
- A reaper is required; its interval and the lease duration are set in
  [[ADR-007-lease-and-reaper]]. Lease duration bounds worst-case recovery time for R5/T3.
- The provider call happens with **no open transaction**. No worker may hold a transaction
  across network I/O; this is a hard rule for implementation.
- `attempts` is incremented at claim time, inside the claiming UPDATE, so a crash still
  burns an attempt and R4's cap of 5 cannot be bypassed by crashing. Confirmed in
  [[ADR-006-retry-policy]].
- Exactly-once is explicitly a **two-mechanism** property: the claim gives
  at-most-one-worker-at-a-time, the idempotency key gives at-most-one-send-per-message.
  This must be stated in the README (D3).

## Related

- [[ADR-000-acceptance-requirements]]
- [[ADR-001-database-engine]]
- [[ADR-004-idempotency-key]]
- [[ADR-007-lease-and-reaper]]
