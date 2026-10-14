// Splits a Markdown entry into search chunks: by headings first, with a size
// cap. Ideas borrowed from Onyx: a document that fits in one chunk is never
// split, and every chunk is embedded with its document title (plus, in pont,
// its heading path) so it keeps its context once separated from the page.

export interface Chunk {
  index: number;
  // Headings from the top of the page down to this chunk, e.g. ["Pricing", "Team plan"].
  headings: string[];
  // The chunk's Markdown, as shown in search results.
  content: string;
  // What gets embedded: title and heading path, then the content.
  embeddingText: string;
}

export interface ChunkOptions {
  // Content budget per chunk, in tokens (the title prefix comes on top).
  maxTokens: number;
  countTokens: (text: string) => number;
}

interface Section {
  headings: string[];
  text: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

// Splits the document into sections at each heading, ignoring "#" lines
// inside fenced code blocks.
function sections(markdown: string): Section[] {
  const result: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let lines: string[] = [];
  let headings: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = lines.join('\n').trim();
    if (text) result.push({ headings, text });
    lines = [];
  };

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = !inFence && HEADING.exec(line);
    if (match) {
      flush();
      const level = match[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: match[2] });
      headings = stack.map((h) => h.text);
    }
    lines.push(line);
  }
  flush();
  return result;
}

// Splits text that is too long into pieces of at most maxTokens: by blank-line
// paragraphs (keeping code fences whole), then sentences, then words.
function splitLong(text: string, opts: ChunkOptions): string[] {
  if (opts.countTokens(text) <= opts.maxTokens) return [text];

  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '' && current.length) {
      paragraphs.push(current.join('\n'));
      current = [];
    } else if (line.trim() !== '' || inFence) {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current.join('\n'));
  // Keep a section's heading line with the paragraph that follows it.
  if (paragraphs.length > 1 && HEADING.test(paragraphs[0])) {
    paragraphs.splice(0, 2, `${paragraphs[0]}\n\n${paragraphs[1]}`);
  }

  const sentences = (text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
  const units = paragraphs.length > 1 ? paragraphs : sentences;
  const joiner = paragraphs.length > 1 ? '\n\n' : ' ';

  // A single unit that can't be split further is cut by words.
  if (units.length === 1) {
    const words = text.split(/\s+/);
    const half = Math.ceil(words.length / 2);
    return [
      ...splitLong(words.slice(0, half).join(' '), opts),
      ...splitLong(words.slice(half).join(' '), opts),
    ];
  }

  return pack(units, joiner, opts).flatMap((piece) => splitLong(piece, opts));
}

// Greedily packs consecutive pieces into groups that fit the budget.
function pack(pieces: string[], joiner: string, opts: ChunkOptions): string[] {
  const groups: string[] = [];
  let group = '';
  for (const piece of pieces) {
    const candidate = group ? `${group}${joiner}${piece}` : piece;
    if (group && opts.countTokens(candidate) > opts.maxTokens) {
      groups.push(group);
      group = piece;
    } else {
      group = candidate;
    }
  }
  if (group) groups.push(group);
  return groups;
}

export function chunkMarkdown(title: string, markdown: string, opts: ChunkOptions): Chunk[] {
  const all = sections(markdown);
  const make = (headings: string[], content: string) => ({ headings, content });

  let pieces: { headings: string[]; content: string }[];
  const whole = markdown.trim();
  if (!whole) {
    pieces = [];
  } else if (opts.countTokens(whole) <= opts.maxTokens) {
    // Fits in one chunk: keep the page whole.
    pieces = [make([], whole)];
  } else {
    pieces = [];
    let group: Section | null = null;
    for (const section of all) {
      if (opts.countTokens(section.text) > opts.maxTokens) {
        if (group) pieces.push(make(group.headings, group.text));
        group = null;
        for (const part of splitLong(section.text, opts)) pieces.push(make(section.headings, part));
        continue;
      }
      // Pack short neighboring sections together while they fit.
      const combined: string = group ? `${group.text}\n\n${section.text}` : section.text;
      if (group && opts.countTokens(combined) <= opts.maxTokens) {
        group = { headings: group.headings, text: combined };
      } else {
        if (group) pieces.push(make(group.headings, group.text));
        group = section;
      }
    }
    if (group) pieces.push(make(group.headings, group.text));
  }

  return pieces.map((p, index) => {
    const context = [title, ...p.headings].join(' > ');
    return { index, headings: p.headings, content: p.content, embeddingText: `${context}\n\n${p.content}` };
  });
}
