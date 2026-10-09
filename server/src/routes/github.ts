import { Router, type ErrorRequestHandler } from 'express';
import { config } from '../config.js';
import { EntryError, parsePath } from '../entries.js';
import { GithubError } from '../github/api.js';
import { GithubAppError, removeApp, saveApp } from '../github/app.js';
import { connectUrl, disconnect, finishConnect, linkFile, pageState, pageStatus, publish, pullLatest, status, unlink } from '../github/service.js';

// GET    /api/github/status                       is GitHub set up, and connected for me?
// PUT    /api/github/app { clientId, clientSecret? }  set the OAuth App (unless set by env)
// DELETE /api/github/app                          remove it
// POST   /api/github/connect                      → { url } to send the browser to
// GET    /api/github/callback?code&state          GitHub's redirect back (public)
// DELETE /api/github/connection                   disconnect my account
// POST   /api/github/links { url | owner, repo, branch, path, pagePath }
// GET    /api/github/pages?path=P                 the page's link, or null
// GET    /api/github/pages/status?path=P          what an open page polls: SHA and pull request
// POST   /api/github/pages/publish { path, content, title, description, baseSha, force }
// POST   /api/github/pages/pull { path }          pull the latest from GitHub
// DELETE /api/github/pages?path=P                 unlink (the page stays)

// The OAuth callback: a browser redirect from GitHub, so it carries no pont
// login. The one-time "state" identifies who started it.
export const githubCallbackRouter = Router();
githubCallbackRouter.get('/callback', async (req, res) => {
  const back = (result: string) => res.redirect(`${config.publicUrl}/#/settings?tab=integrations&github=${encodeURIComponent(result)}`);
  const { code, state, error } = req.query;
  if (typeof error === 'string') return back('cancelled');
  if (typeof code !== 'string' || typeof state !== 'string') return back('failed');
  try {
    await finishConnect(code, state);
    back('connected');
  } catch (err) {
    console.error('GitHub connect:', err instanceof Error ? err.message : err);
    back('failed');
  }
});

export const githubRouter = Router();

const pathOf = (raw: unknown) => {
  if (typeof raw !== 'string' || !raw) throw new GithubError('"path" is required.', 400);
  return parsePath(raw);
};

githubRouter.get('/status', async (req, res) => {
  res.json(await status(req.user!));
});

// The OAuth App itself (when not set by the server's environment).
githubRouter.put('/app', async (req, res) => {
  const { clientId, clientSecret } = (req.body ?? {}) as { clientId?: unknown; clientSecret?: unknown };
  if (typeof clientId !== 'string' || (clientSecret !== undefined && typeof clientSecret !== 'string')) {
    throw new GithubAppError('Expected { clientId, clientSecret? }.');
  }
  res.json(await saveApp({ clientId, clientSecret }, req.user!));
});

githubRouter.delete('/app', async (_req, res) => {
  await removeApp();
  res.status(204).end();
});

githubRouter.post('/connect', async (req, res) => {
  res.json({ url: await connectUrl(req.user!) });
});

githubRouter.delete('/connection', async (req, res) => {
  await disconnect(req.user!);
  res.status(204).end();
});

githubRouter.post('/links', async (req, res) => {
  res.status(201).json(await linkFile(req.user!, req.body ?? {}));
});

githubRouter.get('/pages', async (req, res) => {
  res.json(await pageState(req.user!, pathOf(req.query.path)));
});

githubRouter.get('/pages/status', async (req, res) => {
  res.json(await pageStatus(pathOf(req.query.path)));
});

githubRouter.post('/pages/publish', async (req, res) => {
  const { path, content, title, description, baseSha, force } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof content !== 'string') throw new GithubError('"content" is required.', 400);
  res.json(
    await publish(req.user!, pathOf(path), {
      content,
      title: typeof title === 'string' ? title : undefined,
      description: typeof description === 'string' ? description : undefined,
      baseSha: typeof baseSha === 'string' ? baseSha : undefined,
      force: force === true,
    }),
  );
});

githubRouter.post('/pages/pull', async (req, res) => {
  res.json(await pullLatest(req.user!, pathOf(req.body?.path)));
});

githubRouter.delete('/pages', async (req, res) => {
  await unlink(pathOf(req.query.path));
  res.status(204).end();
});

export const githubErrors: ErrorRequestHandler = (err, req, res, next) => {
  if (err instanceof GithubError || err instanceof GithubAppError || err instanceof EntryError) {
    // Logged too, so GitHub problems (no access, an app not installed, ...)
    // show up in the server logs, not only in the browser.
    console.warn(`github: ${req.method} ${req.originalUrl.split('?')[0]} → ${err.status}: ${err.message}`);
    res.status(err.status).json({ error: err.message, ...(err instanceof GithubError && err.code ? { code: err.code } : {}) });
    return;
  }
  next(err);
};
