import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { applyPatch, createTwoFilesPatch } from 'diff';
import { db, s3 } from '../clients.js';
import { config } from '../config.js';
import { EntryError, getEntry, parsePath, saveEntry } from '../entries.js';
import type { User } from '../auth.js';

// Page changes proposed by agents. A proposal never changes a page: it is
// stored as a unified diff (proposals/<id>.patch) against the page version
// the agent saw, and applied only when a person approves it. If the page has
// changed since, the reviewer is told so and sees the diff re-applied to the
// current version; if it no longer applies cleanly, it can't be approved as is.

export const MAX_PENDING_PER_USER = 25;
const MAX_CONTENT_CHARS = 200_000;
const bucket = config.minio.bucket;
const patchKey = (id: string) => `proposals/${id}.patch`;

export class ProposalError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

export interface Edit {
  find: string;
  replace: string;
}

export interface Proposal {
  id: string;
  kind: 'edit' | 'new';
  path: string;
  baseVersionId: string | null;
  reason: string;
  proposedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

interface Row {
  id: string;
  kind: Proposal['kind'];
  path: string;
  base_version_id: string | null;
  reason: string;
  proposed_by_name: string;
  status: Proposal['status'];
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
}

const toProposal = (r: Row): Proposal => ({
  id: r.id,
  kind: r.kind,
  path: r.path,
  baseVersionId: r.base_version_id,
  reason: r.reason,
  proposedBy: r.proposed_by_name,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  decidedBy: r.decided_by,
  decidedAt: r.decided_at?.toISOString() ?? null,
  decisionNote: r.decision_note,
});

// Applies find/replace edits in order. Each "find" must match exactly once,
// so an agent can't change the wrong passage by accident.
export function applyEdits(content: string, edits: Edit[]): string {
  if (edits.length === 0) throw new ProposalError('Provide at least one edit.');
  let result = content;
  for (const [i, { find, replace }] of edits.entries()) {
    if (!find) throw new ProposalError(`Edit ${i + 1}: "find" is empty.`);
    const first = result.indexOf(find);
    if (first < 0) {
      throw new ProposalError(`Edit ${i + 1}: the "find" text does not appear in the page. Copy it exactly, including whitespace.`);
    }
    if (result.indexOf(find, first + 1) >= 0) {
      throw new ProposalError(`Edit ${i + 1}: the "find" text appears more than once. Include more surrounding text so it matches once.`);
    }
    result = result.slice(0, first) + replace + result.slice(first + find.length);
  }
  if (result === content) throw new ProposalError('These edits would not change the page.');
  return result;
}

const makePatch = (path: string, before: string, after: string) =>
  createTwoFilesPatch(`a/${path}.md`, `b/${path}.md`, before, after, undefined, undefined, { context: 3 });

async function checkCap(user: User) {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM page_proposals WHERE proposed_by = $1 AND status = 'pending'",
    [user.id],
  );
  if (Number(rows[0].n) >= MAX_PENDING_PER_USER) {
    throw new ProposalError(
      `You already have ${MAX_PENDING_PER_USER} proposals waiting for review. Wait for some to be reviewed.`,
      429,
    );
  }
}

async function store(
  kind: Proposal['kind'],
  path: string,
  baseVersionId: string | null,
  patch: string,
  reason: string,
  user: User,
): Promise<Proposal> {
  const { rows } = await db.query<Row>(
    `INSERT INTO page_proposals (kind, path, base_version_id, reason, proposed_by, proposed_by_name)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [kind, path, baseVersionId, reason, user.id, user.name ?? user.username],
  );
  const proposal = toProposal(rows[0]);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: patchKey(proposal.id), Body: patch, ContentType: 'text/x-diff; charset=utf-8' }),
  );
  return proposal;
}

const requireReason = (reason: string) => {
  if (!reason.trim()) throw new ProposalError('Explain why in "reason".');
  return reason.trim();
};

export async function proposeEdit(rawPath: string, edits: Edit[], reason: string, user: User): Promise<Proposal> {
  const path = parsePath(rawPath);
  await checkCap(user);
  let entry;
  try {
    entry = await getEntry(path);
  } catch (err) {
    if (err instanceof EntryError && err.status === 404) {
      throw new ProposalError(`No page at "${path}". Use propose_new_page to suggest a new one.`, 404);
    }
    throw err;
  }
  const after = applyEdits(entry.content, edits);
  if (after.length > MAX_CONTENT_CHARS) throw new ProposalError('The page would be too large.');
  return store('edit', path, entry.versionId ?? null, makePatch(path, entry.content, after), requireReason(reason), user);
}

export async function proposeNewPage(rawPath: string, content: string, reason: string, user: User): Promise<Proposal> {
  const path = parsePath(rawPath);
  await checkCap(user);
  if (!content.trim()) throw new ProposalError('The new page is empty.');
  if (content.length > MAX_CONTENT_CHARS) throw new ProposalError('The page is too large.');
  try {
    await getEntry(path);
    throw new ProposalError(`A page already exists at "${path}". Use propose_edit to change it.`, 409);
  } catch (err) {
    if (!(err instanceof EntryError && err.status === 404)) throw err;
  }
  return store('new', path, null, makePatch(path, '', content), requireReason(reason), user);
}

async function readPatch(id: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: patchKey(id) }));
  return (await res.Body?.transformToString('utf-8')) ?? '';
}

async function load(id: string): Promise<Proposal> {
  const { rows } = await db.query<Row>('SELECT * FROM page_proposals WHERE id = $1', [id]);
  if (!rows[0]) throw new ProposalError('No such proposal.', 404);
  return toProposal(rows[0]);
}

export interface ProposalDetail extends Proposal {
  patch: string;
  // The page changed after the proposal was made.
  stale: boolean;
  // The proposed page, built from the current version; null if the diff no
  // longer applies (or the page is gone / now exists).
  proposedContent: string | null;
  currentContent: string | null;
  currentVersionId: string | null;
  problem: string | null;
}

export async function getProposal(id: string): Promise<ProposalDetail> {
  const proposal = await load(id);
  const patch = await readPatch(id);
  let current: { content: string; versionId: string | null } | null = null;
  try {
    const e = await getEntry(proposal.path);
    current = { content: e.content, versionId: e.versionId ?? null };
  } catch (err) {
    if (!(err instanceof EntryError && err.status === 404)) throw err;
  }

  const detail = (fields: Partial<ProposalDetail>): ProposalDetail => ({
    ...proposal,
    patch,
    stale: false,
    proposedContent: null,
    currentContent: current?.content ?? null,
    currentVersionId: current?.versionId ?? null,
    problem: null,
    ...fields,
  });

  if (proposal.kind === 'new') {
    if (current) return detail({ stale: true, problem: 'A page now exists at this path.' });
    const content = applyPatch('', patch);
    return detail({ proposedContent: content === false ? null : content });
  }
  if (!current) return detail({ stale: true, problem: 'The page has been deleted since this was proposed.' });
  const stale = current.versionId !== proposal.baseVersionId;
  const content = applyPatch(current.content, patch);
  return content === false
    ? detail({ stale, problem: 'The page changed in the same place since this was proposed, so the change no longer applies.' })
    : detail({ stale, proposedContent: content });
}

export async function listProposals(status: 'pending' | 'decided', proposer?: string): Promise<Proposal[]> {
  const params: unknown[] = [];
  let where = status === 'pending' ? "status = 'pending'" : "status <> 'pending'";
  if (proposer) {
    params.push(proposer);
    where += ` AND proposed_by = $${params.length}`;
  }
  const order = status === 'pending' ? 'created_at' : 'decided_at DESC';
  const { rows } = await db.query<Row>(`SELECT * FROM page_proposals WHERE ${where} ORDER BY ${order} LIMIT 200`, params);
  return rows.map(toProposal);
}

export async function pendingCountsByPath(): Promise<Record<string, number>> {
  const { rows } = await db.query<{ path: string; n: string }>(
    "SELECT path, count(*) AS n FROM page_proposals WHERE status = 'pending' GROUP BY path",
  );
  return Object.fromEntries(rows.map((r) => [r.path, Number(r.n)]));
}

async function decide(id: string, status: 'approved' | 'rejected', user: User, note: string | null, versionId: string | null) {
  const { rowCount } = await db.query(
    `UPDATE page_proposals
     SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, applied_version_id = $5
     WHERE id = $1 AND status = 'pending'`,
    [id, status, user.name ?? user.username, note, versionId],
  );
  if (!rowCount) throw new ProposalError('This proposal was already reviewed.', 409);
}

// Approves a proposal. With "content", the reviewer's edited version is saved
// instead (against the page version they edited, "baseVersionId").
export async function approveProposal(
  id: string,
  user: User,
  edited?: { content: string; baseVersionId: string | null },
): Promise<{ path: string; versionId: string | null }> {
  const detail = await getProposal(id);
  if (detail.status !== 'pending') throw new ProposalError('This proposal was already reviewed.', 409);

  const provenance = {
    'proposal-id': detail.id,
    'proposed-by': encodeURIComponent(detail.proposedBy),
  };
  let content: string;
  let base: string | null;
  if (edited) {
    content = edited.content;
    base = edited.baseVersionId;
  } else {
    if (detail.problem || detail.proposedContent === null) {
      throw new ProposalError(detail.problem ?? 'This proposal cannot be applied.', 409);
    }
    content = detail.proposedContent;
    base = detail.kind === 'new' ? null : detail.currentVersionId;
  }

  let saved;
  try {
    saved = await saveEntry(detail.path, content, base, user, provenance);
  } catch (err) {
    if (err instanceof EntryError && err.status === 409) {
      throw new ProposalError('The page changed while you were reviewing. Reload the proposal.', 409);
    }
    throw err;
  }
  await decide(id, 'approved', user, edited ? 'Edited before approving.' : null, saved.versionId ?? null);
  return { path: detail.path, versionId: saved.versionId ?? null };
}

export async function rejectProposal(id: string, user: User, note: string | null): Promise<void> {
  await load(id);
  await decide(id, 'rejected', user, note?.trim() || null, null);
}
