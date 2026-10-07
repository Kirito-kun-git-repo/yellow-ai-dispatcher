// API process (A1, A2, A3).
//
// This process never talks to the provider and never claims a message. It
// writes seed data, flips a campaign to cancelled, and reads counts. All the
// interesting concurrency lives in the workers.

import { resolve } from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.ts';
import { pool, tx, query, waitForDatabase, closePool } from './db.ts';
import {
  INSERT_CAMPAIGN,
  INSERT_MESSAGES,
  UPSERT_TENANT_LIMIT,
  CANCEL_CAMPAIGN,
  CANCEL_PENDING_MESSAGES,
  CAMPAIGN_EXISTS,
  CAMPAIGN_WITH_COUNTS,
} from './sql.ts';

const CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL'] as const;
type Channel = (typeof CHANNELS)[number];

class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

interface CreateCampaignBody {
  tenant_id: string;
  channel: Channel;
  send_at: Date;
  recipients: string[];
  duplicates_dropped: number;
}

/**
 * Validate and normalise POST /campaigns.
 *
 * Recipient de-duplication is not politeness, it is required by ADR-004: the
 * idempotency key is `campaign_id:user_id`, so two rows for one recipient share
 * one key. The provider would correctly send once and the counts would report
 * two messages for one person -- a discrepancy that looks like a lost message.
 * UNIQUE (campaign_id, user_id) would reject the insert anyway; de-duplicating
 * here turns a 500 into the behaviour the caller wanted.
 */
function parseCreateCampaign(raw: unknown): CreateCampaignBody {
  if (typeof raw !== 'object' || raw === null) throw new BadRequest('body must be a JSON object');
  const b = raw as Record<string, unknown>;

  const tenantId = b.tenant_id;
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new BadRequest('tenant_id must be a non-empty string');
  }

  const channel = b.channel;
  if (typeof channel !== 'string' || !CHANNELS.includes(channel as Channel)) {
    throw new BadRequest(`channel must be one of ${CHANNELS.join(', ')}`);
  }

  if (typeof b.send_at !== 'string') {
    throw new BadRequest('send_at must be an ISO 8601 timestamp string');
  }
  // ADR-008: the offset is mandatory, and this is R2 enforcement, not pedantry.
  // `new Date("2026-12-01T10:00:00")` is interpreted in the *process's* local
  // zone. An API running in IST would store that as 04:30Z, so a campaign the
  // caller meant for 10:00 goes out five and a half hours early -- a silent
  // "no early send" violation that no amount of correct claim logic can catch,
  // because by the time the worker sees the row the damage is in the column.
  // Requiring Z or an explicit +HH:MM makes the caller state what they meant.
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(b.send_at.trim())) {
    throw new BadRequest(
      'send_at must carry an explicit UTC offset or Z, e.g. 2026-12-01T10:00:00Z',
    );
  }
  const sendAt = new Date(b.send_at);
  if (Number.isNaN(sendAt.getTime())) throw new BadRequest('send_at is not a valid timestamp');

  if (!Array.isArray(b.recipients) || b.recipients.length === 0) {
    throw new BadRequest('recipients must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const r of b.recipients) {
    if (typeof r !== 'string' || r.trim() === '') {
      throw new BadRequest('every recipient must be a non-empty string');
    }
    seen.add(r);
  }

  return {
    tenant_id: tenantId,
    channel: channel as Channel,
    send_at: sendAt,
    recipients: [...seen],
    duplicates_dropped: b.recipients.length - seen.size,
  };
}

/**
 * `COMPLETED` is derived here rather than stored (see schema.sql). A campaign is
 * complete exactly when it has messages and none of them are still movable.
 * Deriving it means there is no moment where the last message has finished but
 * nobody has written the campaign row yet.
 */
function presentStatus(storedStatus: string, pending: number, inProgress: number, total: number) {
  if (storedStatus === 'CANCELLED') return 'CANCELLED';
  if (total > 0 && pending === 0 && inProgress === 0) return 'COMPLETED';
  return 'SCHEDULED';
}

export function buildApp() {
  const app = express();
  app.use(express.json({ limit: '16mb' })); // 1,000 recipients is a big body

  app.get('/health', async (_req, res) => {
    await query('SELECT 1');
    res.json({ ok: true, process: 'api' });
  });

  // --- A1 ------------------------------------------------------------------
  app.post('/campaigns', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseCreateCampaign(req.body);

      const created = await tx(async (c) => {
        const campaign = await c.query(INSERT_CAMPAIGN, [
          body.tenant_id,
          body.channel,
          body.send_at.toISOString(),
        ]);
        const row = campaign.rows[0]!;

        const inserted = await c.query(INSERT_MESSAGES, [row.id, body.recipients]);

        // The tenant must have a limiter row before any worker tries to reserve
        // a slot for it, and this transaction is the only place we know the
        // tenant exists. Doing it here means the worker's reserve can assume
        // the row is present instead of handling a missing-tenant case.
        await c.query(UPSERT_TENANT_LIMIT, [body.tenant_id, config.rateLimitPerSec]);

        return { row, messageCount: inserted.rowCount ?? 0 };
      });

      res.status(201).json({
        id: created.row.id,
        tenant_id: created.row.tenant_id,
        channel: created.row.channel,
        send_at: created.row.send_at,
        status: created.row.status,
        messages_created: created.messageCount,
        duplicates_dropped: body.duplicates_dropped,
        rate_limit_per_sec: config.rateLimitPerSec,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- A2 ------------------------------------------------------------------
  app.post('/campaigns/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new BadRequest('campaign id must be an integer');

      const result = await tx(async (c) => {
        const exists = await c.query(CAMPAIGN_EXISTS, [id]);
        if (exists.rowCount === 0) return null;

        // Zero rows here means it was already cancelled, which is R3's
        // "a second cancel call does nothing" -- detected without a prior read,
        // so two concurrent cancels cannot both believe they were first.
        const flipped = await c.query(CANCEL_CAMPAIGN, [id]);
        const alreadyCancelled = flipped.rowCount === 0;

        const stopped = await c.query(CANCEL_PENDING_MESSAGES, [id]);
        return { alreadyCancelled, pendingCancelled: stopped.rowCount ?? 0 };
      });

      if (result === null) return res.status(404).json({ error: 'campaign not found' });

      res.json({
        id,
        status: 'CANCELLED',
        already_cancelled: result.alreadyCancelled,
        pending_messages_cancelled: result.pendingCancelled,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- A3 ------------------------------------------------------------------
  app.get('/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new BadRequest('campaign id must be an integer');

      const r = await query(CAMPAIGN_WITH_COUNTS, [id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'campaign not found' });
      const row = r.rows[0]!;

      const counts = {
        pending: row.pending,
        in_progress: row.in_progress,
        sent: row.sent,
        failed: row.failed,
        cancelled: row.cancelled,
      };

      res.json({
        id: row.id,
        tenant_id: row.tenant_id,
        channel: row.channel,
        send_at: row.send_at,
        status: presentStatus(row.stored_status, counts.pending, counts.in_progress, row.total),
        counts,
      });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', err: String(err) }));
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

// Exact path comparison: a basename match would also fire when some other
// directory happened to contain a file called api.ts.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await waitForDatabase();
  const server = buildApp().listen(config.apiPort, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'api listening', port: config.apiPort }));
  });
  const shutdown = async () => {
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void pool;
