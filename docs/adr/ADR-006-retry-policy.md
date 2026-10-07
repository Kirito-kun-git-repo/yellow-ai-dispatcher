---
adr: 6
title: Provider outcome mapping and attempt accounting
status: accepted
date: 2026-10-07
tags: [adr, cognify-ev, scheduled-dispatcher]
---

# ADR-006 — Provider outcome mapping and attempt accounting

**Status:** Accepted
**Date:** 2026-10-07

## Context

R4: the provider can return an error or time out. After a timeout it is unknown whether the
message was sent. Retry with backoff up to 5 attempts, then mark `FAILED`, and a retry must
not cause a second send.

Two coupled sub-decisions: where `attempts` is incremented, and what a timeout maps to.

## 6a — Where `attempts` increments

### Option A — inside the claiming `UPDATE`, at claim time
### Option B — after the provider replies, in the completion `UPDATE`

B is the intuitive reading ("count attempts that actually happened") and it is wrong. A
worker killed between claiming and replying never increments. The sweep re-claims the row,
that worker dies too, and the message retries forever: R4's cap of 5 becomes
unenforceable, and T3 can hang on a single unlucky row.

A also has the only defensible semantics after a timeout. The counter measures **delivery
attempts made**, not replies received — and after a timeout those cannot be told apart.

**Decision: A.** A crash burns an attempt. That is the correct price.

## 6b — What a timeout maps to

### Option A — treat it exactly like an error: retry with backoff, attempt counted
### Option B — mark `SENT` optimistically
### Option C — mark `FAILED` immediately

B encodes knowledge of our own mock into the service. P2 happens to say the mock sends on
timeout, but a real provider makes no such promise, and a timeout is equally likely to be a
network failure *before* the request landed — in which case the counts would report `SENT`
for a message nobody received. C loses messages and ignores R4.

A is correct, and for a stronger reason than "safe default": **the retry is how the true
outcome is discovered.** Attempt 2 sends the same key, the provider answers "already
accepted", and the row becomes `SENT` with the real result. The timeout's uncertainty is
resolved rather than guessed at. This is the payoff of [[ADR-004-idempotency-key]].

**Decision: A.**

## Outcome table

| Provider outcome | Transition |
|---|---|
| `2xx` accepted, first time for this key | `SENT` |
| `2xx` duplicate — "already accepted" | `SENT` |
| non-`2xx`, `attempts < 5` | `PENDING`, `next_attempt_at = now() + backoff` |
| non-`2xx`, `attempts = 5` | `FAILED` |
| timeout, `attempts < 5` | `PENDING`, `next_attempt_at = now() + backoff` |
| timeout, `attempts = 5` | `FAILED` |

All non-`2xx` responses are treated as retryable. The mock emits only random transient
errors, so there is no permanent-failure class to fail fast on. A production version would
treat `4xx` as terminal and skip the remaining attempts; noted in the README as a
deliberate simplification.

## T1 is not literally achievable — reformulated here

With the rates the brief specifies (20% errors, 10% timeouts) and a timeout meaning the
message *was* sent, a message is never accepted only if all five attempts return errors:

```
P(never accepted) = 0.2^5          = 0.00032
expected over 1,000 messages        = 0.32
P(at least one)   = 1 - (1-0.00032)^1000  ~= 27%
```

Roughly **one run in four** will contain a message the provider never accepted — correctly,
per R4, because it genuinely failed five times. A test asserting T1 literally ("the
provider accepted each message exactly one time") fails 27% of runs while the system
behaves exactly as specified.

T1's real invariant is three statements, all of which must hold on 100% of runs:

1. **No key appears more than once in `/stats`.** This is the exactly-once property. Any
   violation is a real bug.
2. **Every message in `SENT` appears exactly once** in `/stats`.
3. **`sent + failed + cancelled = total seeded`.** Nothing stuck, nothing lost.

And one that follows for free:

4. **Every `FAILED` message appears zero times** in `/stats` — it failed five times with
   errors, and an error means not accepted.

Assertion 4 holds only if the mock **checks the idempotency key before rolling its failure
dice**. If it rolls first, a retry of an already-accepted key can return `500`, the service
never learns the message was accepted, and the row can reach `FAILED` while the recipient
received the message. Real idempotent APIs replay the stored response first for exactly
this reason. Carried into [[ADR-013-mock-provider]] as a hard requirement.

## Consequences

- The claiming `UPDATE` carries `attempts = attempts + 1`; no other statement touches it.
- The claim predicate uses `attempts < 5`, so the cap is enforced by the query, not by
  application logic that a crash can skip.
- The provider client must return a three-way result — `accepted` / `rejected` / `unknown`
  — not a boolean. See [[ADR-002-language-and-runtime]].
- [[ADR-015-test-harness]] inherits the four assertions above verbatim; it must not assert
  T1 literally.
- The README (D3) must explain why T1 was reformulated, with the probability calculation.
  Silently weakening an acceptance criterion reads as a bug being hidden; showing the
  arithmetic reads as understanding the spec.
- Backoff shape and the attempt cap's interaction with timing are set in
  [[ADR-007-timing-and-backoff]].

## Related

- [[ADR-000-acceptance-requirements]]
- [[ADR-004-idempotency-key]]
- [[ADR-005-message-state-machine]]
- [[ADR-013-mock-provider]]
- [[ADR-015-test-harness]]
