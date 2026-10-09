// Internal links in page Markdown, shared by the link picker's index, the
// dead-link check, and link updates when a page moves. Pages link to other
// pages as #/p/<path>[?section=<heading>] ("#/entry/" is the old spelling)
// and to the ontology as #/concept/<id> or #/relation/<id>. No imports, so
// entries.ts can use it too.

export type LinkTarget =
  | { kind: 'page'; path: string; section?: string }
  | { kind: 'concept' | 'relation'; id: string };

export interface FoundLink {
  text: string;
  href: string;
  target: LinkTarget;
  // Where the href sits in the Markdown, for rewriting it.
  hrefStart: number;
  hrefEnd: number;
}

const LINK = /(!?)\[([^\]\n]*)\]\(\s*(#\/[^)\s]*)\s*\)/g;
const CODE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$|`[^`\n]+`/gm;

// Inline Markdown to the text the editor renders.
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, '$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1')
    .trim();
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Mirrors the frontend router's parsing of #/p/..., #/concept/..., #/relation/...
export function parseHref(href: string): LinkTarget | null {
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

// Mirrors the frontend router's href() for pages.
export function pageHref(path: string, section?: string): string {
  const base = `#/p/${path.split('/').map(encodeURIComponent).join('/')}`;
  return section ? `${base}?${new URLSearchParams({ section })}` : base;
}

// Internal links outside code (images excluded).
export function internalLinks(markdown: string): FoundLink[] {
  const code = [...markdown.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length] as const);
  const links: FoundLink[] = [];
  for (const m of markdown.matchAll(LINK)) {
    if (m[1] || code.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const target = parseHref(m[3]);
    if (!target) continue;
    const hrefStart = m.index + m[0].indexOf(m[3], m[2].length + 2);
    links.push({ text: plainText(m[2]), href: m[3], target, hrefStart, hrefEnd: hrefStart + m[3].length });
  }
  return links;
}

// Pages a page links to.
export function linkedPages(markdown: string): Set<string> {
  const pages = new Set<string>();
  for (const link of internalLinks(markdown)) if (link.target.kind === 'page') pages.add(link.target.path);
  return pages;
}

// Points every link to page "from" (and its headings) at "to" instead.
export function rewritePageLinks(markdown: string, from: string, to: string): { content: string; count: number } {
  let content = markdown;
  let count = 0;
  // From the end, so earlier positions stay valid.
  for (const link of internalLinks(markdown).reverse()) {
    if (link.target.kind !== 'page' || link.target.path !== from) continue;
    content = content.slice(0, link.hrefStart) + pageHref(to, link.target.section) + content.slice(link.hrefEnd);
    count++;
  }
  return { content, count };
}
