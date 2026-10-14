import { createHash } from 'node:crypto';
import { SCHEMA_FIELD_TYPE, SCHEMA_VECTOR_FIELD_ALGORITHM } from 'redis';
import { redis } from '../clients.js';
import { EntryError, entryEvents, getEntry, listEntries } from '../entries.js';
import { chunkMarkdown } from './chunker.js';
import { dimensions, embedDocuments, loadModel, model, profile, tokenCounter } from './embeddings.js';

// Search index in Redis Stack: one hash per chunk, holding its text and its
// embedding, indexed for both full-text (BM25) and vector (HNSW, cosine)
// search. MinIO stays the source of truth: the index can always be rebuilt
// from it, and it is reconciled with MinIO on every start.

export const INDEX = 'idx:pont:chunks';
export const CHUNK_PREFIX = 'pont:chunk:';
const META_KEY = 'pont:index:meta';
// path -> lastModified of the version that is indexed
const INDEXED_KEY = 'pont:index:entries';
const pathChunksKey = (path: string) => `pont:index:path:${pathId(path)}`;
const pathId = (path: string) => createHash('sha1').update(path).digest('hex');
// MinIO lists objects with millisecond timestamps but returns whole seconds
// on a read, so compare versions at second precision.
const stamp = (iso?: string) => (iso ?? '').slice(0, 19);

// Bump when chunking or the stored fields change, to force a rebuild.
const CHUNKER_VERSION = '2';
// Content budget per chunk, leaving room in the model's window for the
// title and heading prefix.
const CHUNK_TOKENS = Math.min(384, profile.maxTokens - 96);
const INDEX_DELAY_MS = 1500;

export type IndexState = 'starting' | 'rebuilding' | 'ready' | 'error';

export const status = {
  state: 'starting' as IndexState,
  detail: 'loading the embedding model',
  model,
};

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// Text for the keyword index. RediSearch doesn't split words on newlines
// ("retention\n\nNRR" would index as one token), so collapse all whitespace
// and drop Markdown symbols. The original Markdown is stored separately in
// "content" for display.
export const searchableText = (markdown: string) =>
  markdown
    .replace(/[#>*_`|~\[\]()!-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function indexExists(): Promise<boolean> {
  try {
    await redis.ft.info(INDEX);
    return true;
  } catch {
    return false;
  }
}

// Creates the index, or recreates it when the model or chunking changed.
// Returns true when the index was (re)created and needs a full build.
async function ensureIndex(): Promise<boolean> {
  const dims = await dimensions();
  const expected = { model, dims: String(dims), chunker: CHUNKER_VERSION };
  const meta = await redis.hGetAll(META_KEY);
  const matches = Object.entries(expected).every(([k, v]) => meta[k] === v);
  if (matches && (await indexExists())) return false;

  if (await indexExists()) await redis.ft.dropIndex(INDEX, { DD: true });
  for await (const keys of redis.scanIterator({ MATCH: 'pont:index:path:*', COUNT: 500 })) {
    if (keys.length) await redis.del(keys);
  }
  await redis.del(INDEXED_KEY);

  await redis.ft.create(
    INDEX,
    {
      path: { type: SCHEMA_FIELD_TYPE.TAG },
      title: { type: SCHEMA_FIELD_TYPE.TEXT, WEIGHT: 3 },
      headings: { type: SCHEMA_FIELD_TYPE.TEXT, WEIGHT: 2 },
      text: { type: SCHEMA_FIELD_TYPE.TEXT },
      embedding: {
        type: SCHEMA_FIELD_TYPE.VECTOR,
        ALGORITHM: SCHEMA_VECTOR_FIELD_ALGORITHM.HNSW,
        TYPE: 'FLOAT32',
        DIM: dims,
        DISTANCE_METRIC: 'COSINE',
      },
    },
    { ON: 'HASH', PREFIX: CHUNK_PREFIX },
  );
  await redis.hSet(META_KEY, expected);
  return true;
}

async function removeChunks(path: string): Promise<void> {
  const setKey = pathChunksKey(path);
  const keys = await redis.sMembers(setKey);
  await redis.multi().del([...keys, setKey]).hDel(INDEXED_KEY, path).exec();
}

// (Re)indexes one entry from MinIO. A missing entry is removed instead.
async function indexEntry(path: string): Promise<void> {
  let entry;
  try {
    entry = await getEntry(path);
  } catch (err) {
    if (err instanceof EntryError && err.status === 404) return removeChunks(path);
    throw err;
  }

  const countTokens = await tokenCounter();
  const chunks = chunkMarkdown(nameOf(path), entry.content, { maxTokens: CHUNK_TOKENS, countTokens });
  const vectors = await embedDocuments(chunks.map((c) => c.embeddingText));

  const setKey = pathChunksKey(path);
  const oldKeys = await redis.sMembers(setKey);
  const tx = redis.multi();
  if (oldKeys.length) tx.del(oldKeys);
  tx.del(setKey);
  chunks.forEach((chunk, i) => {
    const key = `${CHUNK_PREFIX}${pathId(path)}:${chunk.index}`;
    tx.hSet(key, {
      path,
      title: searchableText(nameOf(path)),
      headings: chunk.headings.join(' > '),
      content: chunk.content,
      text: searchableText(chunk.content),
      chunk: String(chunk.index),
      embedding: Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength),
    });
    tx.sAdd(setKey, key);
  });
  tx.hSet(INDEXED_KEY, path, stamp(entry.lastModified));
  await tx.exec();
}

// Brings the index in line with MinIO: indexes new or changed entries and
// removes ones that no longer exist.
async function reconcile(): Promise<number> {
  const entries = await listEntries();
  const indexed = await redis.hGetAll(INDEXED_KEY);
  const live = new Set(entries.map((e) => e.path));
  let changed = 0;
  for (const path of Object.keys(indexed)) {
    if (!live.has(path)) {
      await removeChunks(path);
      changed++;
    }
  }
  for (const e of entries) {
    if (indexed[e.path] !== stamp(e.lastModified)) {
      status.detail = `indexing ${changed + 1} of the changed entries`;
      await indexEntry(e.path);
      changed++;
    }
  }
  return changed;
}

// --- Background queue: debounced per path, processed one at a time ---------

const timers = new Map<string, NodeJS.Timeout>();
// Paths changed while the index was starting or rebuilding; indexed once ready.
const pending = new Set<string>();
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch((err) => {
    console.error('search index:', err instanceof Error ? err.message : err);
  });
  return queue;
}

export function scheduleIndex(path: string, delay = INDEX_DELAY_MS): void {
  clearTimeout(timers.get(path));
  timers.set(
    path,
    setTimeout(() => {
      timers.delete(path);
      if (status.state === 'ready') void enqueue(() => indexEntry(path));
      else pending.add(path);
    }, delay),
  );
}

function becomeReady(detail: string) {
  status.state = 'ready';
  status.detail = detail;
  for (const path of pending) void enqueue(() => indexEntry(path));
  pending.clear();
}

// Rebuilds the whole index from MinIO.
export function rebuild(): Promise<void> {
  return enqueue(async () => {
    status.state = 'rebuilding';
    status.detail = 'rebuilding the index';
    await redis.del(INDEXED_KEY);
    const count = await reconcile();
    becomeReady(`rebuilt (${count} entries)`);
  });
}

// Loads the model, prepares the index, and catches up with MinIO. Runs in
// the background so the server can serve requests meanwhile.
export async function startIndexer(): Promise<void> {
  entryEvents.on('saved', (path) => scheduleIndex(path));
  entryEvents.on('deleted', (path) => scheduleIndex(path, 0));
  try {
    await loadModel();
    status.state = 'rebuilding';
    status.detail = 'preparing the index';
    const created = await ensureIndex();
    await enqueue(async () => {
      const count = await reconcile();
      becomeReady(created ? `built (${count} entries)` : `up to date (${count} changes caught up)`);
    });
  } catch (err) {
    status.state = 'error';
    status.detail = err instanceof Error ? err.message : String(err);
    console.error('search index failed to start:', status.detail);
  }
}

export interface IndexedChunk {
  key: string;
  path: string;
  headings: string;
  content: string;
}

// A random chunk from the index: a random page first, then a random chunk of
// it, so long pages don't dominate. Returns null when the index is empty.
export async function randomChunk(): Promise<IndexedChunk | null> {
  const path = await redis.hRandField(INDEXED_KEY);
  if (!path) return null;
  const key = await redis.sRandMember(pathChunksKey(path));
  if (!key) return null;
  const fields = await redis.hmGet(key, ['path', 'headings', 'content']);
  if (!fields[0]) return null;
  return { key, path: String(fields[0]), headings: String(fields[1] ?? ''), content: String(fields[2] ?? '') };
}
