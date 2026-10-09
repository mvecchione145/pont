import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
} from '@aws-sdk/client-s3';
import { createTwoFilesPatch } from 'diff';
import { s3 } from './clients.js';
import { config } from './config.js';
import { EntryError, getEntry, saveEntry, type Author } from './entries.js';
import type { User } from './auth.js';

// Page history, read straight from the bucket's version history: every save
// is a version and every delete a delete marker. Versions carry who wrote
// them in object metadata, plus where they came from when relevant (an agent
// proposal, a restore, or a move). History also works for deleted pages, so
// they can be restored.

const bucket = config.minio.bucket;
const MAX_VERSIONS = 200;
const keyFor = (path: string) => `knowledge/${path}.md`;

export interface Version {
  versionId: string;
  deleted: boolean;
  current: boolean;
  modifiedAt: string;
  size: number;
  author?: Author;
  // Provenance, when the version came from something other than an edit.
  proposalId?: string;
  proposedBy?: string;
  restoredFrom?: string;
  movedFrom?: string;
  reviewId?: string;
  linkFix?: boolean;
  // The links in this version were updated because that page moved.
  linksMovedFrom?: string;
}

const decode = (value?: string) => (value ? decodeURIComponent(value) : undefined);

function provenance(meta: Record<string, string> | undefined): Partial<Version> {
  if (!meta) return {};
  return {
    author: meta['author-id'] ? { id: meta['author-id'], name: decode(meta['author-name']) ?? '' } : undefined,
    proposalId: meta['proposal-id'],
    proposedBy: decode(meta['proposed-by']),
    restoredFrom: meta['restored-from'],
    movedFrom: decode(meta['moved-from']),
    reviewId: meta['review-id'],
    linkFix: meta['link-fix'] === '1' || undefined,
    linksMovedFrom: decode(meta['links-moved-from']),
  };
}

// Newest first. Empty when the path never existed.
export async function listVersions(path: string): Promise<Version[]> {
  const key = keyFor(path);
  const raw: { versionId: string; deleted: boolean; current: boolean; modified: Date; size: number }[] = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const page: ListObjectVersionsCommandOutput = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
    );
    for (const v of page.Versions ?? []) {
      if (v.Key === key && v.VersionId) {
        raw.push({ versionId: v.VersionId, deleted: false, current: Boolean(v.IsLatest), modified: v.LastModified!, size: v.Size ?? 0 });
      }
    }
    for (const d of page.DeleteMarkers ?? []) {
      if (d.Key === key && d.VersionId) {
        raw.push({ versionId: d.VersionId, deleted: true, current: Boolean(d.IsLatest), modified: d.LastModified!, size: 0 });
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);

  raw.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const recent = raw.slice(0, MAX_VERSIONS);
  // Listing doesn't include metadata, so read it per version.
  return Promise.all(
    recent.map(async (v) => {
      const base: Version = {
        versionId: v.versionId,
        deleted: v.deleted,
        current: v.current,
        modifiedAt: v.modified.toISOString(),
        size: v.size,
      };
      if (v.deleted) return base;
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: v.versionId }));
      return { ...base, ...provenance(head.Metadata) };
    }),
  );
}

// Whether a page ever existed (it has saved versions or a delete marker),
// without reading each version's metadata.
export async function hasHistory(path: string): Promise<boolean> {
  const key = keyFor(path);
  const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 10 }));
  return [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].some((v) => v.Key === key);
}

async function readVersion(path: string, versionId: string): Promise<string> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(path), VersionId: versionId }));
    return (await res.Body?.transformToString('utf-8')) ?? '';
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NoSuchVersion' || name === 'NoSuchKey' || name === 'InvalidArgument') {
      throw new EntryError(404, 'No such version of this page.');
    }
    throw err;
  }
}

export interface VersionDetail extends Version {
  content: string;
  previousVersionId: string | null;
  // Changes from the previous saved version to this one.
  patch: string;
}

export async function getVersion(path: string, versionId: string): Promise<VersionDetail> {
  const versions = await listVersions(path);
  const index = versions.findIndex((v) => v.versionId === versionId);
  if (index < 0) throw new EntryError(404, 'No such version of this page.');
  const version = versions[index];
  if (version.deleted) throw new EntryError(400, 'This entry marks a deletion; it has no content.');
  const previous = versions.slice(index + 1).find((v) => !v.deleted) ?? null;
  const [content, before] = await Promise.all([
    readVersion(path, versionId),
    previous ? readVersion(path, previous.versionId) : Promise.resolve(''),
  ]);
  return {
    ...version,
    content,
    previousVersionId: previous?.versionId ?? null,
    patch: createTwoFilesPatch(`a/${path}.md`, `b/${path}.md`, before, content, undefined, undefined, { context: 3 }),
  };
}

// Saves an old version's content as the newest version. Nothing is lost:
// the version being replaced stays in history. Also brings back deleted pages.
export async function restoreVersion(path: string, versionId: string, user: User) {
  const versions = await listVersions(path);
  const target = versions.find((v) => v.versionId === versionId);
  if (!target) throw new EntryError(404, 'No such version of this page.');
  if (target.deleted) throw new EntryError(400, 'A deletion cannot be restored; pick a saved version.');
  if (target.current) throw new EntryError(409, 'This is already the current version.');
  const content = await readVersion(path, versionId);

  let base: string | null = null;
  try {
    base = (await getEntry(path)).versionId ?? null;
  } catch (err) {
    if (!(err instanceof EntryError && err.status === 404)) throw err;
  }
  return saveEntry(path, content, base, user, { 'restored-from': versionId });
}
