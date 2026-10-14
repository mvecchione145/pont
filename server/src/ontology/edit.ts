import type { User } from '../auth.js';
import { backlinks } from './links.js';
import { listZones, toRef, zoneName } from './zones.js';
import {
  CONCEPT_TYPES,
  findConcept,
  readOntology,
  RELATION_TYPES,
  slugify,
  uniqueId,
  updateOntology,
  type Concept,
  type ConceptType,
  type Ontology,
  type Relation,
  type RelationType,
} from './store.js';

// Direct edits by people: creating, changing, and deleting concepts and
// relationships from their pages. (Agent suggestions go through the review
// queue instead.) Updates carry the "updatedAt" the editor started from, so
// two people editing the same item can't silently overwrite each other.

export class EditError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const by = (user: User) => user.name ?? user.username;
const text = (v: unknown, field: string, max = 2000): string => {
  if (typeof v !== 'string') throw new EditError(`"${field}" must be text.`);
  const t = v.trim();
  if (t.length > max) throw new EditError(`"${field}" is too long.`);
  return t;
};
const aliasList = (v: unknown): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new EditError('"aliases" must be a list.');
  return [...new Set(v.map((a) => text(a, 'aliases', 200)).filter(Boolean))];
};
const conceptType = (v: unknown): ConceptType => {
  if (!CONCEPT_TYPES.includes(v as ConceptType)) throw new EditError(`"type" must be one of: ${CONCEPT_TYPES.join(', ')}.`);
  return v as ConceptType;
};
const relationType = (v: unknown): RelationType => {
  if (!RELATION_TYPES.includes(v as RelationType)) throw new EditError(`"type" must be one of: ${RELATION_TYPES.join(', ')}.`);
  return v as RelationType;
};

function checkUnique(o: Ontology, name: string, aliases: string[], self?: string) {
  for (const n of [name, ...aliases]) {
    const clash = findConcept(o, n);
    if (clash && clash.id !== self) throw new EditError(`"${n}" is already used by the concept "${clash.name}".`, 409);
  }
}

function checkFresh(item: { updatedAt: string }, expected: unknown) {
  if (typeof expected === 'string' && expected !== item.updatedAt) {
    throw new EditError('Someone else changed this since you opened it. Reload to see their version.', 409);
  }
}

// --- Concepts ---------------------------------------------------------------

export async function createConcept(zone: string, body: Record<string, unknown>, user: User): Promise<Concept> {
  const name = text(body.name, 'name', 200);
  if (!name) throw new EditError('A concept needs a name.');
  const type = conceptType(body.type);
  const definition = body.definition === undefined ? '' : text(body.definition, 'definition');
  const aliases = aliasList(body.aliases).filter((a) => a.toLowerCase() !== name.toLowerCase());
  return updateOntology(zone, (o) => {
    checkUnique(o, name, aliases);
    const concept: Concept = {
      id: uniqueId(slugify(name), o.concepts.map((c) => c.id)),
      name,
      type,
      definition,
      aliases,
      sources: [],
      updatedBy: by(user),
      updatedAt: now(),
    };
    o.concepts.push(concept);
    return concept;
  });
}

export async function updateConcept(zone: string, id: string, body: Record<string, unknown>, user: User): Promise<Concept> {
  return updateOntology(zone, (o) => {
    const c = o.concepts.find((x) => x.id === id);
    if (!c) throw new EditError('No such concept.', 404);
    checkFresh(c, body.expectedUpdatedAt);
    const name = body.name === undefined ? c.name : text(body.name, 'name', 200);
    if (!name) throw new EditError('A concept needs a name.');
    const aliases = body.aliases === undefined ? c.aliases : aliasList(body.aliases);
    checkUnique(o, name, aliases, c.id);
    c.name = name;
    c.aliases = aliases.filter((a) => a.toLowerCase() !== name.toLowerCase());
    if (body.type !== undefined) c.type = conceptType(body.type);
    if (body.definition !== undefined) c.definition = text(body.definition, 'definition');
    c.updatedBy = by(user);
    c.updatedAt = now();
    return { ...c };
  });
}

export async function deleteConcept(zone: string, id: string): Promise<{ relationsRemoved: number }> {
  return updateOntology(zone, (o) => {
    if (!o.concepts.some((c) => c.id === id)) throw new EditError('No such concept.', 404);
    o.concepts = o.concepts.filter((c) => c.id !== id);
    const before = o.relations.length;
    o.relations = o.relations.filter((r) => r.from !== id && r.to !== id);
    return { relationsRemoved: before - o.relations.length };
  });
}

// --- Relationships -----------------------------------------------------------

function resolveConcept(o: Ontology, ref: unknown, field: string): Concept {
  const c = findConcept(o, text(ref, field, 200));
  if (!c) throw new EditError(`No concept "${String(ref)}" for "${field}".`, 400);
  return c;
}

export async function createRelation(zone: string, body: Record<string, unknown>, user: User): Promise<Relation> {
  const type = relationType(body.type);
  return updateOntology(zone, (o) => {
    const from = resolveConcept(o, body.from, 'from');
    const to = resolveConcept(o, body.to, 'to');
    if (from.id === to.id) throw new EditError('A concept cannot relate to itself.');
    if (o.relations.some((r) => r.from === from.id && r.to === to.id && r.type === type)) {
      throw new EditError('This relationship already exists.', 409);
    }
    const relation: Relation = {
      id: uniqueId(`${from.id}--${type}--${to.id}`, o.relations.map((r) => r.id)),
      from: from.id,
      type,
      to: to.id,
      ...(body.name ? { name: text(body.name, 'name', 200) } : {}),
      ...(body.description ? { description: text(body.description, 'description') } : {}),
      sources: [],
      updatedBy: by(user),
      updatedAt: now(),
    };
    o.relations.push(relation);
    return relation;
  });
}

export async function updateRelation(zone: string, id: string, body: Record<string, unknown>, user: User): Promise<Relation> {
  return updateOntology(zone, (o) => {
    const r = o.relations.find((x) => x.id === id);
    if (!r) throw new EditError('No such relationship.', 404);
    checkFresh(r, body.expectedUpdatedAt);
    if (body.from !== undefined) r.from = resolveConcept(o, body.from, 'from').id;
    if (body.to !== undefined) r.to = resolveConcept(o, body.to, 'to').id;
    if (r.from === r.to) throw new EditError('A concept cannot relate to itself.');
    if (body.type !== undefined) r.type = relationType(body.type);
    if (body.name !== undefined) {
      const name = text(body.name, 'name', 200);
      if (name) r.name = name;
      else delete r.name;
    }
    if (body.description !== undefined) {
      const description = text(body.description, 'description');
      if (description) r.description = description;
      else delete r.description;
    }
    r.updatedBy = by(user);
    r.updatedAt = now();
    return { ...r };
  });
}

export async function deleteRelation(zone: string, id: string): Promise<void> {
  await updateOntology(zone, (o) => {
    if (!o.relations.some((r) => r.id === id)) throw new EditError('No such relationship.', 404);
    o.relations = o.relations.filter((r) => r.id !== id);
  });
}

// --- Reading ------------------------------------------------------------------

const humanType = (t: string) => t.replace(/_/g, ' ');

export function relationLabel(o: Ontology, r: Relation): string {
  const name = (id: string) => o.concepts.find((c) => c.id === id)?.name ?? id;
  return r.name || `${name(r.from)} ${humanType(r.type)} ${name(r.to)}`;
}

export async function conceptDetail(zone: string, id: string) {
  const { ontology } = await readOntology(zone);
  const concept = ontology.concepts.find((c) => c.id === id);
  if (!concept) throw new EditError('No such concept.', 404);
  const name = (cid: string) => ontology.concepts.find((c) => c.id === cid)?.name ?? cid;
  const relations = ontology.relations
    .filter((r) => r.from === id || r.to === id)
    .map((r) => ({ ...r, label: relationLabel(ontology, r), fromName: name(r.from), toName: name(r.to) }));
  return { ...concept, zone, relations, linkedFrom: await backlinks('concept', toRef(zone, id)) };
}

export async function relationDetail(zone: string, id: string) {
  const { ontology } = await readOntology(zone);
  const r = ontology.relations.find((x) => x.id === id);
  if (!r) throw new EditError('No such relationship.', 404);
  const concept = (cid: string) => ontology.concepts.find((c) => c.id === cid);
  return {
    ...r,
    zone,
    label: relationLabel(ontology, r),
    fromConcept: concept(r.from) ?? null,
    toConcept: concept(r.to) ?? null,
    linkedFrom: await backlinks('relation', toRef(zone, id)),
  };
}

export interface OntologyHit {
  kind: 'concept' | 'relation';
  id: string;
  zone: string;
  zoneName: string;
  // What a link points to: "<zone>/<id>", or "<id>" in the default zone.
  ref: string;
  name: string;
  type: string;
  description: string;
}

// Autocomplete for linking: concepts and relationships in every zone whose
// name (or alias, or connected concepts) matches, best matches first. Items in
// the preferred zone (the linking page's) rank above equal matches elsewhere.
export async function searchOntology(query: string, preferredZone: string, limit = 8): Promise<OntologyHit[]> {
  const q = query.trim().toLowerCase();
  const score = (candidates: string[], extra = '') => {
    let best = 0;
    for (const c of candidates.map((x) => x.toLowerCase())) {
      if (!q) best = Math.max(best, 1);
      else if (c === q) best = Math.max(best, 100);
      else if (c.startsWith(q)) best = Math.max(best, 80);
      else if (c.split(/[\s\-_&/]+/).some((w) => w.startsWith(q))) best = Math.max(best, 60);
      else if (c.includes(q)) best = Math.max(best, 40);
    }
    if (!best && q && extra.toLowerCase().includes(q)) best = 10;
    return best;
  };
  const scored: { hit: OntologyHit; score: number }[] = [];
  for (const { zone } of await listZones()) {
    const { ontology } = await readOntology(zone);
    const bonus = zone === preferredZone ? 5 : 0;
    const at = (id: string) => ({ id, zone, zoneName: zoneName(zone), ref: toRef(zone, id) });
    for (const c of ontology.concepts) {
      const s = score([c.name, ...c.aliases], c.definition);
      if (s) scored.push({ score: s + 1 + bonus, hit: { kind: 'concept', ...at(c.id), name: c.name, type: c.type, description: c.definition } });
    }
    const conceptName = (id: string) => ontology.concepts.find((c) => c.id === id)?.name ?? '';
    for (const r of ontology.relations) {
      const label = relationLabel(ontology, r);
      // Name/label first; the concepts it connects count as a weaker match.
      const s = score([label, ...(r.name ? [r.name] : [])], r.description ?? '') || Math.min(30, score([conceptName(r.from), conceptName(r.to)]));
      if (s) {
        const fallback = `${humanType(r.type)}: ${relationLabel(ontology, { ...r, name: undefined })}`;
        scored.push({
          score: s + bonus,
          hit: { kind: 'relation', ...at(r.id), name: label, type: humanType(r.type), description: r.description || (r.name ? fallback : '') },
        });
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name))
    .slice(0, limit)
    .map((s) => s.hit);
}
