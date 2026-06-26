// ---------------------------------------------------------------------------
// init-db.js — Create / migrate the schema. Run with: npm run init-db
// Safe to re-run: uses IF NOT EXISTS and backfills old rows.
// ---------------------------------------------------------------------------

import "dotenv/config";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  body       TEXT NOT NULL,
  tags       TEXT[] DEFAULT '{}',
  published  BOOLEAN DEFAULT FALSE,
  views      INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS cover_image TEXT;

UPDATE posts SET status = CASE WHEN published THEN 'published' ELSE 'draft' END
 WHERE status IS NULL;

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED;
CREATE INDEX IF NOT EXISTS posts_search_idx ON posts USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS posts_status_idx ON posts (status, publish_at);
`;

try {
  await pool.query(sql);
  console.log("Schema ready: posts/users created or migrated (status, publish_at, cover_image).");
} catch (err) {
  console.error("Failed to create schema:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
