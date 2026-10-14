import { createHash } from 'node:crypto';
import { db } from '../clients.js';
import type { ConceptType, RelationType, Source } from './store.js';

// Recommendations: changes to the ontology proposed by the agents, held for
// a person to approve or reject. Nothing here changes the ontology itself.

// 'agent' recommendations come from agents over MCP rather than a run.
export type Workflow = 'maintain' | 'create' | 'agent';

export type Recommendation =
  | { action: 'create_concept'; payload: { name: string; type: ConceptType; definition: string; aliases: string[] } }
  | {
      action: 'update_concept';
      payload: { conceptId: string; name?: string; type?: ConceptType; definition?: string; aliases?: string[] };
    }
  | { action: 'delete_concept'; payload: { conceptId: string } }
  | { action: 'add_alias'; payload: { conceptId: string; alias: string } }
  | { action: 'create_relation'; payload: { from: string; type: RelationType; to: string } }
  | { action: 'delete_relation'; payload: { relationId: string } };

export interface NewRecommendation {
  runId: string | null;
  // The zone whose ontology this changes.
  zone: string;
  // Who proposed it, for recommendations made over MCP.
  proposedBy?: string;
  workflow: Workflow;
  recommendation: Recommendation;
  rationale: string;
  evidence: Source[];
  confidence: number;
}

export interface StoredRecommendation {
  id: string;
  zone: string;
  runId: string | null;
  proposedBy: string | null;
  workflow: Workflow;
  action: Recommendation['action'];
  payload: Record<string, unknown>;
  rationale: string;
  evidence: Source[];
  confidence: number;
  status: 'pending' | 'approved' | 'rejected' | 'failed' | 'superseded';
  decidedBy: string | null;
  decidedAt: string | null;
  error: string | null;
  createdAt: string;
}

// Identifies "the same suggestion" across runs (within a zone), so a rejected
// one isn't suggested again and a pending one isn't duplicated.
export function fingerprint(r: Recommendation): string {
  const normalized = JSON.stringify(r, (_k, v) => (typeof v === 'string' ? v.trim().toLowerCase() : v));
  return createHash('sha256').update(normalized).digest('hex');
}

export type SaveOutcome = 'saved' | 'duplicate' | 'previously-rejected';

export async function saveRecommendation(rec: NewRecommendation): Promise<SaveOutcome> {
  const fp = fingerprint(rec.recommendation);
  const { rows } = await db.query<{ status: string }>(
    "SELECT status FROM ontology_recommendations WHERE fingerprint = $1 AND zone = $2 AND status IN ('pending', 'rejected')",
    [fp, rec.zone],
  );
  if (rows.some((r) => r.status === 'rejected')) return 'previously-rejected';
  if (rows.length) return 'duplicate';
  // A new concept with the same name as one already waiting for review is a
  // duplicate even if its wording differs.
  if (rec.recommendation.action === 'create_concept') {
    const { rows: sameName } = await db.query(
      `SELECT 1 FROM ontology_recommendations
       WHERE status = 'pending' AND zone = $2 AND action = 'create_concept' AND lower(payload->>'name') = lower($1)`,
      [rec.recommendation.payload.name.trim(), rec.zone],
    );
    if (sameName.length) return 'duplicate';
  }
  await db.query(
    `INSERT INTO ontology_recommendations
       (run_id, workflow, action, payload, rationale, evidence, confidence, fingerprint, proposed_by, zone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      rec.runId,
      rec.workflow,
      rec.recommendation.action,
      JSON.stringify(rec.recommendation.payload),
      rec.rationale,
      JSON.stringify(rec.evidence),
      rec.confidence,
      fp,
      rec.proposedBy ?? null,
      rec.zone,
    ],
  );
  return 'saved';
}

interface Row {
  id: string;
  zone: string;
  run_id: string | null;
  proposed_by: string | null;
  workflow: Workflow;
  action: Recommendation['action'];
  payload: Record<string, unknown>;
  rationale: string;
  evidence: Source[];
  confidence: number;
  status: StoredRecommendation['status'];
  decided_by: string | null;
  decided_at: Date | null;
  error: string | null;
  created_at: Date;
}

export const toStored = (r: Row): StoredRecommendation => ({
  id: r.id,
  zone: r.zone,
  runId: r.run_id,
  proposedBy: r.proposed_by,
  workflow: r.workflow,
  action: r.action,
  payload: r.payload,
  rationale: r.rationale,
  evidence: r.evidence,
  confidence: r.confidence,
  status: r.status,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at?.toISOString() ?? null,
  error: r.error,
  createdAt: r.created_at.toISOString(),
});

export async function listRecommendations(
  zone: string,
  status: 'pending' | 'decided',
  limit = 200,
): Promise<StoredRecommendation[]> {
  const { rows } = await db.query<Row>(
    status === 'pending'
      ? "SELECT * FROM ontology_recommendations WHERE zone = $1 AND status = 'pending' ORDER BY workflow, created_at LIMIT $2"
      : "SELECT * FROM ontology_recommendations WHERE zone = $1 AND status <> 'pending' ORDER BY decided_at DESC NULLS LAST LIMIT $2",
    [zone, limit],
  );
  return rows.map(toStored);
}

// Pending recommendations per zone (zones with none are left out).
export async function pendingByZone(): Promise<Map<string, number>> {
  const { rows } = await db.query<{ zone: string; n: number }>(
    "SELECT zone, count(*)::int AS n FROM ontology_recommendations WHERE status = 'pending' GROUP BY zone",
  );
  return new Map(rows.map((r) => [r.zone, r.n]));
}

export async function pendingRecommendationCount(): Promise<number> {
  let total = 0;
  for (const n of (await pendingByZone()).values()) total += n;
  return total;
}

export async function getRecommendation(id: string): Promise<StoredRecommendation | null> {
  const { rows } = await db.query<Row>('SELECT * FROM ontology_recommendations WHERE id = $1', [id]);
  return rows[0] ? toStored(rows[0]) : null;
}
