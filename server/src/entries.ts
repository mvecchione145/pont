import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { EventEmitter } from 'node:events';
import { s3 } from './clients.js';
import { config } from './config.js';
import type { User } from './auth.js';
import { rewritePageLinks } from './markdown-links.js';

// Knowledge entries are plain Markdown files at knowledge/<path>.md in the
// versioned bucket. Every write keeps the previous version, and each version
// records its author in object metadata.

const PREFIX = 'knowledge/';
const SUFFIX = '.md';
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
const MAX_DEPTH = 8;

export interface Author {
  id: string;
  name: string;
}

export interface EntrySummary {
  path: string;
  lastModified?: string;
  size?: number;
}

export interface Entry {
  path: string;
  content: string;
  versionId?: string;
  lastModified?: string;
  author?: Author;
}

// Emits "saved" and "deleted" with the entry path, so other parts of the
// server (the search indexer) can follow changes without coupling to storage.
export const entryEvents = new EventEmitter<{
  saved: [path: string];
  deleted: [path: string];
  moved: [from: string, to: string, user: User];
}>();

export class EntryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

// Validates a path like "processes/onboarding" and returns it normalized.
export function parsePath(raw: string): string {
  const segments = raw.split('/').map((s) => s.trim());
  const valid =
    segments.length > 0 &&
    segments.length <= MAX_DEPTH &&
    segments.every((s) => SEGMENT.test(s) && !s.endsWith('.'));
  if (!valid) {
    throw new EntryError(
      400,
      'Paths are folder/name segments of letters, digits, spaces, "-", "_" or ".", for example "processes/onboarding"',
    );
  }
  return segments.join('/');
}

const keyFor = (path: string) => `${PREFIX}${path}${SUFFIX}`;
const bucket = config.minio.bucket;

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

// S3 metadata must be ASCII, so author names are stored URI-encoded.
function authorFromMetadata(meta: Record<string, string> | undefined): Author | undefined {
  if (!meta?.['author-id']) return undefined;
  return { id: meta['author-id'], name: decodeURIComponent(meta['author-name'] ?? '') };
}

export async function listEntries(): Promise<EntrySummary[]> {
  const entries: EntrySummary[] = [];
  let token: string | undefined;
  do {
    const page: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key?.endsWith(SUFFIX)) continue;
      entries.push({
        path: obj.Key.slice(PREFIX.length, -SUFFIX.length),
        lastModified: obj.LastModified?.toISOString(),
        size: obj.Size,
      });
    }
    token = page.NextContinuationToken;
  } while (token);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function getEntry(path: string): Promise<Entry> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(path) }));
    return {
      path,
      content: (await res.Body?.transformToString('utf-8')) ?? '',
      versionId: res.VersionId,
      lastModified: res.LastModified?.toISOString(),
      author: authorFromMetadata(res.Metadata),
    };
  } catch (err) {
    if (isNotFound(err)) throw new EntryError(404, `No entry at "${path}"`);
    throw err;
  }
}

async function currentVersion(path: string): Promise<string | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: keyFor(path) }));
    return head.VersionId ?? null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// Saves an entry. baseVersionId is the version the editor started from, or
// null when creating a new entry. If the entry changed since then, the save
// is refused with 409 so one user never silently overwrites another.
export async function saveEntry(
  path: string,
  content: string,
  baseVersionId: string | null,
  user: User,
  // Extra provenance stored with this version (ASCII values), e.g. the
  // agent proposal it came from.
  extraMetadata: Record<string, string> = {},
): Promise<Entry> {
  const current = await currentVersion(path);
  if (baseVersionId === null && current !== null) {
    throw new EntryError(409, `An entry already exists at "${path}"`);
  }
  if (baseVersionId !== null && current !== baseVersionId) {
    throw new EntryError(
      409,
      current === null
        ? `"${path}" was deleted by someone else`
        : `"${path}" was changed by someone else since you opened it`,
    );
  }

  const author: Author = { id: user.id, name: user.name ?? user.username };
  const res = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keyFor(path),
      Body: content,
      ContentType: 'text/markdown; charset=utf-8',
      Metadata: { ...extraMetadata, 'author-id': author.id, 'author-name': encodeURIComponent(author.name) },
    }),
  );
  entryEvents.emit('saved', path);
  return {
    path,
    content,
    versionId: res.VersionId,
    lastModified: new Date().toISOString(),
    author,
  };
}

// With versioning on, a delete adds a delete marker: earlier versions are kept.
export async function deleteEntry(path: string): Promise<void> {
  if ((await currentVersion(path)) === null) {
    throw new EntryError(404, `No entry at "${path}"`);
  }
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(path) }));
  entryEvents.emit('deleted', path);
}

// Creates an empty entry named "Untitled", "Untitled 2", ... inside folder,
// so a new page exists the moment the user asks for one.
export async function createUntitled(folder: string, user: User): Promise<Entry> {
  const base = folder ? `${parsePath(folder)}/` : '';
  for (let n = 1; n <= 1000; n++) {
    const path = `${base}${n === 1 ? 'Untitled' : `Untitled ${n}`}`;
    if ((await currentVersion(path)) === null) return saveEntry(path, '', null, user);
  }
  throw new EntryError(409, 'Too many untitled entries in this folder');
}

// Renames or moves an entry. The content is written to the new path as a new
// entry and the old path is deleted; the old path keeps its version history.
export async function moveEntry(
  from: string,
  to: string,
  baseVersionId: string,
  user: User,
): Promise<Entry> {
  if (from === to) return getEntry(from);
  const source = await getEntry(from);
  if (source.versionId !== baseVersionId) {
    throw new EntryError(409, `"${from}" was changed by someone else since you opened it`);
  }
  // Links from the page to itself (e.g. to its own headings) follow it.
  const { content } = rewritePageLinks(source.content, from, to);
  // The new path's history links back to where it came from.
  const moved = await saveEntry(to, content, null, user, { 'moved-from': encodeURIComponent(from) });
  await deleteEntry(from);
  // Other pages' links to it are updated by linkupdates.ts.
  entryEvents.emit('moved', from, to, user);
  return moved;
}
