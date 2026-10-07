// Connection pool and the two transaction helpers everything else uses.
//
// One hard rule, inherited from ADR-003: no transaction is ever held across a
// network call to the provider. `tx` exists for short, local, all-database
// units of work. If you find yourself wanting to await an HTTP call inside one,
// the design has gone wrong, not the rule.

import pg from 'pg';
import { config } from './config.ts';

// Postgres returns bigint as a string by default because it does not fit in a
// JS number. Our ids do fit, and leaking "1" vs 1 into JSON responses makes the
// API awkward to assert against, so parse OID 20 (int8) as a number.
pg.types.setTypeParser(20, (v: string) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  // A worker that cannot get a connection within this window is in trouble and
  // should say so rather than queue silently behind a stuck one.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

// ADR-008: every session reads and writes time in UTC, with no exceptions.
// The columns are all `timestamptz` so the value itself is unambiguous, but a
// session's TimeZone still decides how a bare literal is interpreted and how
// values are rendered back. Pinning it here removes a whole class of
// five-and-a-half-hour bug that only shows up outside UTC.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'UTC'").catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'could not set UTC', err: String(err) }));
  });
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'idle pool client error', err: String(err) }));
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // A rollback can itself fail if the connection died; the original error is
    // the one worth propagating, so swallow this one deliberately.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function waitForDatabase(attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
