import { Router, type ErrorRequestHandler } from 'express';
import { EntryError, parsePath } from '../entries.js';
import { getVersion, listVersions, restoreVersion } from '../history.js';

// /api/history/<page path>: kept apart from /api/entries so a page that
// happens to be called "history" or "restore" can't clash with these routes.
export const historyRouter = Router();

const pagePath = (segments: string | string[]) => parsePath(Array.isArray(segments) ? segments.join('/') : segments);

// GET /api/history/<path>             -> versions, newest first
// GET /api/history/<path>?version=ID  -> one version with its diff
historyRouter.get('/*path', async (req, res) => {
  const path = pagePath(req.params.path);
  const version = typeof req.query.version === 'string' ? req.query.version : null;
  if (version) {
    res.json(await getVersion(path, version));
    return;
  }
  const versions = await listVersions(path);
  if (versions.length === 0) throw new EntryError(404, `No history for "${path}".`);
  res.json(versions);
});

// POST /api/history/<path> { restore: versionId } -> saves that version as the newest
historyRouter.post('/*path', async (req, res) => {
  const versionId = req.body?.restore;
  if (typeof versionId !== 'string' || !versionId) throw new EntryError(400, '"restore" must be a version ID.');
  res.json(await restoreVersion(pagePath(req.params.path), versionId, req.user!));
});

export const historyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof EntryError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
};
