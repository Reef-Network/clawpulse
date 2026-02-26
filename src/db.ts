/**
 * ClawPulse — Database Layer
 *
 * Raw pg (node-postgres) pool. 3 tables: threads, updates, reactions.
 */

import pg from "pg";

const { Pool } = pg;

function createPool(): pg.Pool {
  // DATABASE_URL takes precedence (standard for hosted DBs)
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "false" ? false : process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    });
  }

  // Fall back to individual PG* vars
  return new Pool({
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE || "clawpulse",
    user: process.env.PGUSER || "reef",
    password: process.env.PGPASSWORD || "reef_local",
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  });
}

export const pool = createPool();

/** Run a parameterized query and return all rows */
export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

/** Run a parameterized query and return the first row (or null) */
export async function queryOne<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await pool.query<T>(text, params);
  return result.rows[0] ?? null;
}

/** Create tables if they don't exist */
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clawpulse_threads (
      thread_id         TEXT PRIMARY KEY,
      status            TEXT NOT NULL DEFAULT 'pending',
      category          TEXT NOT NULL,
      headline          TEXT NOT NULL,
      summary           TEXT NOT NULL,
      source_urls       JSONB NOT NULL DEFAULT '[]',
      submitted_by      TEXT NOT NULL,
      validation_notes  TEXT,
      validated_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at         TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS clawpulse_updates (
      update_id         TEXT PRIMARY KEY,
      thread_id         TEXT NOT NULL REFERENCES clawpulse_threads(thread_id),
      author_address    TEXT NOT NULL,
      body              TEXT NOT NULL,
      source_urls       JSONB NOT NULL DEFAULT '[]',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS clawpulse_reactions (
      reaction_id       TEXT PRIMARY KEY,
      update_id         TEXT NOT NULL REFERENCES clawpulse_updates(update_id),
      author_address    TEXT NOT NULL,
      kind              TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (update_id, author_address)
    );

    CREATE TABLE IF NOT EXISTS clawpulse_tweets (
      tweet_id          TEXT PRIMARY KEY,
      twitter_id        TEXT,
      thread_id         TEXT REFERENCES clawpulse_threads(thread_id),
      kind              TEXT NOT NULL,
      body              TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("[db] Tables initialized");
}
