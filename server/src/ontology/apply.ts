import { db } from '../clients.js';
import type { User } from '../auth.js';
import { getRecommendation, type StoredRecommendation } from './recommendations.js';
import {
  CONCEPT_TYPES,
  findConcept,
  RELATION_TYPES,
  slugify,
  uniqueId,
  updateOntology,
  type ConceptType,
  type Ontology,
  type RelationType,
  type Source,
} from './store.js';

// Approving a recommendation applies it to the ontology, after checking it
// still makes sense against the ontology as it is now (an earlier approval
// may have renamed, merged, or deleted what it refers to). If it no longer
// applies, it is marked "failed" with the reason, and nothing changes.

export class ApplyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
    // True when the recommendation may apply later (for example once the
    // concepts it connects are approved): it stays pending instead of failing.
    readonly keepPending = false,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function mergeSources(existing: Source[], added: Source[]): Source[] {
  const key = (s: Source) => `${s.path}\u0000${s.quote}`;
  const seen = new Set(existing.map(key));
  return [...existing, ...added.filter((s) => !seen.has(key(s)))];
}

function applyTo(ontology: Ontology, rec: StoredRecommendation, by: string): string {
  const p = rec.payload;
  const conceptRef = (ref: unknown) => {
    const c = findConcept(ontology, str(ref));
    if (!c) throw new ApplyError(`Concept "${str(ref)}" no longer exists.`);
    return c;
  };

  switch (rec.action) {
    case 'create_concept': {
      const name = str(p.name);
      const type = p.type as ConceptType;
      if (!name || !CONCEPT_TYPES.includes(type)) throw new ApplyError('This recommendation is malformed.', 400);
      const existing = findConcept(ontology, name);
      if (existing) throw new ApplyError(`"${name}" already exists as "${existing.name}".`);
      const id = uniqueId(slugify(name), ontology.concepts.map((c) => c.id));
      ontology.concepts.push({
        id,
        name,
        type,
        definition: str(p.definition),
        aliases: strings(p.aliases).filter((a) => a.toLowerCase() !== name.toLowerCase()),
        sources: rec.evidence,
        updatedBy: by,
        updatedAt: now(),
      });
      return `Added concept "${name}".`;
    }
    case 'update_concept': {
      const c = conceptRef(p.conceptId);
      if (p.name !== undefined) {
        const clash = findConcept(ontology, str(p.name));
        if (clash && clash.id !== c.id) throw new ApplyError(`Another concept is already called "${str(p.name)}".`);
        c.name = str(p.name) || c.name;
      }
      if (p.type !== undefined) {
        if (!CONCEPT_TYPES.includes(p.type as ConceptType)) throw new ApplyError('Unknown concept type.', 400);
        c.type = p.type as ConceptType;
      }
      if (p.definition !== undefined) c.definition = str(p.definition);
      if (p.aliases !== undefined) c.aliases = strings(p.aliases);
      c.sources = mergeSources(c.sources, rec.evidence);
      c.updatedBy = by;
      c.updatedAt = now();
      return `Updated concept "${c.name}".`;
    }
    case 'delete_concept': {
      const c = conceptRef(p.conceptId);
      ontology.concepts = ontology.concepts.filter((x) => x.id !== c.id);
      const before = ontology.relations.length;
      ontology.relations = ontology.relations.filter((r) => r.from !== c.id && r.to !== c.id);
      const dropped = before - ontology.relations.length;
      return `Deleted concept "${c.name}"${dropped ? ` and ${dropped} relationship(s) that used it` : ''}.`;
    }
    case 'add_alias': {
      const c = conceptRef(p.conceptId);
      const alias = str(p.alias);
      const clash = findConcept(ontology, alias);
      if (clash && clash.id !== c.id) throw new ApplyError(`"${alias}" already names "${clash.name}".`);
      if (!c.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) c.aliases.push(alias);
      c.sources = mergeSources(c.sources, rec.evidence);
      c.updatedBy = by;
      c.updatedAt = now();
      return `Added alias "${alias}" to "${c.name}".`;
    }
    case 'create_relation': {
      const type = p.type as RelationType;
      if (!RELATION_TYPES.includes(type)) throw new ApplyError('Unknown relationship type.', 400);
      const from = findConcept(ontology, str(p.from));
      const to = findConcept(ontology, str(p.to));
      const missing = [!from && str(p.from), !to && str(p.to)].filter(Boolean);
      if (missing.length) {
        throw new ApplyError(
          `Approve the concept${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(' and ')} first.`,
          409,
          true,
        );
      }
      if (ontology.relations.some((r) => r.from === from!.id && r.to === to!.id && r.type === type)) {
        throw new ApplyError('This relationship already exists.');
      }
      const id = uniqueId(`${from!.id}--${type}--${to!.id}`, ontology.relations.map((r) => r.id));
      ontology.relations.push({ id, from: from!.id, type, to: to!.id, sources: rec.evidence, updatedBy: by, updatedAt: now() });
      return `Added: ${from!.name} ${type.replace(/_/g, ' ')} ${to!.name}.`;
    }
    case 'delete_relation': {
      const id = str(p.relationId);
      if (!ontology.relations.some((r) => r.id === id)) throw new ApplyError('That relationship no longer exists.');
      ontology.relations = ontology.relations.filter((r) => r.id !== id);
      return 'Deleted the relationship.';
    }
  }
}

async function decide(id: string, status: 'approved' | 'rejected' | 'failed', user: User, error: string | null = null) {
  await db.query(
    `UPDATE ontology_recommendations SET status = $2, decided_by = $3, decided_at = now(), error = $4
     WHERE id = $1`,
    [id, status, user.name ?? user.username, error],
  );
}

async function pending(id: string): Promise<StoredRecommendation> {
  const rec = await getRecommendation(id);
  if (!rec) throw new ApplyError('No such recommendation.', 404);
  if (rec.status !== 'pending') throw new ApplyError(`This recommendation was already ${rec.status}.`);
  return rec;
}

export async function approve(id: string, user: User): Promise<{ status: 'approved' | 'failed'; message: string }> {
  const rec = await pending(id);
  try {
    const message = await updateOntology((ontology) => applyTo(ontology, rec, user.name ?? user.username));
    await decide(id, 'approved', user);
    return { status: 'approved', message };
  } catch (err) {
    if (!(err instanceof ApplyError) || err.status === 404 || err.keepPending) throw err;
    await decide(id, 'failed', user, err.message);
    return { status: 'failed', message: err.message };
  }
}

export async function reject(id: string, user: User): Promise<void> {
  await pending(id);
  await decide(id, 'rejected', user);
}

// Approving or rejecting many at once ("Approve all" after a calculation).
// Approvals run in dependency order: new concepts before the aliases, updates,
// and relationships that refer to them, and deletions last, so one approval
// doesn't fail just because another in the same batch hadn't run yet. A
// relationship still waiting on a concept gets one more try at the end.

const ORDER: Record<StoredRecommendation['action'], number> = {
  create_concept: 0,
  add_alias: 1,
  update_concept: 1,
  create_relation: 2,
  delete_relation: 3,
  delete_concept: 4,
};

export interface BulkResult {
  id: string;
  status: 'approved' | 'rejected' | 'failed' | 'pending';
  message: string;
}

export const MAX_BULK = 500;

export async function decideMany(action: 'approve' | 'reject', ids: string[], user: User): Promise<BulkResult[]> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BULK) throw new ApplyError(`At most ${MAX_BULK} at a time.`, 400);
  const results = new Map<string, BulkResult>();
  const recs: StoredRecommendation[] = [];
  for (const id of unique) {
    const rec = await getRecommendation(id);
    if (!rec) results.set(id, { id, status: 'failed', message: 'No such recommendation.' });
    else if (rec.status !== 'pending') results.set(id, { id, status: 'failed', message: `Already ${rec.status}.` });
    else recs.push(rec);
  }

  if (action === 'reject') {
    for (const rec of recs) {
      await decide(rec.id, 'rejected', user);
      results.set(rec.id, { id: rec.id, status: 'rejected', message: 'Rejected.' });
    }
  } else {
    const tryApprove = async (rec: StoredRecommendation): Promise<BulkResult> => {
      try {
        return { id: rec.id, ...(await approve(rec.id, user)) };
      } catch (err) {
        if (err instanceof ApplyError && err.keepPending) return { id: rec.id, status: 'pending', message: err.message };
        throw err;
      }
    };
    const sorted = [...recs].sort((a, b) => ORDER[a.action] - ORDER[b.action]);
    const waiting: StoredRecommendation[] = [];
    for (const rec of sorted) {
      const r = await tryApprove(rec);
      results.set(rec.id, r);
      if (r.status === 'pending') waiting.push(rec);
    }
    for (const rec of waiting) results.set(rec.id, await tryApprove(rec));
  }
  return unique.map((id) => results.get(id)!);
}
