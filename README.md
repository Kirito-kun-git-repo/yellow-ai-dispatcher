# Scheduled notification dispatcher

Sends scheduled notifications (SMS / WhatsApp / email) for marketing campaigns. An API
seeds campaigns; worker processes find messages that are due and push them through a
provider. Multiple workers run against one database.

Postgres 16, Node 22+ with TypeScript, no ORM, hand-written schema.

---

## Status

Honest state of the deliverables, so nothing here reads as more finished than it is.

| Deliverable | State |
| --- | --- |
| `schema.sql`, hand-written (**D1**) | ✅ done, every constraint exercised against a live database |
| `POST /campaigns`, `POST /campaigns/:id/cancel`, `GET /campaigns/:id` (**A1–A3**) | ✅ done |
| Mock provider (**P1–P3**) | ✅ done |
| Worker: claim, lease, rate limit, retry, sweep (**R1–R6**) | ✅ done |
| Postman collection, 22 requests with assertions | ✅ done, green under Newman |
| Automated test harness (**D2 / T1–T4**) | ⬜ **not built yet** — the rules below are verified, but by the methods described, not yet by one scripted run |
| ADRs 010–016 | ⬜ open (counts, cancel, schema, provider, polling, test harness, cut list) |

---

## Run it

Needs Docker and Node 22.6+ (Node runs the TypeScript directly — no build step).

```bash
cp .env.example .env
docker compose up -d          # Postgres 16 on host port 5433
npm install
db/apply.sh --reset           # applies schema.sql
scripts/stack.sh up 2         # provider + api + 2 workers
```

`scripts/stack.sh status` shows what is up, `scripts/stack.sh down` stops it. Logs land in
`.run/logs/`.

Then:

```bash
curl -X POST localhost:3100/campaigns \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"acme","channel":"SMS","send_at":"2026-12-01T10:00:00Z",
       "recipients":["u1","u2","u3"]}'

curl localhost:3100/campaigns/1
```

**The API is on 3100, not 3000.** Port 3000 collides with other local services often enough
that a stray service there will answer a health check and look like a pass. `GET /health`
returns `{"process":"api"}` so you can tell whose answer you got.

### Postman

`postman/dispatcher.postman_collection.json` — 22 requests across 5 folders, each asserting
the rule it demonstrates. Import it with `postman/dispatcher.postman_environment.json`.

```bash
npx newman run postman/dispatcher.postman_collection.json \
  -e postman/dispatcher.postman_environment.json
```

Folder 2 needs the workers running; folders 0, 1, 3 and 4 do not. Folder 3 is cleanest with
`PROVIDER_ERROR_RATE=0 PROVIDER_TIMEOUT_RATE=0`.

The two Claude Code sessions this was built in are in
[`docs/transcripts/`](docs/transcripts/) — the design argument in one window, the build in
the other, including the points where they disagreed.

There is also a walkthrough of the call order and what each endpoint does:
[Dispatcher API — Call Order and What Each Endpoint Does](https://claude.ai/code/artifact/0cf908bb-ceb1-4002-b9a2-27d50d6dc31f).

---

## How exactly-once actually works

It is **two mechanisms**, and neither is sufficient alone. This is the single most important
thing to understand about the design.

1. **The database claim** gives *at most one worker at a time*.
   `FOR UPDATE SKIP LOCKED` under READ COMMITTED, with a lease.
2. **The provider idempotency key** gives *at most one send per message*.
   The key is `campaign_id:user_id`, computed, never stored.

The claim stops a second *worker*. It does nothing about a second *attempt* — and a retry is
by definition a second HTTP call from the same worker holding the same lock. Rule 4 requires
that retry not cause a second send, so the key is mandatory no matter which claim model you
pick. That is why there is no claim design in which the key is optional.

### The claim query

```sql
UPDATE messages m
   SET status = 'IN_PROGRESS',
       lease_until = now() + make_interval(secs => $2::numeric / 1000),
       worker_id = $1,
       attempts = m.attempts + 1,
       updated_at = now()
 WHERE m.id IN (
         SELECT id FROM messages
          WHERE send_at         <= now()
            AND next_attempt_at <= now()
            AND attempts < 5
            AND ( status = 'PENDING'
               OR (status = 'IN_PROGRESS' AND lease_until < now()) )
          ORDER BY send_at
          LIMIT $3
          FOR UPDATE SKIP LOCKED )
RETURNING m.*;
```

Five things are load-bearing here:

- `SKIP LOCKED` — two workers scanning the same index take disjoint rows instead of blocking.
- **READ COMMITTED** (the Postgres default) — no range locks, so there are no *gaps* for a
  second worker to block on. On MySQL's default REPEATABLE READ this same query deadlocks
  under load while still returning correct results, which is worse: the test passes and the
  contention only appears on a busier machine.
- `send_at <= now()` — rule 2, evaluated by the database against the database's clock.
- `attempts = attempts + 1` **inside the claim** — a worker killed between claiming and
  replying still burns an attempt, so the cap of 5 cannot be bypassed by crashing.
- `OR (status = 'IN_PROGRESS' AND lease_until < now())` — crash recovery, folded into the
  claim every worker already runs.

### There is no reaper process

Look for one; there isn't one. Recovery for a dead worker's messages is a property of the
claim query itself, so worst-case recovery time is the lease (15s) rather than the lease
plus some background loop's interval.

One sweep statement does run before each claim, for the two cases a re-claim cannot fix:
a message whose campaign was cancelled while it was in flight, and a message whose lease
expired with `attempts` already at the cap. Without that second case a message killed on its
fifth attempt sits `IN_PROGRESS` forever — invisible to `attempts < 5` — which is exactly the
"must not stay stuck" failure, and it would hang T3 on an unlucky run.

---

## How each rule was verified

| Rule | How |
| --- | --- |
| **R1** exactly one send | Two concurrent psql sessions ran the claim query while the first held its rows open. Worker A took ids 1–50, worker B took 51–100: intersection 0, union 100. End to end, `/stats` reports `total_accepted == distinct_keys_accepted` on every run, and the accepted log is an **array**, so a duplicate could physically be recorded. |
| **R2** no early send | `send_at` is immutable and compared only by the database (`now()`, never a worker's clock). `POST /campaigns` rejects any `send_at` without an explicit offset or `Z` — a naive `2026-12-01T10:00:00` would be read in the process's local zone, which in IST silently stores it 5½ hours early. Verified: naive → 400, `Z` → 201, `+05:30` → 201. |
| **R3** cancel | `PENDING` messages are cancelled in the same transaction as the campaign. `IN_PROGRESS` ones are left to report their true result. Second cancel: `already_cancelled: true`, 0 messages touched. Observed a cancelled campaign settle at `sent: 38, failed: 4, cancelled: 158` — a non-zero `sent` on a cancelled campaign is the rule working. |
| **R4** provider failures | The client returns a three-way outcome (`accepted` / `rejected` / `unknown`), never a boolean. Timeout maps to retry, not to `SENT`. Over a 300-message run at 90% error: 175 `FAILED` all with `HTTP 500`, 25 `FAILED` all with `timeout`. |
| **R5** worker crash | Lease + sweep. Not yet exercised with an actual `kill -9` — that is T3, in the unbuilt harness. |
| **R6** rate limit | GCRA: one row per tenant holding `next_slot_at`, advanced by `k / rate_per_sec` seconds per reservation in a single atomic `UPDATE`. The limit is global across workers because they already share that row. Verified two sequential reservations: worker B's first slot landed exactly where worker A's reservation ended, spacing 0.02s = 1/50. |
| **R7** counts | One `GROUP BY`, therefore one MVCC snapshot — correct at the instant read, not eventually. No counter columns, so there is nothing to drift. |

### Why a fixed-window rate limiter would fail T4

T4 asserts no tenant exceeded N in **any** one-second window. A counter keyed on the current
second allows N sends at t=0.99 and N more at t=1.01 — 2N inside a real one-second window,
while every per-second bucket reads exactly N. A token bucket of capacity N has the same
hole. Both pass a naive per-bucket check and fail the assertion the brief actually makes.

GCRA closes it by storing the earliest instant the next send may occur and pushing it forward
by 1/N per reservation. Sends end up spaced ≥ 1/N apart, so any one-second window holds at
most N.

**The limiter never refuses — it reserves and returns *when*.** A refusal would send a
claimed message back to `PENDING` having already burned an attempt at claim time, so a tenant
under a tight limit would march its messages to `FAILED` with the provider never called once.

---

## T1 is not literally achievable, and here is the arithmetic

The brief asks the test to prove the provider accepted each of 1,000 messages exactly once.
With 20% errors and 10% timeouts, a message is never accepted only if every one of its five
attempts fails:

```
P(never accepted)  = 0.2^5                  = 0.00032
expected over 1,000                          = 0.32
P(at least one)    = 1 - (1 - 0.00032)^1000 ≈ 27%
```

So roughly **one run in four** contains a message the provider never accepted — correctly,
per rule 4, because it genuinely failed five times. A test asserting T1 literally fails 27%
of runs while the system behaves exactly as specified.

The invariant that must hold on **100%** of runs is:

1. No key appears more than once in `/stats`. *(This is the exactly-once property.)*
2. Every `SENT` message appears exactly once in `/stats`.
3. `sent + failed + cancelled = total seeded`. *(Nothing stuck, nothing lost.)*

### A correction to our own ADR

ADR-006 adds a fourth assertion: *every `FAILED` message appears **zero** times in `/stats`,
because an error means not accepted.* **That is wrong, and measurement proved it.**

A timeout on the **fifth** attempt is not an error. The mock does send on a timeout (P2) — it
just never replies. The dispatcher sees `unknown`, has no attempts left, and marks `FAILED`
while the provider has already recorded the acceptance.

Forcing the case (90% errors, 10% timeouts, 300 messages):

```
FAILED messages                 : 200
  present in /stats             :  25   <- all with last_error "timeout after 2000ms"
  absent  from /stats           : 175   <- all with last_error "HTTP 500"
```

The split is perfectly clean. The corrected assertion is: **a `FAILED` message appears at most
once in `/stats`, and if it appears, its final attempt was a timeout.** At the brief's own
rates this affects about 0.016% of messages, so ~15% of 1,000-message runs contain one.

---

## What was cut, and why

Priority 3 in the brief is "everything else — tell us what you cut".

- **The automated test harness (D2, T1–T4).** The largest cut. Every rule above is verified,
  but by the methods in the table, not by one scripted run that launches 1 API + 2 workers +
  the provider and asserts T1–T4. The Postman collection covers much of the same ground with
  real assertions; it does not kill a worker mid-run.
- **`kill -9` crash recovery (T3) is reasoned, not demonstrated.** The lease and sweep are
  implemented and the sweep's attempt-cap case was found by reasoning about exactly this
  scenario, but no run has actually killed a worker yet.
- **ADRs 010–016 are open.** The decisions were made and are documented in code comments
  instead. ADRs 000–009 are in `docs/adr/`.
- **All non-2xx responses are treated as retryable.** The mock emits only transient errors so
  there is no permanent-failure class to fail fast on. Production would treat 4xx as terminal
  rather than burn five attempts on a request that will never be accepted.
- **The idempotency key carries tenant and user ids in plain text.** Fine here — the provider
  is ours and the traceability is what makes the T1 assertion independent. Production would
  use `sha256(campaign_id:user_id)`, which keeps every property and removes the PII.
- **The limiter serialises each tenant on one row.** Fine to around 100/s. Beyond that it
  needs sharded buckets or a dedicated limiter; the design does not scale unchanged.
- **Clock skew is assumed away.** T2 compares the provider's timestamps against a value the
  API wrote. Everything runs on one host so skew is zero. Against a third-party provider on a
  different clock, that style of proof would need a tolerance window.
- **No auth, no pagination, no metrics, no structured tracing.** Not asked for.

---

## Layout

```
schema.sql                  hand-written DDL, every object tied to a requirement
docker-compose.yml          Postgres 16 only; app processes run on the host so kill -9 is meaningful
db/apply.sh                 apply / --reset the schema
scripts/stack.sh            start and stop the stack by PID file
src/config.ts               every tunable, each with the requirement it serves
src/db.ts                   pool; sets UTC per connection
src/sql.ts                  every statement the service runs, in one readable file
src/api.ts                  the three endpoints
src/worker.ts               sweep -> claim -> reserve -> send -> record
src/provider.ts             mock provider; shares no state with the dispatcher
src/provider-client.ts      three-way outcome, idempotency key derivation
postman/                    collection + environment
docs/adr/                   ADRs 000-009
docs/transcripts/           the two Claude Code sessions this was built in
docs/brief.md               the original brief
```

`src/sql.ts` is the file to read first. Keeping every statement in one place is deliberate:
the brief is graded on the claim query and the limiter, and SQL scattered through handlers
cannot be read as a whole.
