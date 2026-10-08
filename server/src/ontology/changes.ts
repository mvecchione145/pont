import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectVersionsCommand, type ListObjectVersionsCommandOutput } from '@aws-sdk/client-s3';
import { createTwoFilesPatch } from 'diff';
import type { PoolClient } from 'pg';
import { db, s3 } from '../clients.js';
import { config } from '../config.js';

// What changed in the documentation since the last ontology calculation.
// Each page's state at calculation time is snapshotted (version ID and content
// hash); comparing that to the latest versions in MinIO gives the added,
// modified, and deleted pages. MinIO keeps old versions, so a modified page
// can be shown to the agents as a focused diff.

const PREFIX = 'knowledge/';
const SUFFIX = '.md';
const bucket = config.minio.bucket;
const MAX_DIFF_CHARS = 12_000;

export interface PageVersion {
  path: string;
  versionId: string;
}

export interface ChangedPage extends PageVersion {
  content: string;
  hash: string;
}

export interface ModifiedPage extends ChangedPage {
  previousVersionId: string;
  previousContent: string;
  diff: string;
}

export interface DeletedPage {
  path: string;
  previousVersionId: string;
  previousContent: string;
}

export interface Changes {
  added: ChangedPage[];
  modified: ModifiedPage[];
  deleted: DeletedPage[];
  // Pages whose version changed but whose content is identical (no work).
  unchanged: PageVersion[];
}

export interface Snapshot {
  path: string;
  versionId: string;
  hash: string;
}

const pathFromKey = (key: string) => key.slice(PREFIX.length, -SUFFIX.length);
const keyFor = (path: string) => `${PREFIX}${path}${SUFFIX}`;
export const hashContent = (content: string) => createHash('sha256').update(content).digest('hex');

// The latest live version of every page (pages whose latest version is a
// delete marker are left out).
async function latestVersions(): Promise<PageVersion[]> {
  const pages: PageVersion[] = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const page: ListObjectVersionsCommandOutput = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: PREFIX, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
    );
    for (const v of page.Versions ?? []) {
      if (v.IsLatest && v.Key?.endsWith(SUFFIX) && v.VersionId) {
        pages.push({ path: pathFromKey(v.Key), versionId: v.VersionId });
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return pages;
}

export async function readVersion(path: string, versionId: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(path), VersionId: versionId }));
  return (await res.Body?.transformToString('utf-8')) ?? '';
}

export async function loadSnapshots(): Promise<Map<string, Snapshot>> {
  const { rows } = await db.query<{ path: string; version_id: string; content_hash: string }>(
    'SELECT path, version_id, content_hash FROM ontology_snapshots',
  );
  return new Map(rows.map((r) => [r.path, { path: r.path, versionId: r.version_id, hash: r.content_hash }]));
}

function focusedDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`${path} (before)`, `${path} (now)`, before, after, '', '', { context: 2 });
  // Drop the "===" header line the diff library adds.
  const body = patch.split('\n').slice(1).join('\n');
  return body.length > MAX_DIFF_CHARS ? `${body.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : body;
}

export async function detectChanges(): Promise<Changes> {
  const [latest, snapshots] = await Promise.all([latestVersions(), loadSnapshots()]);
  const changes: Changes = { added: [], modified: [], deleted: [], unchanged: [] };
  const live = new Set<string>();

  for (const page of latest) {
    live.add(page.path);
    const snapshot = snapshots.get(page.path);
    if (snapshot?.versionId === page.versionId) continue;
    const content = await readVersion(page.path, page.versionId);
    const hash = hashContent(content);
    if (!snapshot) {
      changes.added.push({ ...page, content, hash });
    } else if (snapshot.hash === hash) {
      changes.unchanged.push(page);
    } else {
      const before = await readVersion(page.path, snapshot.versionId).catch(() => '');
      changes.modified.push({
        ...page,
        content,
        hash,
        previousVersionId: snapshot.versionId,
        previousContent: before,
        diff: focusedDiff(page.path, before, content),
      });
    }
  }

  for (const snapshot of snapshots.values()) {
    if (live.has(snapshot.path)) continue;
    const previousContent = await readVersion(snapshot.path, snapshot.versionId).catch(() => '');
    changes.deleted.push({ path: snapshot.path, previousVersionId: snapshot.versionId, previousContent });
  }

  const byPath = <T extends { path: string }>(a: T, b: T) => a.path.localeCompare(b.path);
  changes.added.sort(byPath);
  changes.modified.sort(byPath);
  changes.deleted.sort(byPath);
  return changes;
}

export const changeCount = (c: Changes) => c.added.length + c.modified.length + c.deleted.length;

// Records the analysed state of every changed page, so the next calculation
// only looks at what changed after this one.
export async function saveSnapshots(client: PoolClient, changes: Changes, runId: string): Promise<void> {
  const upsert = `INSERT INTO ontology_snapshots (path, version_id, content_hash, run_id)
                  VALUES ($1, $2, $3, $4)
                  ON CONFLICT (path) DO UPDATE
                  SET version_id = $2, content_hash = $3, run_id = $4, calculated_at = now()`;
  for (const p of [...changes.added, ...changes.modified]) {
    await client.query(upsert, [p.path, p.versionId, p.hash, runId]);
  }
  for (const p of changes.unchanged) {
    await client.query(
      'UPDATE ontology_snapshots SET version_id = $2, run_id = $3, calculated_at = now() WHERE path = $1',
      [p.path, p.versionId, runId],
    );
  }
  for (const p of changes.deleted) {
    await client.query('DELETE FROM ontology_snapshots WHERE path = $1', [p.path]);
  }
}
