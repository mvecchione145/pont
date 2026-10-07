import { db } from './clients.js';

// Idempotent schema setup, run on every server start.
export async function migrate(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      text NOT NULL,
      user_name    text NOT NULL,
      username     text NOT NULL,
      name         text NOT NULL,
      prefix       text NOT NULL,
      token_hash   text NOT NULL UNIQUE,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at   timestamptz
    );
    CREATE INDEX IF NOT EXISTS api_tokens_user_id ON api_tokens (user_id);
  `);
}
