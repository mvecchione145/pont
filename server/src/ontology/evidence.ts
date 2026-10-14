import { getEntry } from '../entries.js';
import type { Source } from './store.js';
import { covers, zoneName } from './zones.js';

// Checks that each evidence quote really appears on its page, ignoring case
// and whitespace differences. "previous" holds earlier content that also
// counts (for example, a deleted or changed page's last analysed text).
// When a zone is given, every quote must come from a page that zone covers
// (any page, for General).
// Returns a message for the agent, or null when all quotes check out.

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export async function verifyEvidence(
  evidence: Source[],
  previous: Map<string, string> = new Map(),
  zone?: string,
): Promise<string | null> {
  if (evidence.length === 0) return 'Quote at least one passage as evidence.';
  for (const { path, quote } of evidence) {
    if (zone !== undefined && !covers(zone, path)) {
      return `Evidence page "${path}" is not in the "${zoneName(zone)}" zone; quote pages from that zone only.`;
    }
    if (quote.trim().length < 5) return `Evidence quote from "${path}" is too short.`;
    const versions: string[] = [];
    const earlier = previous.get(path);
    if (earlier !== undefined) versions.push(earlier);
    try {
      versions.push((await getEntry(path)).content);
    } catch {
      if (earlier === undefined) return `Evidence page "${path}" does not exist.`;
    }
    if (!versions.some((content) => normalize(content).includes(normalize(quote)))) {
      return `The quote "${clip(quote, 80)}" does not appear on "${path}". Copy the passage exactly.`;
    }
  }
  return null;
}
