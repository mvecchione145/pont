import { Router, type ErrorRequestHandler } from 'express';
import { ApplyError, approve, decideMany, reject } from '../ontology/apply.js';
import { listRecommendations } from '../ontology/recommendations.js';
import { cancelRun, getRun, listRuns, previewChanges, RunError, startRun } from '../ontology/runs.js';
import { OntologyConflictError, readOntology } from '../ontology/store.js';
import {
  conceptDetail,
  createConcept,
  createRelation,
  deleteConcept,
  deleteRelation,
  EditError,
  relationDetail,
  searchOntology,
  updateConcept,
  updateRelation,
} from '../ontology/edit.js';
import { backlinks } from '../ontology/links.js';

export const ontologyRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (raw: string) => {
  if (!UUID.test(raw)) throw new RunError('Not found.', 404);
  return raw;
};

ontologyRouter.get('/', async (_req, res) => {
  res.json((await readOntology()).ontology);
});

// Autocomplete for linking text to the ontology.
ontologyRouter.get('/search', async (req, res) => {
  res.json(await searchOntology(typeof req.query.q === 'string' ? req.query.q : ''));
});

// Concept and relationship ids are slugs like "weekly-active-users" or
// "weekly-active-users--calculated_from--sessions".
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const slug = (raw: string) => {
  if (!SLUG.test(raw)) throw new EditError('Not found.', 404);
  return raw;
};

ontologyRouter.post('/concepts', async (req, res) => {
  res.status(201).json(await createConcept(req.body ?? {}, req.user!));
});
ontologyRouter.get('/concepts/:id', async (req, res) => {
  res.json(await conceptDetail(slug(req.params.id)));
});
ontologyRouter.put('/concepts/:id', async (req, res) => {
  res.json(await updateConcept(slug(req.params.id), req.body ?? {}, req.user!));
});
ontologyRouter.delete('/concepts/:id', async (req, res) => {
  const id = slug(req.params.id);
  const linkedFrom = await backlinks('concept', id);
  res.json({ ...(await deleteConcept(id)), linkedFrom });
});

ontologyRouter.post('/relations', async (req, res) => {
  res.status(201).json(await createRelation(req.body ?? {}, req.user!));
});
ontologyRouter.get('/relations/:id', async (req, res) => {
  res.json(await relationDetail(slug(req.params.id)));
});
ontologyRouter.put('/relations/:id', async (req, res) => {
  res.json(await updateRelation(slug(req.params.id), req.body ?? {}, req.user!));
});
ontologyRouter.delete('/relations/:id', async (req, res) => {
  const id = slug(req.params.id);
  const linkedFrom = await backlinks('relation', id);
  await deleteRelation(id);
  res.json({ linkedFrom });
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

// Body: { action: "approve" | "reject", ids: [...] }. Only the listed ids are
// decided, so a run finishing meanwhile can't add unseen ones to the batch.
ontologyRouter.post('/recommendations/bulk', async (req, res) => {
  const { action, ids } = (req.body ?? {}) as { action?: unknown; ids?: unknown };
  if ((action !== 'approve' && action !== 'reject') || !Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) {
    res.status(400).json({ error: 'Expected { action: "approve" | "reject", ids: string[] }.' });
    return;
  }
  res.json(await decideMany(action, ids.map(id), req.user!));
});

ontologyRouter.post('/recommendations/:id/approve', async (req, res) => {
  res.json(await approve(id(req.params.id), req.user!));
});

ontologyRouter.post('/recommendations/:id/reject', async (req, res) => {
  await reject(id(req.params.id), req.user!);
  res.status(204).end();
});

export const ontologyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof RunError || err instanceof ApplyError || err instanceof EditError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof OntologyConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  next(err);
};
