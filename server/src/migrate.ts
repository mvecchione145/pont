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

    -- Ontology recommendations can also come from agents over MCP (no run).
    ALTER TABLE ontology_recommendations ALTER COLUMN run_id DROP NOT NULL;
    ALTER TABLE ontology_recommendations ADD COLUMN IF NOT EXISTS proposed_by text;

    -- Page changes proposed by agents over MCP. The diff itself is stored as
    -- proposals/<id>.patch in the bucket.
    CREATE TABLE IF NOT EXISTS page_proposals (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind               text NOT NULL,
      path               text NOT NULL,
      base_version_id    text,
      reason             text NOT NULL,
      proposed_by        text NOT NULL,
      proposed_by_name   text NOT NULL,
      status             text NOT NULL DEFAULT 'pending',
      created_at         timestamptz NOT NULL DEFAULT now(),
      decided_by         text,
      decided_at         timestamptz,
      decision_note      text,
      applied_version_id text
    );
    CREATE INDEX IF NOT EXISTS page_proposals_status ON page_proposals (status, created_at);
    CREATE INDEX IF NOT EXISTS page_proposals_proposer ON page_proposals (proposed_by, status);

    -- Which pages link to which ontology concepts and relationships
    -- (Markdown links to #/concept/<id> and #/relation/<id>). Derived from
    -- the pages; rebuilt on every start.
    CREATE TABLE IF NOT EXISTS ontology_links (
      path   text NOT NULL,
      kind   text NOT NULL,
      target text NOT NULL,
      PRIMARY KEY (path, kind, target)
    );
    CREATE INDEX IF NOT EXISTS ontology_links_target ON ontology_links (kind, target);

    -- Page reviews: an LLM reads one page (and related passages from other
    -- pages) and suggests clearer wording and points out contradictions.
    CREATE TABLE IF NOT EXISTS page_reviews (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      path            text NOT NULL,
      version_id      text,
      status          text NOT NULL,
      started_by      text NOT NULL,
      started_by_name text NOT NULL,
      provider        text NOT NULL,
      model           text NOT NULL,
      compared        jsonb NOT NULL DEFAULT '[]',
      result          jsonb,
      usage           jsonb NOT NULL DEFAULT '{}',
      error           text,
      started_at      timestamptz NOT NULL DEFAULT now(),
      finished_at     timestamptz
    );
    CREATE INDEX IF NOT EXISTS page_reviews_path ON page_reviews (path, started_at DESC);

    -- Where pages were moved or renamed to, so links to an old path can be
    -- pointed at the new one. Moves made before this table existed are
    -- backfilled once from the "moved-from" metadata in page history.
    -- GitHub: each user's connected account (token encrypted with
    -- PONT_SECRET_KEY), pending OAuth sign-ins, and pages linked to files in
    -- repositories, with the pull request their published edits are in.
    CREATE TABLE IF NOT EXISTS github_accounts (
      user_id         text PRIMARY KEY,
      login           text NOT NULL,
      token_encrypted text NOT NULL,
      scopes          text NOT NULL DEFAULT '',
      connected_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS github_oauth_states (
      state      text PRIMARY KEY,
      user_id    text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS github_links (
      page_path text PRIMARY KEY,
      owner     text NOT NULL,
      repo      text NOT NULL,
      branch    text NOT NULL,
      file_path text NOT NULL,
      -- Blob SHA of the file on the branch, as last synced into pont.
      base_sha  text NOT NULL,
      pr_number integer,
      pr_branch text,
      pr_url    text,
      linked_by text NOT NULL,
      linked_at timestamptz NOT NULL DEFAULT now(),
      synced_at timestamptz NOT NULL DEFAULT now()
    );

    -- Background checks of linked files: who linked it (whose token to use),
    -- the file's latest blob SHA seen on the branch being edited (the pull
    -- request's branch while one is open), and its ETag for cheap polling.
    ALTER TABLE github_links ADD COLUMN IF NOT EXISTS linked_by_id text;
    ALTER TABLE github_links ADD COLUMN IF NOT EXISTS remote_sha text;
    ALTER TABLE github_links ADD COLUMN IF NOT EXISTS remote_etag text;
    ALTER TABLE github_links ADD COLUMN IF NOT EXISTS checked_at timestamptz;

    -- Every pull request pont opened for a linked page, and how it went.
    CREATE TABLE IF NOT EXISTS github_pull_requests (
      id            bigserial PRIMARY KEY,
      page_path     text NOT NULL,
      owner         text NOT NULL,
      repo          text NOT NULL,
      number        integer NOT NULL,
      url           text NOT NULL,
      branch        text NOT NULL,
      title         text NOT NULL,
      state         text NOT NULL DEFAULT 'open',
      draft         boolean NOT NULL DEFAULT false,
      review_state  text,
      publishes     integer NOT NULL DEFAULT 1,
      opened_by     text NOT NULL,
      opened_by_id  text NOT NULL,
      opened_at     timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      closed_at     timestamptz,
      UNIQUE (owner, repo, number)
    );
    CREATE INDEX IF NOT EXISTS github_pull_requests_page ON github_pull_requests (page_path, opened_at DESC);

    CREATE TABLE IF NOT EXISTS page_moves (
      from_path text NOT NULL,
      to_path   text NOT NULL,
      moved_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (from_path, to_path)
    );
  `);
}
