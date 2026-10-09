import { entryEvents, EntryError, getEntry, listEntries } from './entries.js';

// Links between pages. A page links to another page, or to a heading in a
// page (its own or another), with an ordinary Markdown link:
//
//   [Onboarding](#/p/processes/onboarding)
//   [who to call](#/p/processes/onboarding?section=Escalation)
//
// The editor's link picker searches pages and headings to build these. This
// keeps every page's headings in memory for that search: built on start and
// updated on every save and delete.

export interface Heading {
  level: number;
  // Plain text, as the editor shows it (inline Markdown removed).
  text: string;
  // Parent headings and this one, e.g. ["Pricing", "Team plan"].
  trail: string[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

// Inline Markdown to the text the editor renders.
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, '$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1')
    .trim();
}

export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const stack: { level: number; text: string }[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = !inFence && HEADING.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const text = plainText(match[2]);
    if (!text) continue;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text });
    headings.push({ level, text, trail: stack.map((h) => h.text) });
  }
  return headings;
}

const index = new Map<string, Heading[]>();

async function reindex(path: string): Promise<void> {
  try {
    index.set(path, extractHeadings((await getEntry(path)).content));
  } catch (err) {
    if (err instanceof EntryError && err.status === 404) index.delete(path);
    else throw err;
  }
}

const log = (err: unknown) => console.error('page links:', err instanceof Error ? err.message : err);

export async function startPageLinkIndex(): Promise<void> {
  entryEvents.on('saved', (path) => void reindex(path).catch(log));
  entryEvents.on('deleted', (path) => index.delete(path));
  try {
    for (const entry of await listEntries()) await reindex(entry.path);
  } catch (err) {
    log(err);
  }
}

// --- Search --------------------------------------------------------------------

export interface LinkTarget {
  kind: 'page' | 'section';
  path: string;
  // The page name, or the heading text: what a new link would say.
  name: string;
  // For a section: its parent headings, e.g. "Pricing › Team plan".
  trail?: string;
  level?: number;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function score(candidate: string, q: string): number {
  const c = candidate.toLowerCase();
  if (!q) return 1;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80;
  if (c.split(/[\s\-_/.]+/).some((w) => w.startsWith(q))) return 60;
  if (c.includes(q)) return 40;
  return 0;
}

// What the link picker shows for a query:
//   "onboard"           pages and headings matching "onboard"
//   "#escal"            headings on the current page ("from") matching "escal"
//   "onboarding#escal"  headings matching "escal" on pages matching "onboarding"
export function searchLinkTargets(query: string, from?: string, limit = 10): LinkTarget[] {
  const raw = query.trim();
  const hash = raw.indexOf('#');
  const pageQuery = (hash >= 0 ? raw.slice(0, hash) : raw).trim().toLowerCase();
  const headingQuery = (hash >= 0 ? raw.slice(hash + 1) : raw).trim().toLowerCase();
  const scored: { target: LinkTarget; score: number }[] = [];

  // Which pages' headings to search, and how well each page matched.
  const pages = [...index.keys()]
    .map((path) => ({ path, score: Math.max(score(nameOf(path), pageQuery), score(path, pageQuery) * 0.9) }))
    .filter((p) => (hash < 0 ? true : pageQuery ? p.score > 0 : p.path === from));

  if (hash < 0) {
    for (const p of pages) {
      if (p.score > 0) scored.push({ score: p.score + 1, target: { kind: 'page', path: p.path, name: nameOf(p.path) } });
    }
  }
  for (const p of pages) {
    for (const h of index.get(p.path) ?? []) {
      const s = score(h.text, headingQuery);
      if (!s) continue;
      // The current page's headings first, then better-matching pages.
      const bonus = p.path === from ? 5 : hash >= 0 ? p.score / 10 : 0;
      scored.push({
        score: s + bonus - h.level * 0.1,
        target: {
          kind: 'section',
          path: p.path,
          name: h.text,
          trail: h.trail.slice(0, -1).join(' › ') || undefined,
          level: h.level,
        },
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.target.name.localeCompare(b.target.name))
    .slice(0, limit)
    .map((s) => s.target);
}
