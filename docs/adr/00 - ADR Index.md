---
title: ADR Index — Scheduled notification dispatcher
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher, index]
---

# ADR Index

These decisions are **binding**. Implementation follows them; it does not re-litigate them.
Every acceptance ID in [[ADR-000-acceptance-requirements]] must be closed by at least one
ADR below. An ADR that closes no requirement is out of scope.

## Status

| ADR | Decision | Closes | Status |
|-----|----------|--------|--------|
| [[ADR-000-acceptance-requirements]] | Acceptance baseline | — | baseline |
| [[ADR-001-database-engine]] | PostgreSQL 16, READ COMMITTED | R1 R2 R5 R7 D1 | ✅ accepted |
| [[ADR-002-language-and-runtime]] | Node 22 + TypeScript, `pg`, no ORM | R4 R5 D1 D2 P1-P3 | ✅ accepted |
| [[ADR-003-claim-model]] | Lease / visibility timeout | R1 R5 R7 T3 | ✅ accepted |
| [[ADR-004-idempotency-key]] | Natural key `campaign_id:user_id` | R1 R4 T1 | ✅ accepted |
| [[ADR-005-message-state-machine]] | Sweep folded into claim query, no reaper process | R3 R4 R7 | ✅ accepted |
| [[ADR-006-retry-policy]] | Increment at claim; timeout retries like an error | R4 | ✅ accepted |
| [[ADR-007-timing-and-backoff]] | Balanced: 2s timeout, 15s lease, full jitter | R5 R6 T3 | ✅ accepted |
| [[ADR-008-clock-source]] | Database clock only; `timestamptz` everywhere | R2 T2 | ✅ accepted |
| [[ADR-009-rate-limiter]] | GCRA next-slot in Postgres, gated at send | R6 T4 | ✅ accepted |
| ADR-010 | Counts computation | R7 A3 | ⬜ open |
| ADR-011 | Cancel semantics | R3 A2 | ⬜ open |
| ADR-012 | Schema and indexes | D1 A1 | ⬜ open |
| ADR-013 | Mock provider design | P1 P2 P3 | ⬜ open |
| ADR-014 | Polling strategy, batch size, fairness | R6 R7 | ⬜ open |
| ADR-015 | Test harness and proofs | D2 T1-T4 | ⬜ blocked on most |
| ADR-016 | README and the cut list | D3 | ⬜ last |

## Requirement coverage

| Req | Closed by |
|-----|-----------|
| **R1** exactly one send | 001, 003, 004 |
| **R2** no early send | 001, 008 |
| **R3** cancel | 005, 011 |
| **R4** provider failures | 002, 004, 006 |
| **R5** worker crash | 001, 002, 003, 007 |
| **R6** rate limit | 009, 014 |
| **R7** counts | 003, 005, 010 |
| **A1-A3** API | 010, 011, 012 |
| **P1-P3** mock provider | 013 |
| **D1** schema | 001, 002, 012 |
| **D2/T1-T4** test | 015 |
| **D3** README | 016 |

No requirement is uncovered. No ADR is decorative.
