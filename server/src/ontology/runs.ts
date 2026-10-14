import { db } from '../clients.js';
import { getSettings } from '../llm/settings.js';
import type { User } from '../auth.js';
import { estimateRun, RunCancelledError, runCreate, runMaintain, type Usage } from './agents.js';
import { changeCount, detectChanges, saveSnapshots, type Changes } from './changes.js';

// Calculation runs: started by a person (after confirming the cost) for one
// zone, run in the background, one at a time per zone. A successful run
// snapshots every page it looked at; a failed or cancelled run doesn't, so the
// next calculation covers the same changes again.

export class RunError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

// List prices per million tokens (input, output) for models the cost
// estimate knows about; other models show token counts only.
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
};

export function priceFor(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  return price ? (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000 : null;
}

const summary = (c: Changes) => ({
  added: c.added.map((p) => p.path),
  modified: c.modified.map((p) => p.path),
  deleted: c.deleted.map((p) => p.path),
});

export interface ChangePreview {
  added: string[];
  modified: string[];
  deleted: string[];
  total: number;
  estimate: {
    provider: string;
    model: string;
    batches: number;
    inputTokens: number;
    outputTokens: number;
    // A range, since the agents decide how much to read.
    costUsd: { low: number; high: number } | null;
  } | null;
}

export async function previewChanges(zone: string): Promise<ChangePreview> {
  const changes = await detectChanges(zone);
  const settings = await getSettings().catch(() => null);
  const size = estimateRun(changes);
  const cost = settings ? priceFor(settings.model, size.inputTokens, size.outputTokens) : null;
  return {
    ...summary(changes),
    total: changeCount(changes),
    estimate: settings
      ? {
          provider: settings.provider,
          model: settings.model,
          batches: size.batches,
          inputTokens: size.inputTokens,
          outputTokens: size.outputTokens,
          costUsd: cost === null ? null : { low: cost * 0.5, high: cost * 2 },
        }
      : null,
  };
}

export interface Run {
  id: string;
  zone: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedBy: string;
  provider: string;
  model: string;
  changes: { added: string[]; modified: string[]; deleted: string[] };
  progress: { workflow?: string; batch?: number; batches?: number; recommendations?: number };
  usage: Partial<Usage> & { costUsd?: number | null };
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  recommendations: number;
}

interface RunRow {
  id: string;
  zone: string;
  status: Run['status'];
  started_by_name: string;
  provider: string;
  model: string;
  changes: Run['changes'];
  progress: Run['progress'];
  usage: Run['usage'];
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
  recommendations: string;
}

const RUN_SELECT = `SELECT r.*, (SELECT count(*) FROM ontology_recommendations x WHERE x.run_id = r.id) AS recommendations
                    FROM ontology_runs r`;

const toRun = (r: RunRow): Run => ({
  id: r.id,
  zone: r.zone,
  status: r.status,
  startedBy: r.started_by_name,
  provider: r.provider,
  model: r.model,
  changes: r.changes,
  progress: r.progress,
  usage: r.usage,
  error: r.error,
  startedAt: r.started_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  recommendations: Number(r.recommendations),
});

export async function listRuns(zone: string, limit = 10): Promise<Run[]> {
  const { rows } = await db.query<RunRow>(`${RUN_SELECT} WHERE r.zone = $1 ORDER BY r.started_at DESC LIMIT $2`, [zone, limit]);
  return rows.map(toRun);
}

export async function getRun(id: string): Promise<Run> {
  const { rows } = await db.query<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [id]);
  if (!rows[0]) throw new RunError('No such run.', 404);
  return toRun(rows[0]);
}

// A run left "running" by a server restart can never finish.
export async function failInterruptedRuns(): Promise<void> {
  await db.query(
    `UPDATE ontology_runs SET status = 'failed', error = 'The server restarted during the run.', finished_at = now()
     WHERE status = 'running'`,
  );
}

export async function startRun(user: User, zone: string): Promise<Run> {
  const settings = await getSettings();
  if (!settings) throw new RunError('Set up an LLM provider in Settings first.');

  const changes = await detectChanges(zone);
  if (changeCount(changes) === 0) throw new RunError('Nothing changed in this zone since the last calculation.', 409);

  const client = await db.connect();
  let runId: string;
  try {
    await client.query('BEGIN');
    // One run at a time per zone, across concurrent requests.
    await client.query('SELECT pg_advisory_xact_lock(7140001)');
    const { rows: active } = await client.query("SELECT 1 FROM ontology_runs WHERE status = 'running' AND zone = $1", [zone]);
    if (active.length) throw new RunError('A calculation is already running in this zone.', 409);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ontology_runs (status, started_by, started_by_name, provider, model, changes, zone)
       VALUES ('running', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [user.id, user.name ?? user.username, settings.provider, settings.model, JSON.stringify(summary(changes)), zone],
    );
    runId = rows[0].id;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  void execute(runId, zone, changes).catch((err) => console.error('ontology run crashed:', err));
  return getRun(runId);
}

async function execute(runId: string, zone: string, changes: Changes): Promise<void> {
  const settings = (await getSettings())!;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  const previousContent = new Map<string, string>([
    ...changes.modified.map((p) => [p.path, p.previousContent] as const),
    ...changes.deleted.map((p) => [p.path, p.previousContent] as const),
  ]);
  const ctx = {
    runId,
    zone,
    settings,
    changes,
    previousContent,
    usage,
    isCancelled: async () => {
      const { rows } = await db.query<{ cancel_requested: boolean }>(
        'SELECT cancel_requested FROM ontology_runs WHERE id = $1',
        [runId],
      );
      return rows[0]?.cancel_requested ?? true;
    },
    onProgress: async (progress: Run['progress']) => {
      await db.query('UPDATE ontology_runs SET progress = $2, usage = $3 WHERE id = $1', [
        runId,
        JSON.stringify(progress),
        JSON.stringify(usage),
      ]);
    },
  };

  const finish = async (status: Run['status'], error: string | null) => {
    const final = { ...usage, costUsd: priceFor(settings.model, usage.inputTokens, usage.outputTokens) };
    await db.query(
      'UPDATE ontology_runs SET status = $2, error = $3, usage = $4, finished_at = now() WHERE id = $1',
      [runId, status, error, JSON.stringify(final)],
    );
  };

  try {
    // Maintain first, so "create" sees the ontology as it will be reviewed.
    await runMaintain(ctx);
    await runCreate(ctx);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await saveSnapshots(client, zone, changes, runId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await finish('succeeded', null);
  } catch (err) {
    if (err instanceof RunCancelledError) {
      await finish('cancelled', null);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error('ontology run failed:', message);
      await finish('failed', message);
    }
  }
}

export async function cancelRun(id: string): Promise<Run> {
  const { rowCount } = await db.query(
    "UPDATE ontology_runs SET cancel_requested = true WHERE id = $1 AND status = 'running'",
    [id],
  );
  if (!rowCount) throw new RunError('That run is not running.', 409);
  return getRun(id);
}
