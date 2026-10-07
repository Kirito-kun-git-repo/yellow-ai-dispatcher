---
adr: 4
title: Idempotency key derivation
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-004 — Idempotency key derivation

**Status:** Accepted
**Date:** 2026-10-07

## Context

Per [[ADR-003-claim-model]], the database claim gives at-most-one-worker-at-a-time. It does
**not** give exactly-once. R4 requires that a retry never causes a second send, and a retry
is a second HTTP call from the same worker — no lock prevents it. The provider's
`Idempotency-Key` is the mechanism that delivers exactly-once (R1), and its derivation
decides whether R4 holds and how T1 is proven.

## Options

### A. Natural key — `${campaign_id}:${user_id}`
Deterministic. Identical on attempt 1 and attempt 5, identical across workers, identical
after a lease handoff and after a full restart.

### B. Surrogate — the message row primary key, e.g. `msg:${message_id}`
Also deterministic and stable. Shorter, and leaks no tenant or user identifiers.

### C. A fresh UUID per attempt
Breaks R4 by construction. After a timeout the provider has already sent and recorded the
old key; a new key is unseen, so it sends again. Recorded only to document the rejection.

### D. A UUID generated once at claim time and persisted in an `idempotency_key` column
Stable — written in the same `UPDATE` that claims the row, so there is no window between
generating and persisting. Costs a column and a write.

## Scoring

| | A natural | B message id | C per attempt | D stored UUID |
|---|---|---|---|---|
| **R4** retry ≠ second send | ✅ | ✅ | ❌ | ✅ |
| Stable across lease handoff | ✅ | ✅ | ❌ | ✅ |
| **T1** proof independent of the system under test | ✅ | ❌ | ❌ | ❌ |
| No PII in provider headers | ❌ | ✅ | ✅ | ✅ |
| Extra schema cost | none | none | none | one column |

### Why the T1 row decides it

T1 requires proving the provider accepted each of 1,000 messages exactly once. Under A the
test computes the expected key set from **the seed data it generated itself** — 1,000
`(campaign_id, user_id)` pairs — then calls `GET /stats` and asserts the returned keys are
exactly that set, each with count 1. The test never reads the `messages` table.

Under B or D the test must query the database to learn which keys to expect, which makes
the oracle derived from the system under test. A bug that inserted a duplicate message row
would produce two ids, two expected keys, two accepted sends — and the test would pass
while one recipient received the same message twice.

## Decision

**Option A — `${campaign_id}:${user_id}`.**

## Consequences

- **`messages` requires `UNIQUE (campaign_id, user_id)`**, and `POST /campaigns` must
  dedupe the `recipients` array before insert. Without it two rows share one key: the
  provider correctly sends once, but the counts report two messages for one recipient.
  The constraint is R1's own wording — *"each (campaign_id, user_id) message"* — expressed
  in the schema. Carried into [[ADR-012-schema-and-indexes]].
- The key is computed, never stored. No extra column, no crash window.
- The key is derived identically by the worker and by the test harness, which is what makes
  the T1 assertion independent.
- Tenant and user ids travel in an HTTP header and appear in the provider's `/stats`
  output. Accepted here because the provider is ours and the traceability helps T1. In
  production the key would be `sha256(campaign_id:user_id)`, which keeps every property
  above and removes the PII. To be stated in the README (D3).
- The provider must treat the key as the full dedupe identity: same key → recorded once,
  replayed response. Carried into [[ADR-013-mock-provider]].

## Related

- [[ADR-000-acceptance-requirements]]
- [[ADR-003-claim-model]]
- [[ADR-013-mock-provider]]
