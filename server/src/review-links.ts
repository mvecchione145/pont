import type { Ontology } from './ontology/store.js';

// Finding ontology terms a page mentions but doesn't link. A mention counts
// only in plain text: not inside code, an existing link, a URL, or HTML. The
// page review asks the model which of these mentions really mean the concept
// (a generic "map" is not the "Map" concept), then a link is added around the
// first plain mention, as `[term](#/concept/<id>)`, the same Markdown the
// editor's link picker writes.

export type LinkKind = 'concept' | 'relation';

export interface LinkCandidate {
  kind: LinkKind;
  id: string;
  name: string;
  // Concept type, or "Relationship".
  type: string;
  description: string;
  // The names it goes by that appear unlinked on the page, as written there.
  mentions: string[];
}

const MAX_CANDIDATES = 40;

// Spans of the page that must never get a link added.
function protectedRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = [];
  const patterns = [
    /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, // fenced code
    /`[^`\n]+`/g, // inline code
    /!?\[[^\]\n]*\]\([^)\n]*\)/g, // links and images, text included
    /^\[[^\]\n]+\]:[^\n]*$/gm, // link reference definitions
    /<[^>\n]+>/g, // HTML tags and autolinks
    /\bhttps?:\/\/[^\s)]+/g, // bare URLs
  ];
  for (const pattern of patterns) {
    for (const m of markdown.matchAll(pattern)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Acronyms (all caps, like "ICS") match case-sensitively; other names don't.
const isAcronym = (term: string) => term === term.toUpperCase() && /\p{Lu}/u.test(term);

// The first plain-text mention of a term, as a whole word, or null.
export function findMention(markdown: string, term: string, ranges = protectedRanges(markdown)): { at: number; text: string } | null {
  const t = term.trim();
  if (t.length < 2) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(t).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`, isAcronym(t) ? 'gu' : 'giu');
  for (const m of markdown.matchAll(pattern)) {
    const end = m.index + m[0].length;
    if (!ranges.some(([a, b]) => m.index < b && end > a)) return { at: m.index, text: m[0] };
  }
  return null;
}

export const linkHref = (kind: LinkKind, id: string) => `#/${kind}/${id}`;

export const alreadyLinks = (markdown: string, kind: LinkKind, id: string) =>
  markdown.includes(`](${linkHref(kind, id)})`);

// Concepts and named relationships mentioned on the page but not linked yet,
// in the order they first appear.
export function linkCandidates(markdown: string, ontology: Ontology): LinkCandidate[] {
  const ranges = protectedRanges(markdown);
  const found: { candidate: LinkCandidate; first: number }[] = [];
  const consider = (kind: LinkKind, id: string, name: string, type: string, description: string, names: string[]) => {
    if (alreadyLinks(markdown, kind, id)) return;
    const mentions = names
      .map((n) => findMention(markdown, n, ranges))
      .filter((m): m is { at: number; text: string } => m !== null);
    if (!mentions.length) return;
    found.push({
      candidate: {
        kind,
        id,
        name,
        type,
        description: description.length > 160 ? `${description.slice(0, 157)}…` : description,
        mentions: [...new Set(mentions.map((m) => m.text))],
      },
      first: Math.min(...mentions.map((m) => m.at)),
    });
  };
  for (const c of ontology.concepts) consider('concept', c.id, c.name, c.type, c.definition, [c.name, ...c.aliases]);
  for (const r of ontology.relations) {
    if (r.name) consider('relation', r.id, r.name, 'Relationship', r.description ?? '', [r.name]);
  }
  return found
    .sort((a, b) => a.first - b.first)
    .slice(0, MAX_CANDIDATES)
    .map((f) => f.candidate);
}

// Wraps the first plain mention of the term in a link. Returns null when the
// term no longer appears unlinked.
export function addLink(markdown: string, term: string, kind: LinkKind, id: string): string | null {
  const m = findMention(markdown, term);
  if (!m) return null;
  return `${markdown.slice(0, m.at)}[${m.text}](${linkHref(kind, id)})${markdown.slice(m.at + m.text.length)}`;
}
