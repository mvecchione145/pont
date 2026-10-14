import { graph } from '../clients.js';
import { entryEvents, getEntry, listEntries, EntryError } from '../entries.js';
import { fromRef } from './zones.js';

// Backlinks: pages link to the ontology with ordinary Markdown links to
// #/concept/<ref> or #/relation/<ref>. Each page is a (:Page {path}) node in
// the graph that lists the refs it links to (conceptLinks, relationLinks) and
// has a LINKS_TO edge to every concept that exists, so a concept's page can
// list "Linked from" and agents can traverse from concepts to pages. Derived
// from the pages: updated on every save and delete, and rebuilt on start.
// Pages only cited as evidence stay as nodes with live = false.

export type LinkKind = 'concept' | 'relation';

const LINK = /\]\(\s*#\/(concept|relation)\/([^)\s?#]+)\s*\)/g;

export function parseLinks(markdown: string): { kind: LinkKind; target: string }[] {
  const found = new Map<string, { kind: LinkKind; target: string }>();
  for (const [, kind, raw] of markdown.matchAll(LINK)) {
    let target = raw;
    try {
      target = decodeURIComponent(raw);
    } catch {
      // keep the raw text
    }
    found.set(`${kind}:${target}`, { kind: kind as LinkKind, target });
  }
  return [...found.values()];
}

async function indexPage(path: string, content: string | null): Promise<void> {
  const links = content ? parseLinks(content) : [];
  const conceptLinks = links.filter((l) => l.kind === 'concept').map((l) => l.target);
  const relationLinks = links.filter((l) => l.kind === 'relation').map((l) => l.target);
  const session = graph.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `MERGE (p:Page {path: $path})
         SET p.live = $live, p.conceptLinks = $conceptLinks, p.relationLinks = $relationLinks
         WITH p
         OPTIONAL MATCH (p)-[l:LINKS_TO]->()
         DELETE l
         WITH DISTINCT p
         UNWIND $targets AS t
         MATCH (c:Concept {zone: t.zone, id: t.id})
         MERGE (p)-[:LINKS_TO]->(c)`,
        { path, live: content !== null, conceptLinks, relationLinks, targets: conceptLinks.map(fromRef) },
      );
      // A deleted page that nothing cites as evidence leaves the graph.
      if (content === null) {
        await tx.run('MATCH (p:Page {path: $path}) WHERE NOT ()-[:SOURCED_FROM]->(p) DETACH DELETE p', { path });
      }
    });
  } finally {
    await session.close();
  }
}

async function reindexPath(path: string): Promise<void> {
  try {
    await indexPage(path, (await getEntry(path)).content);
  } catch (err) {
    if (err instanceof EntryError && err.status === 404) await indexPage(path, null);
    else throw err;
  }
}

const log = (err: unknown) => console.error('ontology links:', err instanceof Error ? err.message : err);

export async function startLinkIndex(): Promise<void> {
  entryEvents.on('saved', (path) => void reindexPath(path).catch(log));
  entryEvents.on('deleted', (path) => void indexPage(path, null).catch(log));
  try {
    const live = new Set((await listEntries()).map((e) => e.path));
    const session = graph.session();
    try {
      // Pages that no longer exist: drop their links (and the node, unless
      // cited as evidence).
      await session.run(
        `MATCH (p:Page) WHERE NOT p.path IN $live
         OPTIONAL MATCH (p)-[l:LINKS_TO]->()
         DELETE l
         WITH DISTINCT p
         SET p.live = false, p.conceptLinks = [], p.relationLinks = []
         WITH p WHERE NOT ()-[:SOURCED_FROM]->(p)
         DETACH DELETE p`,
        { live: [...live] },
      );
    } finally {
      await session.close();
    }
    for (const path of live) await reindexPath(path);
  } catch (err) {
    log(err);
  }
}

export async function backlinks(kind: LinkKind, target: string): Promise<string[]> {
  const session = graph.session({ defaultAccessMode: 'READ' });
  try {
    const res = await session.run(
      `MATCH (p:Page) WHERE p.live AND $target IN (CASE $kind WHEN 'concept' THEN p.conceptLinks ELSE p.relationLinks END)
       RETURN p.path AS path ORDER BY path`,
      { kind, target },
    );
    return res.records.map((r) => r.get('path') as string);
  } finally {
    await session.close();
  }
}
