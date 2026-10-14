import { Router } from 'express';
import { rebuild, status } from '../search/index.js';
import { search, SearchUnavailableError } from '../search/search.js';

export const searchRouter = Router();

const MAX_LIMIT = 25;

// GET /api/search?q=...&limit=8
searchRouter.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), MAX_LIMIT);
  try {
    res.json(await search(q, limit));
  } catch (err) {
    if (err instanceof SearchUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }
});

searchRouter.get('/status', (_req, res) => {
  res.json(status);
});

// Rebuilds the index from MinIO, for example after changing the embedding
// model. Any logged-in user may trigger it (there are no roles in the MVP).
searchRouter.post('/reindex', (_req, res) => {
  void rebuild();
  res.status(202).json({ started: true });
});
