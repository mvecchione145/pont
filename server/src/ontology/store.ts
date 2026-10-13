import type { ManagedTransaction } from 'neo4j-driver';
import { graph } from '../clients.js';

// The ontology: concepts and typed relationships between them, one ontology
// per zone, stored in Neo4j:
//
//   (:Concept {zone, id, name, type, definition, aliases, updatedBy, updatedAt})
//   (:Concept)-[:RELATES {id, type, name, description, sources, ...}]->(:Concept)
//   (:Concept)-[:SOURCED_FROM {quote, i}]->(:Page {path})   evidence
//   (:Page)-[:LINKS_TO]->(:Concept)                          links in pages (links.ts)
//   (:Zone {name})                                           serializes writes
//
// Code works on a zone's ontology as a whole (readOntology), and every change
// goes through updateOntology(), which runs in one transaction holding the
// zone's lock and writes only what changed, so two approvals at once can't
// overwrite each other.

export const CONCEPT_TYPES = ['Metric', 'Process', 'Decision', 'Policy', 'System', 'Team', 'Term'] as const;
export type ConceptType = (typeof CONCEPT_TYPES)[number];

export const RELATION_TYPES = [
  'calculated_from',
  'depends_on',
  'part_of',
  'owned_by',
  'uses',
  'related_to',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface Source {
  path: string;
  quote: string;
}

export interface Concept {
  id: string;
  name: string;
  type: ConceptType;
  definition: string;
  aliases: string[];
  sources: Source[];
  updatedBy: string;
  updatedAt: string;
}

export interface Relation {
  id: string;
  from: string;
  type: RelationType;
  to: string;
  // Optional, for relationships people refer to by name ("Peanut butter &
  // jelly") rather than as "from type to".
  name?: string;
  description?: string;
  sources: Source[];
  updatedBy: string;
  updatedAt: string;
}

export interface Ontology {
  version: 1;
  concepts: Concept[];
  relations: Relation[];
}

// Constraints and indexes, created on start (idempotent).
export async function ensureGraphSchema(): Promise<void> {
  const session = graph.session();
  try {
    for (const statement of [
      'CREATE CONSTRAINT concept_key IF NOT EXISTS FOR (c:Concept) REQUIRE (c.zone, c.id) IS UNIQUE',
      'CREATE CONSTRAINT page_path IF NOT EXISTS FOR (p:Page) REQUIRE p.path IS UNIQUE',
      'CREATE CONSTRAINT zone_name IF NOT EXISTS FOR (z:Zone) REQUIRE z.name IS UNIQUE',
      'CREATE INDEX concept_zone IF NOT EXISTS FOR (c:Concept) ON (c.zone)',
      'CREATE INDEX relates_id IF NOT EXISTS FOR ()-[r:RELATES]-() ON (r.id)',
    ]) {
      await session.run(statement);
    }
  } finally {
    await session.close();
  }
}

type Reader = Pick<ManagedTransaction, 'run'>;

async function readIn(tx: Reader, zone: string): Promise<Ontology> {
  const concepts = await tx.run(
    `MATCH (c:Concept {zone: $zone})
     OPTIONAL MATCH (c)-[s:SOURCED_FROM]->(p:Page)
     WITH c, s, p ORDER BY s.i
     RETURN c, collect(CASE WHEN p IS NULL THEN null ELSE {path: p.path, quote: s.quote} END) AS sources
     ORDER BY c.name`,
    { zone },
  );
  const relations = await tx.run(
    `MATCH (a:Concept {zone: $zone})-[r:RELATES]->(b:Concept {zone: $zone})
     RETURN r, a.id AS from, b.id AS to
     ORDER BY r.id`,
    { zone },
  );
  return {
    version: 1,
    concepts: concepts.records.map((rec) => {
      const p = rec.get('c').properties;
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        definition: p.definition ?? '',
        aliases: p.aliases ?? [],
        sources: rec.get('sources') as Source[],
        updatedBy: p.updatedBy ?? '',
        updatedAt: p.updatedAt ?? '',
      };
    }),
    relations: relations.records.map((rec) => {
      const p = rec.get('r').properties;
      return {
        id: p.id,
        from: rec.get('from'),
        type: p.type,
        to: rec.get('to'),
        ...(p.name ? { name: p.name } : {}),
        ...(p.description ? { description: p.description } : {}),
        sources: p.sources ? (JSON.parse(p.sources) as Source[]) : [],
        updatedBy: p.updatedBy ?? '',
        updatedAt: p.updatedAt ?? '',
      };
    }),
  };
}

export async function readOntology(zone: string): Promise<{ ontology: Ontology }> {
  const session = graph.session({ defaultAccessMode: 'READ' });
  try {
    return { ontology: await session.executeRead((tx) => readIn(tx, zone)) };
  } finally {
    await session.close();
  }
}

// Zones that have at least one concept.
export async function zonesWithConcepts(): Promise<string[]> {
  const session = graph.session({ defaultAccessMode: 'READ' });
  try {
    const res = await session.run('MATCH (c:Concept) RETURN DISTINCT c.zone AS zone');
    return res.records.map((r) => r.get('zone') as string);
  } finally {
    await session.close();
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Writes the difference between two versions of a zone's ontology.
async function writeDiff(tx: ManagedTransaction, zone: string, before: Ontology, after: Ontology): Promise<void> {
  const oldConcepts = new Map(before.concepts.map((c) => [c.id, c]));
  const newConcepts = new Map(after.concepts.map((c) => [c.id, c]));
  const oldRelations = new Map(before.relations.map((r) => [r.id, r]));
  const newRelations = new Map(after.relations.map((r) => [r.id, r]));

  // Relationships removed or changed (changed ones are re-created below).
  const dropRelations = before.relations
    .filter((r) => !same(r, newRelations.get(r.id)))
    .map((r) => r.id);
  if (dropRelations.length) {
    await tx.run(
      `MATCH (:Concept {zone: $zone})-[r:RELATES]->(:Concept {zone: $zone})
       WHERE r.id IN $ids DELETE r`,
      { zone, ids: dropRelations },
    );
  }

  const dropConcepts = before.concepts.filter((c) => !newConcepts.has(c.id)).map((c) => c.id);
  if (dropConcepts.length) {
    await tx.run('MATCH (c:Concept {zone: $zone}) WHERE c.id IN $ids DETACH DELETE c', { zone, ids: dropConcepts });
  }

  const upserts = after.concepts.filter((c) => !same(c, oldConcepts.get(c.id)));
  for (const c of upserts) {
    const isNew = !oldConcepts.has(c.id);
    await tx.run(
      `MERGE (c:Concept {zone: $zone, id: $id})
       SET c.name = $name, c.type = $type, c.definition = $definition, c.aliases = $aliases,
           c.updatedBy = $updatedBy, c.updatedAt = $updatedAt
       WITH c
       OPTIONAL MATCH (c)-[s:SOURCED_FROM]->()
       DELETE s
       WITH DISTINCT c
       UNWIND range(0, size($sources) - 1) AS i
       WITH c, i, $sources[i] AS src
       MERGE (p:Page {path: src.path})
         ON CREATE SET p.live = false, p.conceptLinks = [], p.relationLinks = []
       CREATE (c)-[:SOURCED_FROM {quote: src.quote, i: i}]->(p)`,
      {
        zone,
        id: c.id,
        name: c.name,
        type: c.type,
        definition: c.definition,
        aliases: c.aliases,
        updatedBy: c.updatedBy,
        updatedAt: c.updatedAt,
        sources: c.sources.map((s) => ({ path: s.path, quote: s.quote })),
      },
    );
    // Pages that already linked to this concept (for example before it was
    // deleted and created again) link to it in the graph too.
    if (isNew) {
      await tx.run(
        `MATCH (c:Concept {zone: $zone, id: $id}), (p:Page)
         WHERE $ref IN p.conceptLinks
         MERGE (p)-[:LINKS_TO]->(c)`,
        { zone, id: c.id, ref: zone ? `${zone}/${c.id}` : c.id },
      );
    }
  }

  for (const r of after.relations) {
    if (same(r, oldRelations.get(r.id))) continue;
    await tx.run(
      `MATCH (a:Concept {zone: $zone, id: $from}), (b:Concept {zone: $zone, id: $to})
       CREATE (a)-[:RELATES {id: $id, type: $type, name: $name, description: $description,
                             sources: $sources, updatedBy: $updatedBy, updatedAt: $updatedAt}]->(b)`,
      {
        zone,
        id: r.id,
        from: r.from,
        to: r.to,
        type: r.type,
        name: r.name ?? null,
        description: r.description ?? null,
        sources: JSON.stringify(r.sources),
        updatedBy: r.updatedBy,
        updatedAt: r.updatedAt,
      },
    );
  }
}

// Applies a change to the zone's latest ontology and saves it, in one
// transaction that holds the zone's lock. If the change throws, nothing is
// saved. (The driver may retry the transaction on a transient error, so the
// change must only modify the ontology it is given.)
export async function updateOntology<T>(zone: string, change: (ontology: Ontology) => T): Promise<T> {
  const session = graph.session();
  try {
    return await session.executeWrite(async (tx) => {
      // Writing the zone node takes its write lock until the transaction ends.
      await tx.run('MERGE (z:Zone {name: $zone}) SET z.lastWrite = datetime()', { zone });
      const before = await readIn(tx, zone);
      const after = structuredClone(before);
      const result = change(after);
      after.concepts.sort((a, b) => a.name.localeCompare(b.name));
      await writeDiff(tx, zone, before, after);
      return result;
    });
  } finally {
    await session.close();
  }
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'concept'
  );
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

// Finds a concept by id, name, or alias (case-insensitive).
export function findConcept(ontology: Ontology, ref: string): Concept | undefined {
  const key = ref.trim().toLowerCase();
  return (
    ontology.concepts.find((c) => c.id === key) ??
    ontology.concepts.find((c) => c.name.toLowerCase() === key) ??
    ontology.concepts.find((c) => c.aliases.some((a) => a.toLowerCase() === key))
  );
}
