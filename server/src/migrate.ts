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

    CREATE TABLE IF NOT EXISTS settings (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trivia_questions (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       text NOT NULL,
      user_name     text NOT NULL,
      path          text NOT NULL,
      headings      text NOT NULL,
      chunk_key     text NOT NULL,
      question      text NOT NULL,
      options       jsonb NOT NULL,
      correct_index int NOT NULL,
      explanation   text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      answered_at   timestamptz,
      chosen_index  int,
      is_correct    boolean
    );
    CREATE INDEX IF NOT EXISTS trivia_questions_user ON trivia_questions (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS trivia_questions_answered ON trivia_questions (answered_at)
      WHERE is_correct IS NOT NULL;

    -- Ontology: the state of each page as of the last calculation, the
    -- calculation runs, and the recommendations they produce for review.
    CREATE TABLE IF NOT EXISTS ontology_snapshots (
      path          text PRIMARY KEY,
      version_id    text NOT NULL,
      content_hash  text NOT NULL,
      run_id        uuid NOT NULL,
      calculated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ontology_runs (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status           text NOT NULL,
      started_by       text NOT NULL,
      started_by_name  text NOT NULL,
      provider         text NOT NULL,
      model            text NOT NULL,
      changes          jsonb NOT NULL,
      progress         jsonb NOT NULL DEFAULT '{}'::jsonb,
      usage            jsonb NOT NULL DEFAULT '{}'::jsonb,
      error            text,
      cancel_requested boolean NOT NULL DEFAULT false,
      started_at       timestamptz NOT NULL DEFAULT now(),
      finished_at      timestamptz
    );
    CREATE INDEX IF NOT EXISTS ontology_runs_started ON ontology_runs (started_at DESC);

    CREATE TABLE IF NOT EXISTS ontology_recommendations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id      uuid NOT NULL REFERENCES ontology_runs (id),
      workflow    text NOT NULL,
      action      text NOT NULL,
      payload     jsonb NOT NULL,
      rationale   text NOT NULL,
      evidence    jsonb NOT NULL,
      confidence  real NOT NULL,
      fingerprint text NOT NULL,
      status      text NOT NULL DEFAULT 'pending',
      decided_by  text,
      decided_at  timestamptz,
      error       text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ontology_recommendations_status ON ontology_recommendations (status, created_at);
    CREATE INDEX IF NOT EXISTS ontology_recommendations_fingerprint ON ontology_recommendations (fingerprint);
  `);
}
