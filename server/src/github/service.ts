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
  GithubError,
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
}

async function linkOf(path: string): Promise<LinkRow | null> {
  const { rows } = await db.query<LinkRow>('SELECT * FROM github_links WHERE page_path = $1', [path]);
  return rows[0] ?? null;
}

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
    `INSERT INTO github_links (page_path, owner, repo, branch, file_path, base_sha, linked_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [pagePath, owner, repo, branch, filePath, file.sha, user.name ?? user.username],
  );
  return { pagePath };
}

export async function unlink(path: string): Promise<void> {
  await db.query('DELETE FROM github_links WHERE page_path = $1', [path]);
}

// --- Page state ------------------------------------------------------------------------

export interface GithubPage {
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
  fileUrl: string;
  // What the editor should start from: the pull request's version while one
  // is open, otherwise the file as it is on the branch (= the pont page).
  content: string;
  pr: { number: number; url: string; branch: string } | null;
  // The person viewing it can publish (has GitHub connected).
  canPublish: boolean;
  // Set when pont just pulled newer content from GitHub.
  synced: 'merged' | 'updated' | null;
}

async function syncBase(link: LinkRow, token: string, user: User): Promise<boolean> {
  const file = await getFile(token, link.owner, link.repo, link.file_path, link.branch);
  if (file.sha === link.base_sha) return false;
  const entry = await getEntry(link.page_path).catch(() => null);
  await saveEntry(link.page_path, file.content, entry?.versionId ?? null, user, SYNC);
  await db.query('UPDATE github_links SET base_sha = $2, synced_at = now() WHERE page_path = $1', [link.page_path, file.sha]);
  link.base_sha = file.sha;
  return true;
}

async function clearPull(link: LinkRow) {
  await db.query('UPDATE github_links SET pr_number = NULL, pr_branch = NULL, pr_url = NULL WHERE page_path = $1', [link.page_path]);
  link.pr_number = link.pr_branch = link.pr_url = null;
}

// The page's link, refreshed from GitHub when the viewer is connected: a
// merged pull request (or a change on the branch) is pulled into pont.
export async function pageState(user: User, path: string): Promise<GithubPage | null> {
  const link = await linkOf(path);
  if (!link) return null;
  const account = await tokenOf(user);
  let synced: GithubPage['synced'] = null;
  let content: string | null = null;

  if (account) {
    if (link.pr_number) {
      const pull = await getPull(account.token, link.owner, link.repo, link.pr_number);
      if (pull.state === 'open') {
        content = (await getFile(account.token, link.owner, link.repo, link.file_path, link.pr_branch!)).content;
      } else {
        await clearPull(link);
        if (pull.merged && (await syncBase(link, account.token, user))) synced = 'merged';
      }
    }
    if (!link.pr_number && (await syncBase(link, account.token, user))) synced = synced ?? 'updated';
  }
  if (content === null) content = (await getEntry(path)).content;

  return {
    owner: link.owner,
    repo: link.repo,
    branch: link.branch,
    filePath: link.file_path,
    fileUrl: fileUrl(link),
    content,
    pr: link.pr_number ? { number: link.pr_number, url: link.pr_url!, branch: link.pr_branch! } : null,
    canPublish: Boolean(account),
    synced,
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
  pr: { number: number; url: string; branch: string };
  // True when this publish opened the pull request.
  opened: boolean;
  commitUrl: string;
}

export async function publish(
  user: User,
  path: string,
  args: { content: string; title?: string; description?: string },
): Promise<PublishResult> {
  const link = await linkOf(path);
  if (!link) throw new GithubError('This page is not linked to GitHub.', 404);
  const { token, login } = await requireToken(user);
  const title = args.title?.trim() || `Update ${link.file_path}`;

  // Keep adding to the open pull request.
  if (link.pr_number) {
    const pull = await getPull(token, link.owner, link.repo, link.pr_number);
    if (pull.state === 'open') {
      const current = await getFile(token, link.owner, link.repo, link.file_path, link.pr_branch!);
      if (current.content === args.content) throw new GithubError('Nothing changed since the last publish.', 400);
      const commit = await putFile(token, link.owner, link.repo, link.file_path, {
        branch: link.pr_branch!,
        sha: current.sha,
        content: args.content,
        message: title,
      });
      return { pr: { number: pull.number, url: pull.url, branch: link.pr_branch! }, opened: false, commitUrl: commit.commitUrl };
    }
    await clearPull(link);
    if (pull.merged) await syncBase(link, token, user);
  }

  // Otherwise: a new branch from the base branch, one commit, a pull request.
  const base = await getFile(token, link.owner, link.repo, link.file_path, link.branch);
  if (base.content === args.content) throw new GithubError('There are no changes to publish.', 400);
  const head = await branchHead(token, link.owner, link.repo, link.branch);
  const branch = `pont/${slug(link.file_path)}-${Date.now().toString(36)}`;
  await createBranch(token, link.owner, link.repo, branch, head);
  let commit: { commitUrl: string };
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
  await db.query('UPDATE github_links SET pr_number = $2, pr_branch = $3, pr_url = $4 WHERE page_path = $1', [
    path,
    pull.number,
    branch,
    pull.url,
  ]);
  return { pr: { number: pull.number, url: pull.url, branch }, opened: true, commitUrl: commit.commitUrl };
}

// "Pull latest": refresh the page from GitHub now.
export async function pullLatest(user: User, path: string): Promise<GithubPage> {
  await requireToken(user);
  const page = await pageState(user, path);
  if (!page) throw new GithubError('This page is not linked to GitHub.', 404);
  return page;
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
  // The link follows the page when it's moved or renamed, and goes when it's deleted.
  entryEvents.on('moved', (from, to) => {
    void db.query('UPDATE github_links SET page_path = $2 WHERE page_path = $1', [from, to]).catch(() => undefined);
  });
  entryEvents.on('deleted', (path, moving) => {
    if (!moving) void unlink(path).catch(() => undefined);
  });
}
