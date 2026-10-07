---
adr: 0
title: Acceptance requirements (traceability baseline)
status: baseline
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher, requirements]
---

# ADR-000 — Acceptance requirements

**Status:** Baseline — not a decision. This is the checklist every other ADR traces to.

Extracted verbatim in intent from [[req]]. Every ADR must name the IDs it satisfies and
how that is proven. A decision that satisfies nothing here is out of scope and gets cut.

## Functional rules

| ID | Requirement | Proven by |
|----|-------------|-----------|
| **R1** | Exactly one send per `(campaign_id, user_id)`, holding when 2+ workers poll the same database | T1 |
| **R2** | No message sent before its `send_at` | T2 |
| **R3** | Cancel stops further sends; messages already in progress still report their true result; a second cancel is a no-op | manual + unit |
| **R4** | Provider error or timeout → retry with backoff, max 5 attempts, then `FAILED`. A retry must not cause a second send | T1 (under induced failure) |
| **R5** | Worker can die at any point, including after claiming. Another worker finishes the message. Not stuck, not sent twice | T3 |
| **R6** | Per-tenant limit of N sends/sec, enforced across all workers together, not per process | T4 |
| **R7** | `GET /campaigns/:id` counts are correct **at all times**, not eventually correct | manual + unit |

## API surface

| ID | Endpoint |
|----|----------|
| **A1** | `POST /campaigns` — `{ tenant_id, channel, send_at, recipients: [user_id, ...] }` (seed data) |
| **A2** | `POST /campaigns/:id/cancel` |
| **A3** | `GET /campaigns/:id` → `{ status, counts: { pending, in_progress, sent, failed, cancelled } }` |

## Mock provider (we build it)

| ID | Requirement |
|----|-------------|
| **P1** | `POST /send` with an `Idempotency-Key` header. Sends once per key. Records every accepted send with a timestamp |
| **P2** | Fails at random: 20% errors, 10% timeouts. On a timeout it **does** send but never replies |
| **P3** | `GET /stats` → accepted sends per key, with timestamps |

## Deliverables

| ID | Deliverable |
|----|-------------|
| **D1** | Hand-written `schema.sql`. No framework-generated schema |
| **D2** | A test running 1 API process + 2 worker processes + the mock provider against one database |
| **D3** | README: how to run it, and how each rule was verified |

### The test must prove (D2)

| ID | Proof |
|----|-------|
| **T1** | Seed 1,000 messages; the provider accepted each one exactly once |
| **T2** | No send happened before `send_at` |
| **T3** | Kill one worker mid-run; all messages still finish |
| **T4** | From provider timestamps, no tenant exceeded N sends in any one-second window |

## Priority (stated in the brief)

1. The exactly-once claim across two workers — **R1, R2**
2. Crash recovery and safe retries — **R4, R5**
3. Everything else. Say what was cut and why.

## Note on where exactly-once actually comes from

R1 is not satisfied by the database alone. The database claim gives
**at-most-one-worker-at-a-time**. The provider's `Idempotency-Key` gives
**at-most-one-send-per-message**. Both are required; neither is sufficient. Every ADR
below is written with that split in mind.
