---
adr: 5
title: Message state machine
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-005 — Message state machine

**Status:** Accepted
**Date:** 2026-10-07

## Context

A3 fixes the five count buckets: `pending, in_progress, sent, failed, cancelled`, so the
set of states is given. Two things are not: what a message's state is **between attempts**,
and whether the lease sweep required by [[ADR-003-claim-model]] is a separate process or
part of the claim query itself.

## Options

### A. Retry returns the row to `PENDING`; a separate reaper process resets expired leases

```
PENDING ──claim──> IN_PROGRESS ──2xx──> SENT
   ^                    |
   |                    +-- failure, attempts < 5 --> PENDING (next_attempt_at = now()+backoff)
   |                    +-- attempts = 5 ----------> FAILED
   +---- reaper: UPDATE ... WHERE status='IN_PROGRESS' AND lease_until < now()
```

- Cost: a second background loop to write, run and test.
- Cost: worst-case recovery is lease duration **plus** reaper interval.

### B. Same transitions, no reaper process — the claim query sweeps expired leases

```sql
WHERE send_at <= now()
  AND next_attempt_at <= now()
  AND attempts < 5
  AND ( status = 'PENDING'
        OR (status = 'IN_PROGRESS' AND lease_until < now()) )
```

A crashed worker's row is picked up by the next poll of any worker.

- Cost: the `OR` requires a partial index `ON messages (send_at) WHERE status IN
  ('PENDING','IN_PROGRESS')` to stay a cheap scan over non-terminal rows. Terminal rows
  leave the index as they finish, so it stays small.

### C. SQS-style — the row never leaves `IN_PROGRESS`; backoff extends `lease_until`

Crash recovery and retry backoff become one mechanism: a message is invisible until
`lease_until`.

- Cost: `IN_PROGRESS` stops meaning "a worker owns this" and starts meaning "not claimable
  right now". A message in a 16-second backoff is reported as `in_progress` while nothing
  is touching it.
- Cost: a crashed worker and a backing-off worker become indistinguishable, in the status
  endpoint and in debugging.

## Scoring

| | A reaper process | B sweep in claim | C SQS-style |
|---|---|---|---|
| **R4** attempts capped at 5 | ✅ | ✅ | ✅ |
| **R5/T3** crash recovery | ✅ lease + reaper interval | ✅ lease only | ✅ lease only |
| **R7** `in_progress` is meaningful | ✅ | ✅ | ❌ conflates waiting with working |
| **R2** `send_at` stays explicit and immutable | ✅ | ✅ | ⚠️ invites folding into `lease_until` |
| Moving parts | 2 loops | **1 loop** | 1 loop |

## Decision

**Option B.**

C is the more elegant queue design and would be the right call for a general-purpose
queue, but it costs R7: the brief requires counts to be correct at all times, and under C
the `in_progress` bucket no longer means "being delivered right now".

A is correct but adds a background loop that can be misconfigured or left unstarted, and
its interval adds to worst-case recovery time in T3 for no gain.

B keeps A's semantics — `PENDING` = unowned, `IN_PROGRESS` = a worker holds a live lease —
and removes the extra process. Recovery is bounded by the lease alone.

Keeping `send_at <= now()` as a literal, immutable predicate matters: R2 is a priority-1
requirement, and under A or B a reviewer can be pointed at that one line. Under C the
argument becomes that a mutable `visible_at` was initialized correctly and never moved
backwards.

## State table

| From | Trigger | To |
|------|---------|-----|
| `PENDING` | claim query matches (`send_at <= now()`, `next_attempt_at <= now()`, `attempts < 5`) | `IN_PROGRESS` |
| `IN_PROGRESS` | lease expired, campaign active | `IN_PROGRESS` (re-claimed by another worker) |
| `IN_PROGRESS` | lease expired, campaign cancelled | `CANCELLED` |
| `IN_PROGRESS` | provider accepted | `SENT` |
| `IN_PROGRESS` | provider failed, `attempts < 5` | `PENDING` with `next_attempt_at` |
| `IN_PROGRESS` | provider failed, `attempts = 5` | `FAILED` |
| `PENDING` | campaign cancelled | `CANCELLED` |

`SENT`, `FAILED` and `CANCELLED` are terminal.

## Consequences

- No reaper process exists. Crash recovery is a property of the claim query, which every
  worker runs. This must be stated in the README (D3) — a reviewer will look for a reaper.
- Worst-case recovery time for T3 equals the lease duration. Set in
  [[ADR-007-lease-and-reaper]].
- **Required, not optional:** the sweep must not *skip* rows whose campaign is cancelled —
  it must transition them to `CANCELLED`. Otherwise a message that was `IN_PROGRESS` when
  its campaign was cancelled, whose worker then crashed, stays `IN_PROGRESS` forever and
  T3 ("all messages still finish") hangs. Carried into [[ADR-011-cancel-semantics]].
- Schema needs `next_attempt_at` and `lease_until` as separate columns, and the partial
  index above. Carried into [[ADR-012-schema-and-indexes]].

## Related

- [[ADR-000-acceptance-requirements]]
- [[ADR-003-claim-model]]
- [[ADR-006-retry-policy]]
- [[ADR-011-cancel-semantics]]
