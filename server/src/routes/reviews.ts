import { Router, type ErrorRequestHandler } from 'express';
import { EntryError, parsePath } from '../entries.js';
import { LlmError } from '../llm/structured.js';
import { decideItem, estimateReview, getReview, latestReview, ReviewError, startReview } from '../review.js';

// Page reviews. The page path goes in the query string or body rather than
// the URL path, so page names can't clash with these routes.
//
// GET  /api/reviews?path=P            -> the page's latest review, or null
// GET  /api/reviews/estimate?path=P   -> what a review would send and cost
// POST /api/reviews { path }          -> starts a review (runs in the background)
// GET  /api/reviews/:id               -> one review, to poll while it runs
// POST /api/reviews/:id/items/:item { action: "apply" | "dismiss" }
export const reviewsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reviewId = (raw: string) => {
  if (!UUID.test(raw)) throw new ReviewError('No such review.', 404);
  return raw;
};
const pathFrom = (raw: unknown) => {
  if (typeof raw !== 'string' || !raw) throw new ReviewError('"path" is required.');
  return parsePath(raw);
};

reviewsRouter.get('/', async (req, res) => {
  res.json(await latestReview(pathFrom(req.query.path)));
});

reviewsRouter.get('/estimate', async (req, res) => {
  res.json(await estimateReview(pathFrom(req.query.path)));
});

reviewsRouter.post('/', async (req, res) => {
  res.status(201).json(await startReview(pathFrom(req.body?.path), req.user!));
});

reviewsRouter.get('/:id', async (req, res) => {
  res.json(await getReview(reviewId(req.params.id)));
});

reviewsRouter.post('/:id/items/:item', async (req, res) => {
  const action = req.body?.action;
  if (action !== 'apply' && action !== 'dismiss') throw new ReviewError('"action" must be "apply" or "dismiss".');
  res.json(await decideItem(reviewId(req.params.id), req.params.item, action, req.user!));
});

export const reviewErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof ReviewError || err instanceof EntryError || err instanceof LlmError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
};
