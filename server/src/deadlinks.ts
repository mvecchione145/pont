import { db } from './clients.js';
import type { User } from './auth.js';
import { EntryError, entryEvents, getEntry, listEntries, saveEntry } from './entries.js';
import { hasHistory, listVersions } from './history.js';
import { findConcept, readOntology, type Ontology } from './ontology/store.js';
import { headingsOf, plainText } from './pagelinks.js';

// Dead links: internal links whose destination is gone. Pages link to other
// pages and headings as #/p/<path>[?section=<heading>] and to the ontology as
// #/concept/<id> or #/relation/<id> (see pagelinks.ts and the editor). A link
// breaks when its page is moved or deleted, its heading renamed, or its
// concept deleted. For each one this suggests where it should point now:
// where the page was moved to (from page_moves), the closest heading, or a
// concept with the link's text as its name. Nothing changes until someone
// applies a fix. No LLM is involved.

export class LinkFixError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

// --- Moves ---------------------------------------------------------------------

async function recordMove(from: string, to: string, at?: string) {
  await db.query(
    `INSERT INTO page_moves (from_path, to_path, moved_at) VALUES ($1, $2, COALESCE($3::timestamptz, now()))
     ON CONFLICT (from_path, to_path) DO UPDATE SET moved_at = GREATEST(page_moves.moved_at, EXCLUDED.moved_at)`,
    [from, to, at ?? null],
  );
}

const BACKFILL_KEY = 'page_moves_backfilled';

// Records moves from now on, and once, the moves already in page history.
export async function startMoveTracking(): Promise<void> {
  entryEvents.on('moved', (from, to) => void recordMove(from, to).catch((err) => console.error('page moves:', err)));
  try {
    const { rows } = await db.query('SELECT 1 FROM settings WHERE key = $1', [BACKFILL_KEY]);
    if (rows.length) return;
    for (const entry of await listEntries()) {
      for (const v of await listVersions(entry.path)) {
        if (v.movedFrom && v.movedFrom !== entry.path) await recordMove(v.movedFrom, entry.path, v.modifiedAt);
      }
    }
    await db.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, 'true', 'pont') ON CONFLICT (key) DO NOTHING`,
      [BACKFILL_KEY],
    );
  } catch (err) {
    console.error('page moves backfill:', err instanceof Error ? err.message : err);
  }
}

// Where a page that no longer exists ended up, following chains of moves.
async function movedTo(path: string, exists: (p: string) => boolean): Promise<string | null> {
  let current = path;
  const seen = new Set([path]);
  for (let hops = 0; hops < 10; hops++) {
    const { rows } = await db.query<{ to_path: string }>(
      'SELECT to_path FROM page_moves WHERE from_path = $1 ORDER BY moved_at DESC LIMIT 1',
      [current],
    );
    const next = rows[0]?.to_path;
    if (!next || seen.has(next)) return null;
    if (exists(next)) return next;
    seen.add(next);
    current = next;
  }
  return null;
}

// --- Finding links -----------------------------------------------------------------

type Target =
  | { kind: 'page'; path: string; section?: string }
  | { kind: 'concept' | 'relation'; id: string };

interface FoundLink {
  text: string;
  href: string;
  target: Target;
}

const LINK = /(!?)\[([^\]\n]*)\]\(\s*(#\/[^)\s]*)\s*\)/g;
const CODE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$|`[^`\n]+`/gm;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Mirrors the frontend router's parsing of #/p/..., #/concept/..., #/relation/...
export function parseHref(href: string): Target | null {
  const [location, query = ''] = href.replace(/^#/, '').split('?');
  const [, view = '', ...rest] = location.split('/');
  const path = rest.map(decode).join('/');
  if (!path) return null;
  if (view === 'p' || view === 'entry') {
    const section = new URLSearchParams(query).get('section') ?? undefined;
    return { kind: 'page', path, section };
  }
  if (view === 'concept' || view === 'relation') return { kind: view, id: path };
  return null;
}

export function internalLinks(markdown: string): FoundLink[] {
  const code = [...markdown.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length] as const);
  const links: FoundLink[] = [];
  for (const m of markdown.matchAll(LINK)) {
    if (m[1] || code.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const target = parseHref(m[3]);
    if (target) links.push({ text: plainText(m[2]), href: m[3], target });
  }
  return links;
}

// --- Similarity -------------------------------------------------------------------

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Dice coefficient over character bigrams: 1 for identical, 0 for nothing shared.
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let shared = 0;
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0);
  const total = [...gx.values()].reduce((a, n) => a + n, 0) + [...gy.values()].reduce((a, n) => a + n, 0);
  return total ? (2 * shared) / total : 0;
}

function closest<T>(items: T[], label: (t: T) => string, wanted: string, min: number): T | null {
  let best: T | null = null;
  let bestScore = min;
  for (const item of items) {
    const s = similarity(label(item), wanted);
    if (s >= bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
}

// --- Checking ----------------------------------------------------------------------

export type Problem = 'page_moved' | 'page_deleted' | 'page_missing' | 'heading_missing' | 'concept_missing' | 'relation_missing';

export interface DeadLink {
  // The link's destination as written; every link with this href is fixed together.
  href: string;
  text: string;
  // How many links on the page point here.
  count: number;
  problem: Problem;
  message: string;
  suggestion: { href: string; label: string; reason: string } | null;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const pageHref = (path: string, section?: string) => {
  const base = `#/p/${path.split('/').map(encodeURIComponent).join('/')}`;
  return section ? `${base}?${new URLSearchParams({ section })}` : base;
};

interface Context {
  pages: Set<string>;
  ontology: Ontology;
  // Per-check caches: the same target is often linked from many pages.
  moves: Map<string, Promise<string | null>>;
  history: Map<string, Promise<boolean>>;
}

async function context(): Promise<Context> {
  const [entries, { ontology }] = await Promise.all([listEntries(), readOntology()]);
  return { pages: new Set(entries.map((e) => e.path)), ontology, moves: new Map(), history: new Map() };
}

const cached = <T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
  if (!map.has(key)) map.set(key, load());
  return map.get(key)!;
};

// The heading part of a link: fine, or the closest heading to suggest.
function checkHeading(path: string, section: string): { ok: true } | { ok: false; closest: string | null } {
  const headings = headingsOf(path);
  // Not indexed yet (the server is starting): don't call it broken.
  if (!headings) return { ok: true };
  const wanted = normalize(section);
  if (headings.some((h) => normalize(h.text) === wanted)) return { ok: true };
  const best = closest(headings, (h) => h.text, section, 0.5);
  return { ok: false, closest: best?.text ?? null };
}

async function checkLink(link: FoundLink, ctx: Context): Promise<Omit<DeadLink, 'count'> | null> {
  const t = link.target;
  if (t.kind === 'concept' || t.kind === 'relation') {
    const items = t.kind === 'concept' ? ctx.ontology.concepts : ctx.ontology.relations;
    if (items.some((i) => i.id === t.id)) return null;
    let suggestion: DeadLink['suggestion'] = null;
    if (t.kind === 'concept') {
      const match =
        findConcept(ctx.ontology, link.text) ?? closest(ctx.ontology.concepts, (c) => c.name, link.text || t.id, 0.6);
      if (match) {
        suggestion = {
          href: `#/concept/${encodeURIComponent(match.id)}`,
          label: match.name,
          reason: normalize(match.name) === normalize(link.text) ? 'A concept with this name exists.' : 'The closest concept by name.',
        };
      }
    } else {
      const named = ctx.ontology.relations.filter((r) => r.name);
      const match = closest(named, (r) => r.name!, link.text, 0.6);
      if (match) suggestion = { href: `#/relation/${encodeURIComponent(match.id)}`, label: match.name!, reason: 'The closest relationship by name.' };
    }
    return {
      href: link.href,
      text: link.text,
      problem: t.kind === 'concept' ? 'concept_missing' : 'relation_missing',
      message: `The ${t.kind === 'concept' ? 'concept' : 'relationship'} "${t.id}" no longer exists in the ontology.`,
      suggestion,
    };
  }

  // A page, maybe with a heading.
  if (t.kind !== 'page') return null;
  if (ctx.pages.has(t.path)) {
    if (!t.section) return null;
    const heading = checkHeading(t.path, t.section);
    if (heading.ok) return null;
    return {
      href: link.href,
      text: link.text,
      problem: 'heading_missing',
      message: `"${t.path}" has no heading "${t.section}" any more.`,
      suggestion: heading.closest
        ? { href: pageHref(t.path, heading.closest), label: `${nameOf(t.path)} › ${heading.closest}`, reason: 'The closest heading on that page.' }
        : { href: pageHref(t.path), label: nameOf(t.path), reason: 'Link to the page instead of the heading.' },
    };
  }

  const exists = (p: string) => ctx.pages.has(p);
  const moved = await cached(ctx.moves, t.path, () => movedTo(t.path, exists));
  if (moved) {
    let section = t.section;
    let note = '';
    if (section) {
      const heading = checkHeading(moved, section);
      if (!heading.ok) {
        section = heading.closest ?? undefined;
        note = heading.closest ? ` (closest heading: "${heading.closest}")` : ' (the heading is gone, so to the page)';
      }
    }
    return {
      href: link.href,
      text: link.text,
      problem: 'page_moved',
      message: `"${t.path}" was moved to "${moved}".`,
      suggestion: { href: pageHref(moved, section), label: section ? `${nameOf(moved)} › ${section}` : moved, reason: `Where the page was moved${note}.` },
    };
  }

  const existed = await cached(ctx.history, t.path, () => hasHistory(t.path));
  // A page with the same name somewhere else is a likely new home.
  const sameName = [...ctx.pages].filter((p) => nameOf(p).toLowerCase() === nameOf(t.path).toLowerCase());
  const elsewhere = sameName.length === 1 ? sameName[0] : closest([...ctx.pages], nameOf, nameOf(t.path), 0.8);
  return {
    href: link.href,
    text: link.text,
    problem: existed ? 'page_deleted' : 'page_missing',
    message: existed ? `"${t.path}" was deleted.` : `There is no page "${t.path}".`,
    suggestion: elsewhere
      ? { href: pageHref(elsewhere), label: elsewhere, reason: sameName.length === 1 ? 'A page with the same name.' : 'A page with a similar name.' }
      : null,
  };
}

async function checkContent(markdown: string, ctx: Context): Promise<DeadLink[]> {
  const byHref = new Map<string, { link: FoundLink; count: number }>();
  for (const link of internalLinks(markdown)) {
    const entry = byHref.get(link.href);
    if (entry) entry.count++;
    else byHref.set(link.href, { link, count: 1 });
  }
  const dead: DeadLink[] = [];
  for (const { link, count } of byHref.values()) {
    const problem = await checkLink(link, ctx);
    if (problem) dead.push({ ...problem, count });
  }
  return dead;
}

export async function deadLinksIn(path: string): Promise<DeadLink[]> {
  const ctx = await context();
  if (!ctx.pages.has(path)) throw new LinkFixError(`No page "${path}".`, 404);
  return checkContent((await getEntry(path)).content, ctx);
}

// --- Fixing -------------------------------------------------------------------------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Repoints every link to "href" on the page to "to", or (without "to") turns
// those links back into plain text. Saves a new version of the page.
export async function fixLinks(path: string, href: string, to: string | null, user: User) {
  if (!href.startsWith('#/')) throw new LinkFixError('Only internal links can be fixed here.');
  if (to !== null && (!to.startsWith('#/') || /[\s)]/.test(to))) throw new LinkFixError('The new destination must be an internal link.');
  let entry;
  try {
    entry = await getEntry(path);
  } catch (err) {
    if (err instanceof EntryError && err.status === 404) throw new LinkFixError(`No page "${path}".`, 404);
    throw err;
  }
  const pattern = new RegExp(`(?<!!)\\[([^\\]\\n]*)\\]\\(\\s*${escape(href)}\\s*\\)`, 'g');
  let count = 0;
  const updated = entry.content.replace(pattern, (_m, text: string) => {
    count++;
    return to === null ? text : `[${text}](${to})`;
  });
  if (!count) throw new LinkFixError('That link is no longer on the page.', 409);
  const saved = await saveEntry(path, updated, entry.versionId ?? null, user, { 'link-fix': '1' });
  return { versionId: saved.versionId ?? null, fixed: count };
}
