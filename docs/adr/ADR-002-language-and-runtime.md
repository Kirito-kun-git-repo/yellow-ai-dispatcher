---
adr: 2
title: Language and runtime
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-002 — Language and runtime

**Status:** Accepted
**Date:** 2026-10-07

## Context

The brief allows any language. Language choice does not decide correctness here, but it
does decide three things that matter:

1. **Telling a provider timeout apart from a provider error.** Rule 4 depends on it. A
   `500` means the provider definitely did not send. A timeout means it may have sent.
   The two take different code paths, so the HTTP client must let us set the deadline and
   must surface a timeout as something distinguishable from a bad response.
2. **Workers must be separate OS processes.** The test kills one with `kill -9`. A thread
   or an async task is not killable that way.
3. **Raw SQL, no ORM.** The brief requires a hand-written schema. An ORM that owns the
   schema, or that rewrites `FOR UPDATE SKIP LOCKED`, is a liability.

## Options

### A. Node 22 + TypeScript — `pg`, raw SQL, `fetch` with `AbortSignal.timeout()`
Fastest to write. Timeout handling is explicit: `AbortSignal.timeout(ms)` raises a
`TimeoutError`, caught separately from a non-2xx response. Express covers the three
endpoints in a few lines.

- Trap: a timeout and a `500` land in the same `catch` unless the code branches on
  `err.name === 'TimeoutError'` versus `res.ok`.
- Trap: the `pg` pool keeps the process alive, so a worker needs a real shutdown path for
  graceful stop (not needed for `kill -9`).

### B. Go 1.23 — `pgx`, `context.WithTimeout`
Best fit for the problem shape. `context.DeadlineExceeded` is unambiguous, `pgx` gives
real pool control, and compiled binaries make launching one API, two workers and the mock
provider trivial in a test script.

- Trap: slower to write without existing fluency, and the round is time-boxed.

### C. Python 3.12 + asyncio — `psycopg3`, `httpx`
`httpx.TimeoutException` versus `httpx.HTTPStatusError` is a clean split, and `psycopg3`
handles `SKIP LOCKED` fine.

- Trap: asyncio plus pooling plus signal handling takes time away from the claim logic.

## Decision

**Option A — Node 22 + TypeScript**, with the `pg` driver and hand-written SQL. No ORM, no
query builder, no migration framework that generates schema.

The round is graded on the exactly-once claim, the lease and the rate limiter. The right
language is the one where time goes into those instead of into plumbing.

## Consequences

- The provider client must branch explicitly on three outcomes: `2xx` (sent), non-2xx
  (definitely not sent), timeout (unknown). See [[ADR-00x-retry-and-failure-handling]].
- Every provider call sets `AbortSignal.timeout(...)`; no call is allowed to run without a
  deadline, or a hung provider holds a worker forever.
- API process and worker processes are separate entry points (`api.ts`, `worker.ts`), each
  started as its own OS process so `kill -9` is meaningful.
- Schema lives in a plain `schema.sql` applied at startup or by the compose setup.
- `pg.Pool` is configured with an explicit `max`, so a slow provider cannot exhaust
  connections.

## Requirements traceability

| ID | How this decision serves it |
|----|------------------------------|
| **R4** | `AbortSignal.timeout()` surfaces a timeout as a distinct `TimeoutError`, so the three provider outcomes (sent / definitely-not-sent / unknown) stay separable in code |
| **R5** | API and workers are separate OS process entry points, so `kill -9` on a worker is meaningful |
| **D1** | No ORM, so the schema stays hand-written and `FOR UPDATE SKIP LOCKED` is not rewritten |
| **D2** | Separate entry points make it easy to launch 1 API + 2 workers + the mock provider from one test script |
| **P1-P3** | The mock provider is a small Express app in the same repo and language |

## Related

- [[ADR-000-acceptance-requirements]]

- [[ADR-001-database-engine]]
- [[ADR-003-claim-model]]
