import type { User } from './auth.js';
import { EntryError, entryEvents, getEntry, saveEntry } from './entries.js';
import { rewritePageLinks } from './markdown-links.js';
import { pagesLinkingTo } from './pagelinks.js';

// When a page is moved or renamed, links to it on other pages are pointed at
// its new path, headings included, so they don't break. Each changed page gets
// a new version by the person who moved the page, marked in its history.
// (The moved page's links to itself are rewritten by the move itself.) A link
// this misses, for example because its page was being saved at the same
// moment, shows up as a dead link with the new path suggested.

const ATTEMPTS = 3;

async function updatePage(path: string, from: string, to: string, user: User): Promise<number> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let entry;
    try {
      entry = await getEntry(path);
    } catch (err) {
      if (err instanceof EntryError && err.status === 404) return 0;
      throw err;
    }
    const { content, count } = rewritePageLinks(entry.content, from, to);
    if (!count) return 0;
    try {
      await saveEntry(path, content, entry.versionId ?? null, user, { 'links-moved-from': encodeURIComponent(from) });
      return count;
    } catch (err) {
      // Someone saved the page meanwhile: read it again and retry.
      if (!(err instanceof EntryError && err.status === 409) || attempt === ATTEMPTS) throw err;
    }
  }
  return 0;
}

export async function updateLinksAfterMove(from: string, to: string, user: User): Promise<{ pages: number; links: number }> {
  let pages = 0;
  let links = 0;
  for (const path of pagesLinkingTo(from)) {
    if (path === from || path === to) continue;
    try {
      const n = await updatePage(path, from, to, user);
      if (n) {
        pages++;
        links += n;
      }
    } catch (err) {
      console.error(`link update in "${path}" after moving "${from}":`, err instanceof Error ? err.message : err);
    }
  }
  if (links) console.log(`moved "${from}" to "${to}": updated ${links} link(s) on ${pages} page(s)`);
  return { pages, links };
}

export function startLinkUpdates(): void {
  entryEvents.on('moved', (from, to, user) => void updateLinksAfterMove(from, to, user));
}
