import { Router } from 'express';
import { searchLinkTargets } from '../pagelinks.js';

// GET /api/links/search?q=...&from=<current page path>
// Pages and headings to link to, for the editor's link picker.
export const linksRouter = Router();

linksRouter.get('/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  res.json(searchLinkTargets(q, from));
});
