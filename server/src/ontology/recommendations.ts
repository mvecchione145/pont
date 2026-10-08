import { createHash } from 'node:crypto';
import { db } from '../clients.js';
import type { ConceptType, RelationType, Source } from './store.js';

// Recommendations: changes to the ontology proposed by the agents, held for
// a person to approve or reject. Nothing here changes the ontology itself.

export type Workflow = 'maintain' | 'create';

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
  runId: string;
  workflow: Workflow;
  recommendation: Recommendation;
  rationale: string;
  evidence: Source[];
  confidence: number;
}

export interface StoredRecommendation {
  id: string;
  runId: string;
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

// Identifies "the same suggestion" across runs, so a rejected one isn't
// suggested again and a pending one isn't duplicated.
export function fingerprint(r: Recommendation): string {
  const normalized = JSON.stringify(r, (_k, v) => (typeof v === 'string' ? v.trim().toLowerCase() : v));
  return createHash('sha256').update(normalized).digest('hex');
}

export type SaveOutcome = 'saved' | 'duplicate' | 'previously-rejected';

export async function saveRecommendation(rec: NewRecommendation): Promise<SaveOutcome> {
  const fp = fingerprint(rec.recommendation);
  const { rows } = await db.query<{ status: string }>(
    "SELECT status FROM ontology_recommendations WHERE fingerprint = $1 AND status IN ('pending', 'rejected')",
    [fp],
  );
  if (rows.some((r) => r.status === 'rejected')) return 'previously-rejected';
  if (rows.length) return 'duplicate';
  await db.query(
    `INSERT INTO ontology_recommendations
       (run_id, workflow, action, payload, rationale, evidence, confidence, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      rec.runId,
      rec.workflow,
      rec.recommendation.action,
      JSON.stringify(rec.recommendation.payload),
      rec.rationale,
      JSON.stringify(rec.evidence),
      rec.confidence,
      fp,
    ],
  );
  return 'saved';
}

interface Row {
  id: string;
  run_id: string;
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
  runId: r.run_id,
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

export async function listRecommendations(status: 'pending' | 'decided', limit = 200): Promise<StoredRecommendation[]> {
  const { rows } = await db.query<Row>(
    status === 'pending'
      ? "SELECT * FROM ontology_recommendations WHERE status = 'pending' ORDER BY workflow, created_at LIMIT $1"
      : "SELECT * FROM ontology_recommendations WHERE status <> 'pending' ORDER BY decided_at DESC NULLS LAST LIMIT $1",
    [limit],
  );
  return rows.map(toStored);
}

export async function getRecommendation(id: string): Promise<StoredRecommendation | null> {
  const { rows } = await db.query<Row>('SELECT * FROM ontology_recommendations WHERE id = $1', [id]);
  return rows[0] ? toStored(rows[0]) : null;
}
