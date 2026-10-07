-- =============================================================================
-- Scheduled notification dispatcher — schema
--
-- Hand-written (D1). No ORM, no migration framework, no generator.
-- Postgres 16, default READ COMMITTED isolation (ADR-001).
--
-- Every object below exists to serve a numbered requirement from
-- ADR-000-acceptance-requirements. The comment above each one names which.
-- An object that serves nothing is not here.
--
-- Apply with: db/apply.sh      (db/apply.sh --reset to rebuild from empty)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Enumerated types
--
-- These three sets are closed by the brief, not by us: the channel list, the
-- two campaign states we store, and the five count buckets that A3 fixes.
-- A closed set that will not change is what an enum is for. The alternative,
-- text + CHECK, buys the ability to add a value cheaply -- which is exactly the
-- ability we do not want here, because a sixth message status would silently
-- fall outside the five buckets GET /campaigns/:id reports.
-- -----------------------------------------------------------------------------

CREATE TYPE channel AS ENUM ('SMS', 'WHATSAPP', 'EMAIL');

-- SCHEDULED and CANCELLED are the only *stored* campaign states.
-- COMPLETED is derived by the API when no non-terminal messages remain; it is
-- deliberately not stored. Storing it would require some process to write it,
-- and that process can die between the last message finishing and the write --
-- which reintroduces precisely the stuck-state failure ADR-005 removed by
-- folding the sweep into the claim query.
CREATE TYPE campaign_status AS ENUM ('SCHEDULED', 'CANCELLED');

-- The five buckets of A3, and the state machine of ADR-005.
-- PENDING     = unowned, claimable once due
-- IN_PROGRESS = some worker holds a live lease on it right now
-- SENT / FAILED / CANCELLED = terminal
CREATE TYPE message_status AS ENUM (
    'PENDING', 'IN_PROGRESS', 'SENT', 'FAILED', 'CANCELLED'
);


-- -----------------------------------------------------------------------------
-- campaigns                                                            (A1, A2)
-- -----------------------------------------------------------------------------

CREATE TABLE campaigns (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    text            NOT NULL,
    channel      channel         NOT NULL,
    send_at      timestamptz     NOT NULL,
    status       campaign_status NOT NULL DEFAULT 'SCHEDULED',
    created_at   timestamptz     NOT NULL DEFAULT now(),
    cancelled_at timestamptz,

    CONSTRAINT campaigns_tenant_id_not_blank
        CHECK (length(tenant_id) > 0),

    -- A2 requires a second cancel to be a no-op. The handler enforces that with
    -- WHERE status <> 'CANCELLED', so cancelled_at is written exactly once, on
    -- the transition. This constraint is what makes that claim checkable: the
    -- timestamp is present if and only if the campaign is cancelled, so a
    -- second cancel that wrongly re-stamped it would have to also un-cancel.
    CONSTRAINT campaigns_cancelled_at_agrees_with_status
        CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),

    -- Redundant against the primary key, and it is here on purpose: it is the
    -- target of the composite foreign key on messages below, which is what
    -- stops the denormalised tenant_id/send_at from ever drifting.
    CONSTRAINT campaigns_id_tenant_send_at_key
        UNIQUE (id, tenant_id, send_at)
);


-- -----------------------------------------------------------------------------
-- messages                                                     (R1-R5, R7, A3)
--
-- One row per (campaign, recipient). This is the work queue.
-- -----------------------------------------------------------------------------

CREATE TABLE messages (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_id bigint         NOT NULL REFERENCES campaigns (id),
    user_id     text           NOT NULL,

    -- Denormalised from campaigns. Both are immutable after insert -- a campaign
    -- is never re-tenanted and never rescheduled -- so there is no update path
    -- that could desynchronise them, and the composite FK below removes even
    -- the insert path. They are here so the claim query stays single-table:
    -- SELECT ... FOR UPDATE SKIP LOCKED across a join locks rows in the joined
    -- table too unless every FOR UPDATE OF clause is written exactly right, and
    -- getting that wrong is silent. The claim query is the one place in this
    -- system where correctness is decided (ADR-003); it gets to be boring.
    --
    -- send_at specifically also keeps R2 a literal predicate on the row being
    -- claimed -- `send_at <= now()` -- rather than a predicate on a joined row.
    tenant_id   text           NOT NULL,
    send_at     timestamptz    NOT NULL,

    status      message_status NOT NULL DEFAULT 'PENDING',

    -- Incremented inside the claiming UPDATE and nowhere else (ADR-006a).
    -- Counting attempts *made* rather than replies *received* is what makes the
    -- cap of 5 survive a worker that is killed between claiming and replying;
    -- a crash burns an attempt, which is the correct price.
    attempts    int            NOT NULL DEFAULT 0,

    -- Backoff gate. Separate from send_at so that send_at stays immutable:
    -- R2 is a priority-1 requirement and it is argued from one unchanging
    -- column, not from a mutable visibility timestamp that was initialised
    -- correctly and never moved backwards.
    next_attempt_at timestamptz NOT NULL DEFAULT now(),

    -- Lease (ADR-003). Non-null exactly while a worker owns the row. An expired
    -- lease is swept by the next claim query any worker runs -- there is no
    -- reaper process (ADR-005), so worst-case recovery is the lease duration.
    lease_until timestamptz,

    -- Breadcrumb, not control state. Survives into terminal rows so that a
    -- post-mortem can answer "which worker handled this". Nothing reads it.
    worker_id   text,

    last_error  text,
    sent_at     timestamptz,
    updated_at  timestamptz    NOT NULL DEFAULT now(),

    -- R1 in the schema, in the brief's own words: "each (campaign_id, user_id)
    -- message". This is also what makes the idempotency key of ADR-004 a key:
    -- without it, two rows share one key, the provider correctly sends once,
    -- and the counts report two messages for one recipient.
    CONSTRAINT messages_campaign_user_key UNIQUE (campaign_id, user_id),

    -- R4's cap, enforced by the database and not only by the claim predicate.
    CONSTRAINT messages_attempts_capped
        CHECK (attempts >= 0 AND attempts <= 5),

    -- ADR-005's core invariant: PENDING means unowned. A live lease can exist
    -- only on a row a worker is actually holding, so any code path that forgets
    -- to clear lease_until on the way out of IN_PROGRESS fails loudly here
    -- rather than leaving a row that looks owned forever.
    CONSTRAINT messages_lease_only_while_in_progress
        CHECK (status = 'IN_PROGRESS' OR lease_until IS NULL),

    -- T2's evidence inside our own database. If a row is SENT it carries the
    -- moment it was sent, and if it is not SENT it carries no such moment, so
    -- `sent_at < send_at` is a question that can always be asked of every row.
    CONSTRAINT messages_sent_at_iff_sent
        CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),

    -- This is what makes the denormalisation above safe rather than merely
    -- convenient. An INSERT can only supply a (tenant_id, send_at) pair that
    -- the referenced campaign actually has; a wrong pair is rejected by the
    -- database. No trigger, no application invariant, no drift.
    CONSTRAINT messages_denormalised_fields_match_campaign
        FOREIGN KEY (campaign_id, tenant_id, send_at)
        REFERENCES campaigns (id, tenant_id, send_at)
);


-- The claim query (ADR-003/005), which this index exists for:
--
--   UPDATE messages m
--      SET status = 'IN_PROGRESS',
--          lease_until = now() + $lease,
--          worker_id = $1,
--          attempts = attempts + 1,
--          updated_at = now()
--    WHERE m.id IN (
--            SELECT id FROM messages
--             WHERE send_at         <= now()
--               AND next_attempt_at <= now()
--               AND attempts < 5
--               AND ( status = 'PENDING'
--                  OR (status = 'IN_PROGRESS' AND lease_until < now()) )
--             ORDER BY send_at
--             LIMIT $2
--             FOR UPDATE SKIP LOCKED )
--   RETURNING m.*;
--
-- Partial, over non-terminal rows only. Terminal rows leave the index as they
-- finish, so over a run it shrinks toward empty rather than growing with the
-- table -- which is the thing a full index on a work queue gets wrong.
CREATE INDEX messages_claimable_idx
    ON messages (send_at)
    WHERE status IN ('PENDING', 'IN_PROGRESS');


-- The counts query (R7, A3):
--
--   SELECT status, count(*) FROM messages WHERE campaign_id = $1 GROUP BY status
--
-- One statement, therefore one MVCC snapshot, therefore counts that are correct
-- at the instant they are read rather than eventually correct. There are no
-- counter columns to drift out of step, which is the whole argument: a
-- denormalised count is correct only if every transition remembers to adjust it,
-- and "every transition" includes the ones added later.
CREATE INDEX messages_counts_idx
    ON messages (campaign_id, status);


-- -----------------------------------------------------------------------------
-- tenant_limits                                                   (R6, T4)
--
-- One row per tenant holding GCRA state. The whole limiter is this table plus a
-- single UPDATE ... RETURNING, which is why the limit is global across workers
-- for free: the workers already share this database, so they already share this
-- row, and the UPDATE is atomic.
--
-- Why GCRA and not a counter. T4 asserts that no tenant exceeded N sends in
-- ANY one-second window, measured from provider timestamps. A counter keyed on
-- the current second permits N sends at t=0.99 and N more at t=1.01 -- 2N inside
-- a real one-second window, while every per-second bucket reads exactly N. A
-- token bucket of capacity N has the same hole: a full bucket drains instantly
-- and refills N over the following second. Both pass a naive per-bucket check
-- and fail the assertion the brief actually makes.
--
-- GCRA closes it by storing the earliest instant the next send may occur, and
-- pushing that instant forward by 1/rate_per_sec seconds per reserved send.
-- Sends are therefore spaced at least 1/N apart, so any half-open one-second
-- window contains at most N of them -- which is the assertion, directly.
--
-- Reserving k slots, atomically, for one tenant:
--
--   UPDATE tenant_limits
--      SET next_slot_at = GREATEST(next_slot_at, now())
--                          + make_interval(secs => k::numeric / rate_per_sec)
--    WHERE tenant_id = $1
--   RETURNING GREATEST(next_slot_at, now())
--             - make_interval(secs => k::numeric / rate_per_sec) AS first_slot,
--             1.0 / rate_per_sec AS spacing_secs;
--
-- The limiter never refuses. It reserves and returns *when*, and the worker
-- sleeps until then. That distinction matters: a refusal would send a claimed
-- message back to PENDING having already burned an attempt at claim time
-- (ADR-006a), so a tenant under a tight limit would march its messages to
-- FAILED after five refusals without the provider ever being called once.
--
-- A worker that dies holding reserved slots wastes them -- the clock has already
-- moved forward. That is the safe direction: the limiter over-reserves and
-- under-sends, never the reverse.
-- -----------------------------------------------------------------------------

CREATE TABLE tenant_limits (
    tenant_id       text PRIMARY KEY,
    rate_per_sec   int         NOT NULL,
    next_slot_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tenant_limits_positive
        CHECK (rate_per_sec > 0)
);


-- -----------------------------------------------------------------------------
-- Notes on what is deliberately absent
--
-- No updated_at trigger. updated_at is set explicitly by every statement that
--   writes a row. A trigger would make the column correct without making it
--   visible in the queries a reviewer reads.
--
-- No reaper table, no worker registry, no heartbeat. Crash recovery is a
--   property of the claim query that every worker already runs (ADR-005).
--
-- No provider log table. The mock provider records accepted sends in its own
--   process memory. It is the oracle for T1, T2 and T4, so it does not share
--   storage with the system it is grading.
-- -----------------------------------------------------------------------------
