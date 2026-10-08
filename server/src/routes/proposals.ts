import { Router, type ErrorRequestHandler } from 'express';
import {
  approveProposal,
  getProposal,
  listProposals,
  pendingCountsByPath,
  ProposalError,
  rejectProposal,
} from '../proposals/store.js';

export const proposalsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (raw: string) => {
  if (!UUID.test(raw)) throw new ProposalError('No such proposal.', 404);
  return raw;
};

proposalsRouter.get('/', async (req, res) => {
  res.json(await listProposals(req.query.status === 'decided' ? 'decided' : 'pending'));
});

// Pending proposals per page path, for the sidebar badge and page banners.
proposalsRouter.get('/counts', async (_req, res) => {
  res.json(await pendingCountsByPath());
});

proposalsRouter.get('/:id', async (req, res) => {
  res.json(await getProposal(id(req.params.id)));
});

// Body (optional): { content, baseVersionId } to save the reviewer's edited
// version instead of the proposal as is.
proposalsRouter.post('/:id/approve', async (req, res) => {
  const { content, baseVersionId } = req.body ?? {};
  let edited;
  if (content !== undefined) {
    if (typeof content !== 'string' || !content.trim()) throw new ProposalError('"content" must be non-empty text.');
    if (baseVersionId !== null && typeof baseVersionId !== 'string') {
      throw new ProposalError('"baseVersionId" is required with "content".');
    }
    edited = { content, baseVersionId };
  }
  res.json(await approveProposal(id(req.params.id), req.user!, edited));
});

proposalsRouter.post('/:id/reject', async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 1000) : null;
  await rejectProposal(id(req.params.id), req.user!, note);
  res.status(204).end();
});

export const proposalErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof ProposalError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
};
