---
adr: 7
title: Timing constants and backoff shape
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-007 — Timing constants and backoff shape

**Status:** Accepted
**Date:** 2026-10-07

## Context

[[ADR-005-message-state-machine]] makes worst-case crash recovery equal to the lease
duration plus one poll interval, which is what T3 measures. [[ADR-006-retry-policy]] needs
a backoff shape. These numbers are coupled and must be chosen together.

**The hard constraint:** `LEASE_DURATION` must comfortably exceed `PROVIDER_TIMEOUT`. If it
does not, a healthy worker's lease expires while it is still waiting on the provider,
another worker claims the row, and a duplicate provider call happens on **every** timeout —
not as an edge case but as the normal path. Correctness survives via
[[ADR-004-idempotency-key]], but attempts are burned for nothing.

## Options

| | A conservative | B balanced | C aggressive |
|---|---|---|---|
| `PROVIDER_TIMEOUT` | 5s | **2s** | 1s |
| `LEASE_DURATION` | 60s | **15s** | 5s |
| lease / timeout headroom | 12x | **7.5x** | 5x |
| `POLL_INTERVAL` (idle) | 1s | **250ms** | 100ms |
| backoff base x factor | 1s x 2^n | **500ms x 2^n** | 200ms x 2^n |
| backoff cap | 30s | **8s** | 2s |
| jitter | none | **full** | full |
| **T3 worst-case recovery** | ~61s | **~15.3s** | ~5.1s |

### Why not A

T3 requires killing a worker and proving all messages still finish. Under A that proof
takes a minute of wall clock, during which "recovering" is indistinguishable from "hung" to
anyone watching the run. Recovery time should be small enough to be visibly bounded.

### Why not C

5x headroom is fine until a GC pause, a slow connection checkout or container CPU
throttling costs four seconds. A live worker's lease then expires, another worker takes the
row, and both call the provider. Correctness holds, but `attempts` inflates and a row that
reaches five inflated attempts is marked `FAILED` for a message that never actually failed.
A bug produced purely by tuning.

### Why full jitter is not just a number

About 30% of 1,000 attempts fail, so roughly 300 retries are scheduled. Without jitter they
land at the same instants (`now+500ms`, `now+1s`, `now+2s`) and arrive as spikes that
collide with the per-tenant rate limiter in R6, which queues them and re-synchronizes them
further. Full jitter spreads them flat:

```
delay = random(0, min(CAP, BASE * 2^(attempts-1)))
```

## Decision

**Option B.**

```
PROVIDER_TIMEOUT_MS = 2000
LEASE_SECONDS       = 15
POLL_INTERVAL_MS    = 250     # only when the last claim returned nothing
BACKOFF_BASE_MS     = 500
BACKOFF_FACTOR      = 2
BACKOFF_CAP_MS      = 8000
BACKOFF_JITTER      = full
MAX_ATTEMPTS        = 5
```

Backoff windows (full jitter draws uniformly from each):

| After attempt | Window | Worst case |
|---|---|---|
| 1 | 0 – 500ms | 500ms |
| 2 | 0 – 1s | 1s |
| 3 | 0 – 2s | 2s |
| 4 | 0 – 4s | 4s |
| 5 | — | `FAILED` |

Worst-case total backoff 7.5s, expected 3.75s. Plus up to 5 x 2s of provider time, so a
worst-case message lifetime of roughly 17.5s excluding rate-limit queueing.

A worker sleeps `POLL_INTERVAL_MS` only when its last claim returned zero rows. A full
batch loops immediately.

## Two interactions that constrain other ADRs

### 1. The lease must cover the whole batch, not one provider call

If a worker claims 50 messages under one `lease_until` and the tenant limit is 10/s, that
batch takes 5 seconds to drain — the lease is consumed by rate-limit waiting, not by
provider calls. Claiming 500 at 10/s needs 50 seconds against a 15-second lease: leases
expire while the worker still holds the batch, other workers steal the tail, and every
stolen row is a wasted duplicate call. The real constraint is:

```
LEASE_DURATION >= max( 3 * PROVIDER_TIMEOUT , BATCH_SIZE / N_per_sec * safety )
```

Batch size is therefore a timing decision, not a throughput knob. Carried into
[[ADR-014-polling-and-batch-size]].

### 2. The rate limit floors the test runtime

1,000 messages in a single tenant at N sends/sec cannot finish faster than `1000 / N`
seconds. At N=10 that is a 100-second minimum; at N=50, 20 seconds. Either the test seeds
across several tenants or N is set high enough. Carried into
[[ADR-009-rate-limiter]] and [[ADR-015-test-harness]].

## Consequences

- All eight values live in one config module and are read from environment variables, so
  the test harness can shorten them without editing code.
- The invariant `LEASE_DURATION >= 3 * PROVIDER_TIMEOUT` is asserted at startup. A
  misconfiguration that violates it fails loudly rather than producing duplicate calls.
- T3's assertion is stated as "all messages reach a terminal state within
  `LEASE_SECONDS + POLL_INTERVAL + slack`", a concrete bound rather than an open-ended wait.
- README (D3) states the recovery bound and where it comes from.

## Related

- [[ADR-005-message-state-machine]]
- [[ADR-006-retry-policy]]
- [[ADR-009-rate-limiter]]
- [[ADR-014-polling-and-batch-size]]
