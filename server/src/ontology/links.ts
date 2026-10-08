import { db } from '../clients.js';
import { entryEvents, getEntry, listEntries, EntryError } from '../entries.js';

// Backlinks: pages link to the ontology with ordinary Markdown links to
// #/concept/<id> or #/relation/<id>. This index records which pages link
// where, so a concept's page can list "Linked from". It is derived from the
// pages, updated on every save and delete, and rebuilt on start.

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
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ontology_links WHERE path = $1', [path]);
    for (const { kind, target } of content ? parseLinks(content) : []) {
      await client.query('INSERT INTO ontology_links (path, kind, target) VALUES ($1, $2, $3)', [path, kind, target]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
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
    await db.query('DELETE FROM ontology_links');
    for (const entry of await listEntries()) await reindexPath(entry.path);
  } catch (err) {
    log(err);
  }
}

export async function backlinks(kind: LinkKind, target: string): Promise<string[]> {
  const { rows } = await db.query<{ path: string }>(
    'SELECT path FROM ontology_links WHERE kind = $1 AND target = $2 ORDER BY path',
    [kind, target],
  );
  return rows.map((r) => r.path);
}
