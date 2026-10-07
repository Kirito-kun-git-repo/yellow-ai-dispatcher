---
adr: 1
title: Database engine
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-001 — Database engine

**Status:** Accepted
**Date:** 2026-10-07

## Context

Workers poll a `messages` table to find rows that are due, and claim them. Multiple
worker processes run against the same database, so the claim query is the hot path and
the place where correctness is decided.

The query each worker runs:

```sql
SELECT id FROM messages
WHERE status = 'PENDING' AND send_at <= now()
ORDER BY send_at
LIMIT 50
FOR UPDATE SKIP LOCKED;
```

How the engine locks during this range scan decides whether two workers run in parallel
or block each other. The brief allows MySQL 8 or PostgreSQL.

## Options

### A. PostgreSQL 16, READ COMMITTED (default)
`FOR UPDATE SKIP LOCKED` skips rows another worker already holds. READ COMMITTED takes
no range locks, so two workers scanning the same index never block each other.
A partial index `ON messages (send_at) WHERE status = 'PENDING'` keeps the scan over due
rows only, and the index shrinks as rows leave PENDING.

- Cost: none that matters at this scale.

### B. MySQL 8, isolation forced to READ COMMITTED
`SKIP LOCKED` works. READ COMMITTED turns off gap locking, so behaviour is close to A.
But the isolation level must be set on every connection; miss it in one place and you
silently get option C. MySQL has no partial indexes, so the index covers every row
including `SENT` ones and grows without bound.

- Cost: a setting that must never be missed; a fatter index.

### C. MySQL 8 on its default REPEATABLE READ
InnoDB takes **gap locks** over the range the scan touches — the empty space between
index entries, not just the rows. `SKIP LOCKED` skips *locked rows*; it does not skip
*gaps*. Worker 1 locks gaps across `send_at <= now()`, and worker 2 blocks on a gap
covering rows worker 1 never claimed. Workers serialize on each other, and under load
this deadlocks.

Results stay correct, which makes it worse: the test passes, and the contention only
appears on a busier machine.

- Cost: contention and deadlocks that are hard to see in a short test run.

## Decision

**Option A — PostgreSQL 16, READ COMMITTED.**

`SKIP LOCKED` + READ COMMITTED + a partial index is the standard, well-understood way to
use a SQL table as a work queue. Each of the three pieces can be justified in one
sentence in the README.

## Consequences

- Isolation stays at the Postgres default; no per-connection isolation setting to manage.
- Schema gets a partial index `(send_at) WHERE status = 'PENDING'` for the due-query, and
  an index on `(campaign_id, status)` for the counts query (see [[ADR-00x-counts]]).
- Local setup ships as Docker Compose with a single `postgres:16` service.
- Timestamps use `timestamptz`, and "now" is read from the database, not the worker
  process — see the clock-source ADR.
- If this ever had to run on MySQL, the claim query would need READ COMMITTED enforced at
  connection setup, and the partial index would become a full index.

## Requirements traceability

| ID | How this decision serves it |
|----|------------------------------|
| **R1** | `FOR UPDATE SKIP LOCKED` under READ COMMITTED lets two workers claim disjoint row sets with no gap locks, so no worker ever claims a row another already holds |
| **R2** | `send_at <= now()` is evaluated by the database, and the partial index `(send_at) WHERE status='PENDING'` makes that predicate the index condition, not a post-filter |
| **R5** | Row locks are released by the server when a crashed worker's connection drops; no external coordinator needed |
| **R7** | Index on `(campaign_id, status)` makes the counts aggregate a single consistent snapshot read |
| **D1** | Postgres DDL is written by hand into `schema.sql` |

## Related

- [[ADR-000-acceptance-requirements]]

- [[ADR-002-language-and-runtime]]
- [[ADR-003-claim-model]]
