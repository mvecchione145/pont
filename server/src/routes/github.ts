import { Router, type ErrorRequestHandler } from 'express';
import { config } from '../config.js';
import { EntryError, parsePath } from '../entries.js';
import { GithubError } from '../github/api.js';
import { connectUrl, disconnect, finishConnect, linkFile, pageState, publish, pullLatest, status, unlink } from '../github/service.js';

// GET    /api/github/status                       is GitHub set up, and connected for me?
// POST   /api/github/connect                      → { url } to send the browser to
// GET    /api/github/callback?code&state          GitHub's redirect back (public)
// DELETE /api/github/connection                   disconnect my account
// POST   /api/github/links { url | owner, repo, branch, path, pagePath }
// GET    /api/github/pages?path=P                 the page's link, or null
// POST   /api/github/pages/publish { path, content, title, description }
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

githubRouter.post('/pages/publish', async (req, res) => {
  const { path, content, title, description } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof content !== 'string') throw new GithubError('"content" is required.', 400);
  res.json(
    await publish(req.user!, pathOf(path), {
      content,
      title: typeof title === 'string' ? title : undefined,
      description: typeof description === 'string' ? description : undefined,
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

export const githubErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof GithubError || err instanceof EntryError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
};
