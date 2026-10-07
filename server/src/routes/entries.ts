import { Router, type ErrorRequestHandler } from 'express';
import {
  EntryError,
  deleteEntry,
  getEntry,
  listEntries,
  parsePath,
  saveEntry,
} from '../entries.js';

export const entriesRouter = Router();

// Express 5 wildcards give the matched segments as an array.
const pathParam = (segments: string | string[]) =>
  parsePath(Array.isArray(segments) ? segments.join('/') : segments);

entriesRouter.get('/', async (_req, res) => {
  res.json(await listEntries());
});

entriesRouter.get('/*path', async (req, res) => {
  res.json(await getEntry(pathParam(req.params.path)));
});

entriesRouter.put('/*path', async (req, res) => {
  const { content, baseVersionId } = req.body ?? {};
  if (typeof content !== 'string') {
    throw new EntryError(400, '"content" must be a string');
  }
  if (baseVersionId !== null && typeof baseVersionId !== 'string') {
    throw new EntryError(400, '"baseVersionId" must be a version ID, or null for a new entry');
  }
  const entry = await saveEntry(pathParam(req.params.path), content, baseVersionId, req.user!);
  res.status(baseVersionId === null ? 201 : 200).json(entry);
});

entriesRouter.delete('/*path', async (req, res) => {
  await deleteEntry(pathParam(req.params.path));
  res.status(204).end();
});

export const entryErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof EntryError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
};
