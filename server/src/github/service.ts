import { randomBytes } from 'node:crypto';
import type { User } from '../auth.js';
import { db } from '../clients.js';
import { config } from '../config.js';
import { EntryError, entryEvents, getEntry, parsePath, saveEntry, saveGuards } from '../entries.js';
import { decrypt, encrypt } from '../secrets.js';
import { oauthApp, publicApp, type PublicGithubApp } from './app.js';
import {
  authorizeUrl,
  branchHead,
  createBranch,
  createPull,
  deleteBranch,
  currentUser,
  defaultBranch,
  exchangeCode,
  getFile,
  getPull,
  fileVersion,
  GithubError,
  reviewState,
  type ReviewState,
  parseFileUrl,
  putFile,
} from './api.js';

// GitHub docs. People connect their GitHub account once (OAuth), then link a
// pont page to a Markdown file in a repository. The page holds the file as it
// is on the branch, so search and agents see it. Linked pages don't autosave:
// edits stay a draft in the editor until someone clicks Publish, which commits
// them to a branch and opens a pull request (later publishes add commits to
// the same pull request while it's open). When the pull request is merged, or
// the file changes on the branch, pont pulls the new content. Ordinary saves
// to a linked page are refused, so pont never drifts from the repository.

const SYNC = { 'github-sync': '1' };
const STATE_TTL_MINUTES = 15;

// --- Accounts ---------------------------------------------------------------------

export interface GithubStatus {
  configured: boolean;
  app: PublicGithubApp;
  connected: boolean;
  login: string | null;
  callbackUrl: string;
}

export async function status(user: User): Promise<GithubStatus> {
  const { rows } = await db.query<{ login: string }>('SELECT login FROM github_accounts WHERE user_id = $1', [user.id]);
  return {
    configured: Boolean(await oauthApp()),
    app: await publicApp(),
    connected: Boolean(rows[0]),
    login: rows[0]?.login ?? null,
    callbackUrl: `${config.publicUrl}/api/github/callback`,
  };
}

export async function connectUrl(user: User): Promise<string> {
  const app = await oauthApp();
  if (!app) throw new GithubError('GitHub is not set up yet: add the OAuth App in Settings → Integrations.', 400);
  const state = randomBytes(24).toString('base64url');
  await db.query("DELETE FROM github_oauth_states WHERE created_at < now() - interval '1 hour'");
  await db.query('INSERT INTO github_oauth_states (state, user_id) VALUES ($1, $2)', [state, user.id]);
  return authorizeUrl(app, state);
}

// GitHub redirects the browser here after sign-in. The state ties it to the
// pont user who started it (the redirect carries no pont login).
export async function finishConnect(code: string, state: string): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    `DELETE FROM github_oauth_states WHERE state = $1 AND created_at > now() - interval '${STATE_TTL_MINUTES} minutes'
     RETURNING user_id`,
    [state],
  );
  if (!rows[0]) throw new GithubError('This GitHub sign-in expired or was already used. Try Connect GitHub again.', 400);
  const app = await oauthApp();
  if (!app) throw new GithubError('GitHub is no longer set up on this pont server.', 400);
  const { token, scopes } = await exchangeCode(app, code);
  const { login } = await currentUser(token);
  await db.query(
    `INSERT INTO github_accounts (user_id, login, token_encrypted, scopes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET login = $2, token_encrypted = $3, scopes = $4, connected_at = now()`,
    [rows[0].user_id, login, encrypt(token), scopes],
  );
  return login;
}

export async function disconnect(user: User): Promise<void> {
  await db.query('DELETE FROM github_accounts WHERE user_id = $1', [user.id]);
}

async function tokenOf(user: User): Promise<{ token: string; login: string } | null> {
  const { rows } = await db.query<{ token_encrypted: string; login: string }>(
    'SELECT token_encrypted, login FROM github_accounts WHERE user_id = $1',
    [user.id],
  );
  if (!rows[0]) return null;
  try {
    return { token: decrypt(rows[0].token_encrypted), login: rows[0].login };
  } catch {
    return null;
  }
}

async function requireToken(user: User) {
  const account = await tokenOf(user);
  if (!account) throw new GithubError('Connect your GitHub account in Settings first.', 400);
  return account;
}

// --- Links -------------------------------------------------------------------------

interface LinkRow {
  page_path: string;
  owner: string;
  repo: string;
  branch: string;
  file_path: string;
  base_sha: string;
  pr_number: number | null;
  pr_branch: string | null;
  pr_url: string | null;
  linked_by: string;
  linked_by_id: string | null;
  // Latest blob SHA seen on the branch being edited, and its ETag.
  remote_sha: string | null;
  remote_etag: string | null;
}

async function linkOf(path: string): Promise<LinkRow | null> {
  const { rows } = await db.query<LinkRow>('SELECT * FROM github_links WHERE page_path = $1', [path]);
  return rows[0] ?? null;
}

// Whether a page is linked to GitHub (its changes go through Publish).
export const isLinked = async (path: string) => Boolean(await linkOf(path));

const fileUrl = (l: LinkRow) =>
  `${config.github.webUrl}/${l.owner}/${l.repo}/blob/${l.branch.split('/').map(encodeURIComponent).join('/')}/${l.file_path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

export interface LinkRequest {
  url?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  path?: string;
  pagePath?: string;
}

export async function linkFile(user: User, req: LinkRequest): Promise<{ pagePath: string }> {
  const { token } = await requireToken(user);
  const fromUrl = req.url ? parseFileUrl(req.url) : null;
  if (req.url && !fromUrl) {
    throw new GithubError('Paste a link to a file on GitHub, like https://github.com/org/repo/blob/main/README.md.', 400);
  }
  const owner = (fromUrl?.owner ?? req.owner ?? '').trim();
  const repo = (fromUrl?.repo ?? req.repo ?? '').trim();
  const filePath = (fromUrl?.path ?? req.path ?? '').trim().replace(/^\/+/, '');
  if (!owner || !repo || !filePath) throw new GithubError('Give the repository (owner/name) and the file path.', 400);
  if (!/\.(md|markdown|mdx|txt)$/i.test(filePath)) throw new GithubError('Only Markdown (or text) files can be linked.', 400);
  const branch = (fromUrl?.branch ?? req.branch ?? '').trim() || (await defaultBranch(token, owner, repo));
  const file = await getFile(token, owner, repo, filePath, branch);

  const pagePath = parsePath(
    req.pagePath?.trim() || `github/${owner}/${repo}/${filePath.replace(/\.(md|markdown|mdx|txt)$/i, '')}`,
  );
  try {
    await getEntry(pagePath);
    throw new GithubError(`A page already exists at "${pagePath}". Choose another page path.`, 409);
  } catch (err) {
    if (!(err instanceof EntryError && err.status === 404)) throw err;
  }
  await saveEntry(pagePath, file.content, null, user, { ...SYNC, 'github-file': encodeURIComponent(`${owner}/${repo}/${filePath}`) });
  await db.query(
    `INSERT INTO github_links (page_path, owner, repo, branch, file_path, base_sha, remote_sha, linked_by, linked_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
    [pagePath, owner, repo, branch, filePath, file.sha, user.name ?? user.username, user.id],
  );
  console.log(`github: linked ${owner}/${repo}/${filePath}@${branch} to "${pagePath}"`);
  return { pagePath };
}

export async function unlink(path: string): Promise<void> {
  await db.query('DELETE FROM github_links WHERE page_path = $1', [path]);
}

// --- The pull request log -------------------------------------------------------------

export type PullState = 'open' | 'merged' | 'closed';

export interface PullLogEntry {
  number: number;
  url: string;
  title: string;
  state: PullState;
  draft: boolean;
  reviewState: ReviewState;
  publishes: number;
  openedBy: string;
  openedAt: string;
  closedAt: string | null;
  // pont deleted the pull request's branch after it was merged.
  branchDeleted: boolean;
}

interface PullRow {
  number: number;
  url: string;
  title: string;
  state: PullState;
  draft: boolean;
  review_state: ReviewState;
  publishes: number;
  opened_by: string;
  opened_by_id: string;
  opened_at: Date;
  closed_at: Date | null;
  owner: string;
  repo: string;
  branch: string;
  page_path: string;
  branch_deleted: boolean;
}

const toEntry = (r: PullRow): PullLogEntry => ({
  number: r.number,
  url: r.url,
  title: r.title,
  state: r.state,
  draft: r.draft,
  reviewState: r.review_state,
  publishes: r.publishes,
  openedBy: r.opened_by,
  openedAt: r.opened_at.toISOString(),
  closedAt: r.closed_at?.toISOString() ?? null,
  branchDeleted: r.branch_deleted,
});

async function pullLog(path: string): Promise<PullLogEntry[]> {
  const { rows } = await db.query<PullRow>(
    'SELECT * FROM github_pull_requests WHERE page_path = $1 ORDER BY opened_at DESC LIMIT 20',
    [path],
  );
  return rows.map(toEntry);
}

async function pullRow(link: LinkRow, number: number): Promise<PullRow | null> {
  const { rows } = await db.query<PullRow>('SELECT * FROM github_pull_requests WHERE owner = $1 AND repo = $2 AND number = $3', [
    link.owner,
    link.repo,
    number,
  ]);
  return rows[0] ?? null;
}

const describe = (link: LinkRow, number: number) => `${link.owner}/${link.repo}#${number} ("${link.page_path}")`;

// --- Syncing ---------------------------------------------------------------------------

async function syncBase(link: LinkRow, token: string, user: User): Promise<boolean> {
  const file = await getFile(token, link.owner, link.repo, link.file_path, link.branch);
  if (file.sha === link.base_sha) return false;
  const entry = await getEntry(link.page_path).catch(() => null);
  await saveEntry(link.page_path, file.content, entry?.versionId ?? null, user, SYNC);
  const usesBase = !link.pr_number;
  await db.query(
    `UPDATE github_links SET base_sha = $2, synced_at = now()${usesBase ? ', remote_sha = $2, remote_etag = NULL' : ''}
     WHERE page_path = $1`,
    [link.page_path, file.sha],
  );
  link.base_sha = file.sha;
  if (usesBase) link.remote_sha = file.sha;
  console.log(`github: pulled ${link.owner}/${link.repo}/${link.file_path}@${link.branch} into "${link.page_path}"`);
  return true;
}

async function clearPull(link: LinkRow) {
  await db.query(
    `UPDATE github_links SET pr_number = NULL, pr_branch = NULL, pr_url = NULL, remote_sha = base_sha, remote_etag = NULL
     WHERE page_path = $1`,
    [link.page_path],
  );
  link.pr_number = link.pr_branch = link.pr_url = null;
  link.remote_sha = link.base_sha;
  link.remote_etag = null;
}

// Checks the open pull request on GitHub and records its state (and review
// decision). A merged or closed pull request is detached from the page, and a
// merge pulls the merged file into pont. Returns what changed, if anything.
async function refreshPull(link: LinkRow, token: string, actor: User): Promise<{ from: PullState; to: PullState } | null> {
  if (!link.pr_number) return null;
  const number = link.pr_number;
  const pull = await getPull(token, link.owner, link.repo, number);
  const state: PullState = pull.state === 'open' ? 'open' : pull.merged ? 'merged' : 'closed';
  const review = state === 'open' ? await reviewState(token, link.owner, link.repo, number).catch(() => null) : null;
  const before = await pullRow(link, number);
  await db.query(
    `UPDATE github_pull_requests SET state = $4, draft = $5, review_state = COALESCE($6, CASE WHEN $4 = 'open' THEN NULL ELSE review_state END),
       updated_at = now(), closed_at = CASE WHEN $4 = 'open' THEN NULL ELSE COALESCE(closed_at, now()) END
     WHERE owner = $1 AND repo = $2 AND number = $3`,
    [link.owner, link.repo, number, state, pull.draft, review],
  );
  if (before && before.review_state !== review && state === 'open' && review) {
    console.log(`github: ${describe(link, number)} review: ${review.replace('_', ' ')}`);
  }
  if (state !== 'open') {
    await clearPull(link);
    if (state === 'merged') {
      await syncBase(link, token, actor);
      await deleteMergedBranches(token, { owner: link.owner, repo: link.repo, number });
    }
  }
  if (before && before.state !== state) {
    console.log(`github: ${describe(link, number)} ${state}`);
    return { from: before.state, to: state };
  }
  return null;
}

// --- Cleaning up merged branches -------------------------------------------------------

// Deletes the pont/... branches of merged pull requests (like GitHub's
// "automatically delete head branches"). Branches of pull requests closed
// without merging are kept, so they can be reopened. Only branches pont made
// (named pont/...) are ever deleted. "only" limits it to one pull request.
export async function deleteMergedBranches(
  token: string | null,
  only?: { owner: string; repo: string; number: number },
): Promise<void> {
  const { rows } = await db.query<PullRow>(
    `SELECT * FROM github_pull_requests
     WHERE state = 'merged' AND NOT branch_deleted AND branch LIKE 'pont/%'
       ${only ? 'AND owner = $1 AND repo = $2 AND number = $3' : ''}`,
    only ? [only.owner, only.repo, only.number] : [],
  );
  for (const pr of rows) {
    const account = token ? { token } : ((await accountById(pr.opened_by_id)) ?? (await accountById(null)));
    if (!account) continue;
    try {
      await deleteBranch(account.token, pr.owner, pr.repo, pr.branch);
      console.log(`github: deleted merged branch ${pr.branch} of ${pr.owner}/${pr.repo}#${pr.number}`);
    } catch (err) {
      // Already gone (deleted on GitHub, or by GitHub's own auto-delete) is fine.
      const gone = err instanceof GithubError && (err.status === 404 || /reference does not exist/i.test(err.message));
      if (!gone) {
        console.warn(`github: couldn't delete ${pr.branch} of ${pr.owner}/${pr.repo}#${pr.number}:`, err instanceof Error ? err.message : err);
        continue;
      }
    }
    await db.query('UPDATE github_pull_requests SET branch_deleted = true WHERE id = $1', [(pr as PullRow & { id: string }).id]);
  }
}

// --- Page state ------------------------------------------------------------------------

export interface PullStatus {
  number: number;
  url: string;
  branch: string;
  state: PullState;
  draft: boolean;
  reviewState: ReviewState;
}

export interface GithubPage {
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
  fileUrl: string;
  // What the editor should start from: the pull request's version while one
  // is open, otherwise the file as it is on the branch (= the pont page)...
  content: string;
  // ...and that version's blob SHA, to notice when GitHub has a newer one.
  sha: string | null;
  pr: PullStatus | null;
  // Every pull request pont opened for this page, newest first.
  pulls: PullLogEntry[];
  // The person viewing it can publish (has GitHub connected).
  canPublish: boolean;
  // Set when pont just pulled newer content from GitHub.
  synced: 'merged' | 'updated' | null;
  // Set when GitHub couldn't be reached or refused (the page then shows the
  // copy pont has).
  warning: string | null;
}

async function currentPull(link: LinkRow): Promise<PullStatus | null> {
  if (!link.pr_number) return null;
  const row = await pullRow(link, link.pr_number);
  return {
    number: link.pr_number,
    url: link.pr_url!,
    branch: link.pr_branch!,
    state: 'open',
    draft: row?.draft ?? false,
    reviewState: row?.review_state ?? null,
  };
}

// The page's link, refreshed from GitHub when the viewer is connected: a
// merged pull request (or a change on the branch) is pulled into pont.
export async function pageState(user: User, path: string): Promise<GithubPage | null> {
  const link = await linkOf(path);
  if (!link) return null;
  const account = await tokenOf(user);
  let synced: GithubPage['synced'] = null;
  let content: string | null = null;
  let sha: string | null = null;
  let warning: string | null = null;

  if (account) {
    try {
      const change = await refreshPull(link, account.token, user);
      if (change?.to === 'merged') synced = 'merged';
      if (link.pr_number) {
        const file = await getFile(account.token, link.owner, link.repo, link.file_path, link.pr_branch!);
        content = file.content;
        sha = file.sha;
        await db.query('UPDATE github_links SET remote_sha = $2, remote_etag = NULL WHERE page_path = $1', [path, sha]);
      } else if (await syncBase(link, account.token, user)) {
        synced = synced ?? 'updated';
      }
    } catch (err) {
      if (!(err instanceof GithubError)) throw err;
      warning = `Couldn't check GitHub (${err.message}) Showing the copy pont has.`;
      console.warn(`github: opening "${path}": ${err.message}`);
    }
  }
  if (content === null) {
    content = (await getEntry(path)).content;
    sha = link.pr_number ? link.remote_sha : link.base_sha;
  }

  return {
    owner: link.owner,
    repo: link.repo,
    branch: link.branch,
    filePath: link.file_path,
    fileUrl: fileUrl(link),
    content,
    sha,
    pr: await currentPull(link),
    pulls: await pullLog(path),
    canPublish: Boolean(account),
    synced,
    warning,
  };
}

// What an open page polls (from the database, kept fresh by the background
// check below): the SHA of the version being edited, and the pull request.
export interface GithubPageStatus {
  sha: string | null;
  pr: PullStatus | null;
  pulls: PullLogEntry[];
}

export async function pageStatus(path: string): Promise<GithubPageStatus | null> {
  const link = await linkOf(path);
  if (!link) return null;
  return {
    sha: link.pr_number ? link.remote_sha : link.base_sha,
    pr: await currentPull(link),
    pulls: await pullLog(path),
  };
}

// --- Publishing ----------------------------------------------------------------------

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'doc';

export interface PublishResult {
  pr: PullStatus;
  // True when this publish opened the pull request.
  opened: boolean;
  commitUrl: string;
  // The file's new blob SHA on the pull request's branch.
  sha: string;
}

function checkFresh(current: string, startedFrom: string | undefined, force: boolean, where: string) {
  if (startedFrom && !force && current !== startedFrom) {
    throw new GithubError(
      `The file changed on GitHub (${where}) since you started editing. Publishing now would replace those changes. ` +
        'Refresh to see them (your draft is kept), or publish anyway.',
      409,
      'stale',
    );
  }
}

export async function publish(
  user: User,
  path: string,
  args: { content: string; title?: string; description?: string; baseSha?: string; force?: boolean },
): Promise<PublishResult> {
  const link = await linkOf(path);
  if (!link) throw new GithubError('This page is not linked to GitHub.', 404);
  const { token, login } = await requireToken(user);
  const title = args.title?.trim() || `Update ${link.file_path}`;

  // Keep adding to the open pull request.
  if (link.pr_number) {
    await refreshPull(link, token, user);
  }
  if (link.pr_number) {
    const current = await getFile(token, link.owner, link.repo, link.file_path, link.pr_branch!);
    checkFresh(current.sha, args.baseSha, Boolean(args.force), `in pull request #${link.pr_number}`);
    if (current.content === args.content) throw new GithubError('Nothing changed since the last publish.', 400);
    const commit = await putFile(token, link.owner, link.repo, link.file_path, {
      branch: link.pr_branch!,
      sha: current.sha,
      content: args.content,
      message: title,
    });
    await db.query('UPDATE github_links SET remote_sha = $2, remote_etag = NULL WHERE page_path = $1', [path, commit.sha]);
    await db.query(
      'UPDATE github_pull_requests SET publishes = publishes + 1, updated_at = now() WHERE owner = $1 AND repo = $2 AND number = $3',
      [link.owner, link.repo, link.pr_number],
    );
    console.log(`github: ${describe(link, link.pr_number)} updated by @${login}`);
    return { pr: (await currentPull(link))!, opened: false, commitUrl: commit.commitUrl, sha: commit.sha };
  }

  // Otherwise: a new branch from the base branch, one commit, a pull request.
  const base = await getFile(token, link.owner, link.repo, link.file_path, link.branch);
  checkFresh(base.sha, args.baseSha, Boolean(args.force), `on ${link.branch}`);
  if (base.content === args.content) throw new GithubError('There are no changes to publish.', 400);
  const head = await branchHead(token, link.owner, link.repo, link.branch);
  const branch = `pont/${slug(link.file_path)}-${Date.now().toString(36)}`;
  await createBranch(token, link.owner, link.repo, branch, head);
  let commit: { commitUrl: string; sha: string };
  let pull: Awaited<ReturnType<typeof createPull>>;
  try {
    commit = await putFile(token, link.owner, link.repo, link.file_path, {
      branch,
      sha: base.sha,
      content: args.content,
      message: title,
    });
    const description = [args.description?.trim(), `_Edited and published from pont by @${login}._`].filter(Boolean).join('\n\n');
    pull = await createPull(token, link.owner, link.repo, { title, body: description, head: branch, base: link.branch });
  } catch (err) {
    // Don't leave an empty branch behind.
    await deleteBranch(token, link.owner, link.repo, branch).catch(() => undefined);
    throw err;
  }
  await db.query(
    `UPDATE github_links SET pr_number = $2, pr_branch = $3, pr_url = $4, remote_sha = $5, remote_etag = NULL WHERE page_path = $1`,
    [path, pull.number, branch, pull.url, commit.sha],
  );
  await db.query(
    `INSERT INTO github_pull_requests (page_path, owner, repo, number, url, branch, title, draft, opened_by, opened_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (owner, repo, number) DO NOTHING`,
    [path, link.owner, link.repo, pull.number, pull.url, branch, title, pull.draft, user.name ?? user.username, user.id],
  );
  console.log(`github: ${describe(link, pull.number)} opened by @${login}`);
  Object.assign(link, { pr_number: pull.number, pr_branch: branch, pr_url: pull.url });
  return { pr: (await currentPull(link))!, opened: true, commitUrl: commit.commitUrl, sha: commit.sha };
}

// "Pull latest": refresh the page from GitHub now.
export async function pullLatest(user: User, path: string): Promise<GithubPage> {
  await requireToken(user);
  const page = await pageState(user, path);
  if (!page) throw new GithubError('This page is not linked to GitHub.', 404);
  return page;
}

// --- Background checks --------------------------------------------------------------------

const POLL_MS = Number(process.env.GITHUB_POLL_MS ?? 60_000);
let polling = false;

async function accountById(userId: string | null): Promise<{ token: string; login: string; userId: string } | null> {
  const { rows } = await db.query<{ user_id: string; token_encrypted: string; login: string }>(
    userId
      ? 'SELECT user_id, token_encrypted, login FROM github_accounts WHERE user_id = $1'
      : 'SELECT user_id, token_encrypted, login FROM github_accounts ORDER BY connected_at DESC LIMIT 1',
    userId ? [userId] : [],
  );
  if (!rows[0]) return null;
  try {
    return { token: decrypt(rows[0].token_encrypted), login: rows[0].login, userId: rows[0].user_id };
  } catch {
    return null;
  }
}

// Every minute, for each linked page: check its open pull request (state and
// review) and whether the file changed on the branch being edited. Changes on
// the linked branch are pulled into pont; open pages notice the new SHA and
// ask people to refresh. Uses the token of whoever opened the pull request or
// linked the page (or, failing that, anyone connected), with ETags so an
// unchanged file costs nothing against GitHub's rate limit.
async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const { rows: links } = await db.query<LinkRow>('SELECT * FROM github_links');
    // Branches of pull requests merged earlier (or before this was added).
    await deleteMergedBranches(null).catch((err) => console.warn('github: branch cleanup:', err instanceof Error ? err.message : err));
    for (const link of links) {
      try {
        const opener = link.pr_number ? (await pullRow(link, link.pr_number))?.opened_by_id ?? null : null;
        const account = (opener && (await accountById(opener))) || (await accountById(link.linked_by_id)) || (await accountById(null));
        if (!account) continue;
        const actor: User = { id: account.userId, username: account.login, name: link.linked_by } as User;
        await refreshPull(link, account.token, actor);
        const ref = link.pr_number ? link.pr_branch! : link.branch;
        const version = await fileVersion(account.token, link.owner, link.repo, link.file_path, ref, link.remote_etag);
        if (version.changed) {
          if (!link.pr_number && version.sha !== link.base_sha) {
            await syncBase(link, account.token, actor);
          } else if (link.pr_number && link.remote_sha && version.sha !== link.remote_sha) {
            console.log(`github: ${link.owner}/${link.repo}/${link.file_path} changed on ${ref}`);
          }
          await db.query('UPDATE github_links SET remote_sha = $2, remote_etag = $3 WHERE page_path = $1', [
            link.page_path,
            version.sha,
            version.etag,
          ]);
        }
        await db.query('UPDATE github_links SET checked_at = now() WHERE page_path = $1', [link.page_path]);
      } catch (err) {
        console.warn(`github: checking "${link.page_path}" failed:`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    polling = false;
  }
}

// --- Keeping links attached ---------------------------------------------------------------

export function startGithubLinks(): void {
  // Ordinary saves to a linked page are refused; only syncs from GitHub write it.
  saveGuards.push(async (path, metadata) => {
    if (metadata['github-sync'] === '1') return;
    if (await linkOf(path)) {
      throw new EntryError(
        409,
        `"${path}" is linked to a file on GitHub. Edit it in pont and click Publish to open a pull request.`,
      );
    }
  });
  // The link (and its pull request log) follows the page when it's moved or
  // renamed, and goes when it's deleted.
  entryEvents.on('moved', (from, to) => {
    void db.query('UPDATE github_links SET page_path = $2 WHERE page_path = $1', [from, to]).catch(() => undefined);
    void db.query('UPDATE github_pull_requests SET page_path = $2 WHERE page_path = $1', [from, to]).catch(() => undefined);
  });
  entryEvents.on('deleted', (path, moving) => {
    if (!moving) void unlink(path).catch(() => undefined);
  });
  if (POLL_MS > 0) {
    setTimeout(() => void pollOnce(), 15_000).unref();
    setInterval(() => void pollOnce(), POLL_MS).unref();
  }
}
