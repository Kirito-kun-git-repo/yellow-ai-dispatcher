---
adr: 8
title: Clock source for the send_at comparison
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-008 — Clock source

**Status:** Accepted
**Date:** 2026-10-07

## Context

R2: the service never sends a message before `send_at`. T2 proves it from provider
timestamps.

This looks trivial but **three clocks are involved**:

1. The **API process** sets `send_at` when `POST /campaigns` lands.
2. Something decides whether a message is due — the worker, or the database.
3. The **mock provider** stamps the timestamp T2 reads from `GET /stats`.

T2 compares clock 3's output against clock 1's value, based on a decision made by clock 2.
If any two disagree, T2 fails on a correct system, or passes on a broken one.

## Options

### A. The database clock — `now()` evaluated by Postgres inside the claim predicate
```sql
WHERE send_at <= now() AND next_attempt_at <= now() AND ...
```
Workers hold no opinion about what time it is.

### B. The worker clock — `new Date()` bound as a parameter: `WHERE send_at <= $1`

### C. The worker clock, with a startup skew check against the database

## Why B is a defect, not a preference

Two workers are two processes, possibly two containers or two hosts, and their clocks drift
independently. A worker running 3 seconds fast claims and sends 3 seconds before `send_at`
— a direct R2 violation caused by nothing in the code.

It is also invisible: the message goes out, the status shows `sent`, and only T2 catches
it, and only if the provider's clock happens to agree with the API's.

It fails asymmetrically as well. The fast worker wins every race for due messages, so it
takes a disproportionate share of the work and does the most early sending.

C detects skew without removing it — there are still N clocks, now with a startup check
that passes and then drifts. It also adds an abort-on-skew failure mode to solve a problem
A does not have.

## Decision

**Option A — the database clock.**

The argument for R2 reduces to one sentence a reviewer can be pointed at: *only Postgres
decides what time it is, and `send_at` is immutable.* No clock-dependent logic exists in
the worker's send path.

## Three details this still requires

### 1. `timestamptz`, never `timestamp`
A naive `timestamp` carries no timezone, so its meaning depends on the session's `TimeZone`.
An API process in IST writing `18:00` and a worker session in UTC reading it is a
five-and-a-half-hour R2 violation. `send_at`, `next_attempt_at` and `lease_until` are all
`timestamptz`, and every connection sets `SET TIME ZONE 'UTC'`.

### 2. `POST /campaigns` rejects a `send_at` with no offset
The client supplies this value. A bare `"2026-10-07T18:00:00"` is interpreted in the
session timezone. The API requires ISO-8601 with an explicit offset or `Z` and returns
`400` otherwise. Input validation doing R2's job.

### 3. `now()` is transaction start time
Postgres `now()` is `transaction_timestamp()`, not current time. Inside the claim
transaction that is sub-millisecond and in fact preferable — every row in one claim batch is
evaluated against the same instant.

It matters elsewhere: if a rate-limiter update runs inside a longer transaction, `now()` is
stale and the limiter mis-computes. The limiter must run in its own short transaction and
use `clock_timestamp()`. Carried into [[ADR-009-rate-limiter]].

## Consequences

- No worker code calls `Date.now()` in the send path. Timing decisions are SQL predicates.
- `schema.sql` declares all time columns `timestamptz`. Carried into
  [[ADR-012-schema-and-indexes]].
- The API validates `send_at` format before insert.
- T2's assertion is `provider_timestamp >= send_at`, comparing the provider's clock to a
  value the API wrote. Under Docker Compose all containers share the host kernel clock, so
  skew is zero and the assertion is sound. **This assumption is stated in the README (D3)**
  rather than relied on silently: against a third-party provider on a different clock, T2's
  style of proof would need a tolerance window.

## Related

- [[ADR-001-database-engine]]
- [[ADR-005-message-state-machine]]
- [[ADR-009-rate-limiter]]
- [[ADR-012-schema-and-indexes]]
