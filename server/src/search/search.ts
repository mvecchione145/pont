import { redis } from '../clients.js';
import { embedQuery } from './embeddings.js';
import { INDEX, status } from './index.js';

// Hybrid search, after Onyx: a vector (KNN) search for meaning and a BM25
// keyword search for exact terms (metric names, acronyms), combined by score:
//
//   score = alpha * similarity + (1 - alpha) * keyword
//
// similarity is the cosine similarity to the query. keyword is the BM25 score
// relative to the best keyword hit, scaled by how many of the query's
// meaningful words the chunk contains, so one incidental shared word ("last",
// "business") counts for little. Short queries ("WAU", "SEV2") lean on
// keywords, longer questions lean on meaning. A result needs either decent
// similarity or a keyword match covering at least half the query, so an
// unrelated question returns nothing.

const CANDIDATES = 30;
const ALPHA_SHORT = Number(process.env.SEARCH_ALPHA_SHORT ?? 0.3);
const ALPHA_LONG = Number(process.env.SEARCH_ALPHA_LONG ?? 0.7);
const SHORT_QUERY_TERMS = 2;
// Below this cosine similarity, a chunk only counts if a keyword matched.
const MIN_SIMILARITY = Number(process.env.SEARCH_MIN_SIMILARITY ?? 0.62);
const MIN_KEYWORD_COVERAGE = 0.5;

// Common English words that say nothing about what a chunk is about.
const STOPWORDS = new Set(
  ('a an and are as at be but by can could did do does for from get got had has have how i if in into ' +
    'is it its me my no not of on or our should so such than that the their then there these they ' +
    'this to us was we were what when where which who why will with would you your').split(' '),
);

export interface SearchResult {
  path: string;
  title: string;
  headings: string;
  content: string;
  score: number;
  similarity: number;
  keyword: number;
}

export class SearchUnavailableError extends Error {}

const RETURN = ['path', 'headings', 'content'];
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

interface Hit {
  path: string;
  headings: string;
  content: string;
}

const toHit = (value: Record<string, unknown>): Hit => ({
  path: String(value.path ?? ''),
  headings: String(value.headings ?? ''),
  content: String(value.content ?? ''),
});

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// Meaningful query words, without duplicates or stopwords. A query made only
// of stopwords keeps its words.
function queryTerms(query: string): string[] {
  const all = [...new Set(words(query))];
  const meaningful = all.filter((w) => !STOPWORDS.has(w));
  return meaningful.length ? meaningful : all;
}

// Share of the query's terms found in a chunk (prefix match, so "deploy"
// counts "deploys" and "deployment").
function coverage(terms: string[], hit: Hit): number {
  const present = new Set(words(`${hit.path} ${hit.headings} ${hit.content}`));
  const found = terms.filter((t) => present.has(t) || [...present].some((p) => p.startsWith(t)));
  return terms.length ? found.length / terms.length : 0;
}

async function vectorSearch(query: string): Promise<Map<string, Hit & { similarity: number }>> {
  const vector = await embedQuery(query);
  const reply = await redis.ft.search(INDEX, `*=>[KNN ${CANDIDATES} @embedding $vec AS distance]`, {
    PARAMS: { vec: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) },
    SORTBY: 'distance',
    RETURN: [...RETURN, 'distance'],
    LIMIT: { from: 0, size: CANDIDATES },
    DIALECT: 2,
  });
  // Cosine distance in Redis is 1 - cosine similarity.
  return new Map(
    reply.documents.map((d) => [d.id, { ...toHit(d.value), similarity: 1 - Number(d.value.distance) }]),
  );
}

// Matches any of the query's words (letters and digits only, so user input
// can't inject query syntax); BM25 ranks chunks with more and rarer matches
// higher.
async function keywordSearch(terms: string[]): Promise<Map<string, Hit & { keyword: number; coverage: number }>> {
  if (terms.length === 0) return new Map();
  const reply = await redis.ft.search(INDEX, terms.join(' | '), {
    SCORER: 'BM25',
    WITHSCORES: true,
    RETURN,
    LIMIT: { from: 0, size: CANDIDATES },
    DIALECT: 2,
  });
  const best = Math.max(...reply.documents.map((d) => Number(d.score ?? 0)), 0);
  return new Map(
    reply.documents.map((d) => {
      const hit = toHit(d.value);
      const relative = best > 0 ? Number(d.score ?? 0) / best : 0;
      return [d.id, { ...hit, keyword: relative, coverage: coverage(terms, hit) }];
    }),
  );
}

export async function search(query: string, limit = 8): Promise<SearchResult[]> {
  if (status.state !== 'ready') {
    throw new SearchUnavailableError(`Search is not ready yet: ${status.detail}`);
  }
  const trimmed = query.trim();
  if (!trimmed) return [];

  const terms = queryTerms(trimmed);
  const alpha = terms.length <= SHORT_QUERY_TERMS ? ALPHA_SHORT : ALPHA_LONG;
  const [byMeaning, byKeyword] = await Promise.all([vectorSearch(trimmed), keywordSearch(terms)]);

  // A keyword hit outside the vector candidates gets the lowest candidate
  // similarity, a fair upper bound for it.
  const floor = Math.min(...[...byMeaning.values()].map((h) => h.similarity), 1);

  const results: SearchResult[] = [];
  for (const id of new Set([...byMeaning.keys(), ...byKeyword.keys()])) {
    const hit = (byMeaning.get(id) ?? byKeyword.get(id))!;
    const similarity = byMeaning.get(id)?.similarity ?? floor;
    const match = byKeyword.get(id);
    const keyword = match ? match.keyword * match.coverage : 0;
    if (similarity < MIN_SIMILARITY && (match?.coverage ?? 0) < MIN_KEYWORD_COVERAGE) continue;
    results.push({
      path: hit.path,
      title: nameOf(hit.path),
      headings: hit.headings,
      content: hit.content,
      score: alpha * similarity + (1 - alpha) * keyword,
      similarity,
      keyword,
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
