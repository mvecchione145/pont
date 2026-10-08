import { Router, type ErrorRequestHandler } from 'express';
import { ApplyError, approve, reject } from '../ontology/apply.js';
import { listRecommendations } from '../ontology/recommendations.js';
import { cancelRun, getRun, listRuns, previewChanges, RunError, startRun } from '../ontology/runs.js';
import { OntologyConflictError, readOntology } from '../ontology/store.js';

export const ontologyRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (raw: string) => {
  if (!UUID.test(raw)) throw new RunError('Not found.', 404);
  return raw;
};

ontologyRouter.get('/', async (_req, res) => {
  res.json((await readOntology()).ontology);
});

// What changed since the last calculation, with a cost estimate for the
// confirmation dialog. Reads pages but calls no LLM.
ontologyRouter.get('/changes', async (_req, res) => {
  res.json(await previewChanges());
});

ontologyRouter.get('/runs', async (_req, res) => {
  res.json(await listRuns());
});

// Starts a calculation (LLM cost). The client confirms with the user first.
ontologyRouter.post('/runs', async (req, res) => {
  res.status(202).json(await startRun(req.user!));
});

ontologyRouter.get('/runs/:id', async (req, res) => {
  res.json(await getRun(id(req.params.id)));
});

ontologyRouter.post('/runs/:id/cancel', async (req, res) => {
  res.json(await cancelRun(id(req.params.id)));
});

ontologyRouter.get('/recommendations', async (req, res) => {
  res.json(await listRecommendations(req.query.status === 'decided' ? 'decided' : 'pending'));
});

ontologyRouter.post('/recommendations/:id/approve', async (req, res) => {
  res.json(await approve(id(req.params.id), req.user!));
});

ontologyRouter.post('/recommendations/:id/reject', async (req, res) => {
  await reject(id(req.params.id), req.user!);
  res.status(204).end();
});

export const ontologyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof RunError || err instanceof ApplyError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof OntologyConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  next(err);
};
