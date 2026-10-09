import { Router, type ErrorRequestHandler } from 'express';
import { deadLinksIn, fixLinks, LinkFixError } from '../deadlinks.js';
import { EntryError, parsePath } from '../entries.js';
import { searchLinkTargets } from '../pagelinks.js';

// GET  /api/links/search?q=...&from=<page>  pages and headings for the link picker
// GET  /api/links/dead?path=<page>          dead links on one page
// POST /api/links/fix { path, href, to }    repoint links to href ("to" null: unlink)
export const linksRouter = Router();

linksRouter.get('/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  res.json(searchLinkTargets(q, from));
});

linksRouter.get('/dead', async (req, res) => {
  if (typeof req.query.path !== 'string' || !req.query.path) throw new LinkFixError('"path" is required.');
  res.json(await deadLinksIn(parsePath(req.query.path)));
});

linksRouter.post('/fix', async (req, res) => {
  const { path, href, to } = (req.body ?? {}) as { path?: unknown; href?: unknown; to?: unknown };
  if (typeof path !== 'string' || typeof href !== 'string' || (to !== null && typeof to !== 'string')) {
    throw new LinkFixError('Expected { path, href, to } where "to" is a link or null.');
  }
  res.json(await fixLinks(parsePath(path), href, to, req.user!));
});

export const linkErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof LinkFixError || err instanceof EntryError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
};
