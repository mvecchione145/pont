import { graph } from '../clients.js';

// Graph queries for agents: the neighbourhood of a concept, and how two
// concepts are connected. Relationships stay inside a zone, so traversals do
// too. Read-only.

export interface Neighbour {
  id: string;
  name: string;
  type: string;
  hops: number;
}

export interface Link {
  id: string;
  from: string;
  to: string;
  type: string;
  name: string | null;
}

export interface Neighbourhood {
  concept: { id: string; name: string; type: string; definition: string };
  neighbours: Neighbour[];
  relations: Link[];
  // Pages that link to the concept, and pages it was drawn from.
  linkedFrom: string[];
  sources: string[];
}

export const MAX_DEPTH = 3;
const MAX_NEIGHBOURS = 60;

async function read<T>(query: string, params: Record<string, unknown>, map: (r: import('neo4j-driver').Record) => T): Promise<T[]> {
  const session = graph.session({ defaultAccessMode: 'READ' });
  try {
    return (await session.run(query, params)).records.map(map);
  } finally {
    await session.close();
  }
}

export async function neighbourhood(zone: string, id: string, depth: number): Promise<Neighbourhood | null> {
  const d = Math.max(1, Math.min(MAX_DEPTH, Math.floor(depth)));
  const [centre] = await read(
    `MATCH (c:Concept {zone: $zone, id: $id})
     OPTIONAL MATCH (p:Page)-[:LINKS_TO]->(c) WHERE p.live
     WITH c, collect(DISTINCT p.path) AS linkedFrom
     OPTIONAL MATCH (c)-[:SOURCED_FROM]->(s:Page)
     RETURN c, linkedFrom, collect(DISTINCT s.path) AS sources`,
    { zone, id },
    (r) => ({ c: r.get('c').properties, linkedFrom: r.get('linkedFrom') as string[], sources: r.get('sources') as string[] }),
  );
  if (!centre) return null;

  // The depth is a validated integer: Cypher can't take it as a parameter.
  const neighbours = await read(
    `MATCH path = (c:Concept {zone: $zone, id: $id})-[:RELATES*1..${d}]-(n:Concept)
     WHERE n <> c
     WITH n, min(length(path)) AS hops
     RETURN n.id AS id, n.name AS name, n.type AS type, hops
     ORDER BY hops, name
     LIMIT ${MAX_NEIGHBOURS}`,
    { zone, id },
    (r) => ({ id: r.get('id') as string, name: r.get('name') as string, type: r.get('type') as string, hops: r.get('hops') as number }),
  );
  const ids = [id, ...neighbours.map((n) => n.id)];
  const relations = await read(
    `MATCH (a:Concept {zone: $zone})-[r:RELATES]->(b:Concept {zone: $zone})
     WHERE a.id IN $ids AND b.id IN $ids
     RETURN r.id AS id, a.id AS from, b.id AS to, r.type AS type, r.name AS name
     ORDER BY id`,
    { zone, ids },
    (r) => ({ id: r.get('id'), from: r.get('from'), to: r.get('to'), type: r.get('type'), name: r.get('name') ?? null }) as Link,
  );
  return {
    concept: { id: centre.c.id, name: centre.c.name, type: centre.c.type, definition: centre.c.definition ?? '' },
    neighbours,
    relations,
    linkedFrom: centre.linkedFrom.sort(),
    sources: centre.sources.sort(),
  };
}

export interface PathStep {
  from: string;
  to: string;
  type: string;
  name: string | null;
}

// The shortest chain of relationships between two concepts of a zone, in
// either direction; null when they aren't connected within maxHops.
export async function shortestPath(zone: string, fromId: string, toId: string, maxHops = 6): Promise<PathStep[] | null> {
  const hops = Math.max(1, Math.min(10, Math.floor(maxHops)));
  const [steps] = await read(
    `MATCH (a:Concept {zone: $zone, id: $from}), (b:Concept {zone: $zone, id: $to})
     MATCH path = shortestPath((a)-[:RELATES*..${hops}]-(b))
     RETURN [r IN relationships(path) | {from: startNode(r).name, to: endNode(r).name, type: r.type, name: r.name}] AS steps`,
    { zone, from: fromId, to: toId },
    (r) => r.get('steps') as PathStep[],
  );
  return steps ?? null;
}
