import { config } from '../config.js';
import type { OAuthApp } from './app.js';

// The small part of GitHub's REST API pont needs: OAuth sign-in, reading a
// file, and committing to a branch and opening or checking a pull request.
// Every call is made with the acting person's own token.

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503 = 502,
    // A machine-readable reason, e.g. "stale" (the file changed under a draft).
    readonly code?: string,
  ) {
    super(message);
  }
}

const SCOPES = 'repo read:user';

export function authorizeUrl(app: OAuthApp, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: `${config.publicUrl}/api/github/callback`,
    scope: SCOPES,
    state,
    allow_signup: 'false',
  });
  return `${config.github.webUrl}/login/oauth/authorize?${params}`;
}

export async function exchangeCode(app: OAuthApp, code: string): Promise<{ token: string; scopes: string }> {
  const res = await fetch(`${config.github.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: `${config.publicUrl}/api/github/callback`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new GithubError(`GitHub sign-in failed: ${body.error_description ?? res.statusText}`, 502);
  }
  return { token: body.access_token, scopes: body.scope ?? '' };
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.github.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pont',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GithubError('Could not reach GitHub.', 503);
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? res.statusText;
  if (res.status === 401) throw new GithubError('GitHub rejected your connection. Connect GitHub again in Settings.', 401);
  if (res.status === 403) throw new GithubError(`GitHub refused: ${detail}`, 403);
  if (res.status === 404) throw new GithubError('Not found on GitHub (or your account has no access to it).', 404);
  if (res.status === 409 || res.status === 422) throw new GithubError(`GitHub: ${detail}`, 409);
  throw new GithubError(`GitHub error (${res.status}): ${detail}`, 502);
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export async function currentUser(token: string): Promise<{ login: string }> {
  return call(token, 'GET', '/user');
}

export async function defaultBranch(token: string, owner: string, repo: string): Promise<string> {
  return (await call<{ default_branch: string }>(token, 'GET', repoPath(owner, repo))).default_branch;
}

export interface RepoFile {
  content: string;
  sha: string;
  htmlUrl: string;
}

export async function getFile(token: string, owner: string, repo: string, path: string, ref: string): Promise<RepoFile> {
  const file = await call<{ type: string; content?: string; encoding?: string; sha: string; html_url: string }>(
    token,
    'GET',
    `${repoPath(owner, repo)}/contents/${enc(path)}?${new URLSearchParams({ ref })}`,
  );
  if (file.type !== 'file') throw new GithubError(`"${path}" is not a file.`, 400);
  if (file.encoding !== 'base64' || file.content === undefined) {
    throw new GithubError(`"${path}" is too large to edit here.`, 400);
  }
  return { content: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha, htmlUrl: file.html_url };
}

// The file's current blob SHA on a branch: a git hash of its content, so it
// changes exactly when the file does. With the ETag from last time, GitHub
// answers "304 Not Modified" when nothing changed, which doesn't count
// against the rate limit, so polling every minute is cheap.
export async function fileVersion(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  etag?: string | null,
): Promise<{ changed: false } | { changed: true; sha: string; etag: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${config.github.apiUrl}${repoPath(owner, repo)}/contents/${enc(path)}?${new URLSearchParams({ ref })}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pont',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
    });
  } catch {
    throw new GithubError('Could not reach GitHub.', 503);
  }
  if (res.status === 304) return { changed: false };
  if (!res.ok) {
    const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? res.statusText;
    throw new GithubError(`GitHub (${res.status}): ${detail}`, res.status === 404 ? 404 : res.status === 401 ? 401 : 502);
  }
  const body = (await res.json()) as { sha: string };
  return { changed: true, sha: body.sha, etag: res.headers.get('etag') };
}

export async function branchHead(token: string, owner: string, repo: string, branch: string): Promise<string> {
  const ref = await call<{ object: { sha: string } }>(token, 'GET', `${repoPath(owner, repo)}/git/ref/heads/${enc(branch)}`);
  return ref.object.sha;
}

export async function createBranch(token: string, owner: string, repo: string, branch: string, sha: string): Promise<void> {
  await call(token, 'POST', `${repoPath(owner, repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
}

export async function deleteBranch(token: string, owner: string, repo: string, branch: string): Promise<void> {
  await call(token, 'DELETE', `${repoPath(owner, repo)}/git/refs/heads/${enc(branch)}`);
}

// Commits new content for one file on a branch. "sha" is the file's current
// blob SHA on that branch: GitHub refuses the commit if it has changed since.
export async function putFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  args: { branch: string; sha: string; content: string; message: string },
): Promise<{ commitUrl: string; sha: string }> {
  const res = await call<{ content: { sha: string }; commit: { html_url: string } }>(
    token,
    'PUT',
    `${repoPath(owner, repo)}/contents/${enc(path)}`,
    { message: args.message, content: Buffer.from(args.content, 'utf8').toString('base64'), sha: args.sha, branch: args.branch },
  );
  return { commitUrl: res.commit.html_url, sha: res.content.sha };
}

export interface Pull {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
}

const toPull = (p: {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
}): Pull => ({
  number: p.number,
  url: p.html_url,
  state: p.state,
  merged: Boolean(p.merged ?? p.merged_at),
  draft: Boolean(p.draft),
});

export type ReviewState = 'approved' | 'changes_requested' | null;

// The pull request's review decision: changes requested if any reviewer's
// latest review asks for them, otherwise approved if any approved.
export async function reviewState(token: string, owner: string, repo: string, number: number): Promise<ReviewState> {
  const reviews = await call<{ user: { login: string } | null; state: string }[]>(
    token,
    'GET',
    `${repoPath(owner, repo)}/pulls/${number}/reviews?per_page=100`,
  );
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.user && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED')) {
      latest.set(r.user.login, r.state);
    }
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return null;
}

export async function createPull(
  token: string,
  owner: string,
  repo: string,
  args: { title: string; body: string; head: string; base: string },
): Promise<Pull> {
  return toPull(await call(token, 'POST', `${repoPath(owner, repo)}/pulls`, args));
}

export async function getPull(token: string, owner: string, repo: string, number: number): Promise<Pull> {
  return toPull(await call(token, 'GET', `${repoPath(owner, repo)}/pulls/${number}`));
}

// "https://github.com/org/app/blob/main/docs/guide.md" → its parts.
export function parseFileUrl(url: string): { owner: string; repo: string; branch: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const blob = parts.indexOf('blob');
  if (parts.length < 5 || blob !== 2) return null;
  return { owner: parts[0], repo: parts[1], branch: parts[3], path: parts.slice(4).join('/') };
}
