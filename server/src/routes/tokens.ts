import { Router } from 'express';
import { createToken, listTokens, revokeToken } from '../tokens.js';

export const tokensRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 100;

tokensRouter.get('/', async (req, res) => {
  res.json(await listTokens(req.user!.id));
});

// The response is the only time the full token is ever returned.
tokensRouter.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: `"name" must be 1–${MAX_NAME_LENGTH} characters` });
    return;
  }
  res.status(201).json(await createToken(req.user!, name));
});

tokensRouter.delete('/:id', async (req, res) => {
  if (!UUID.test(req.params.id) || !(await revokeToken(req.user!.id, req.params.id))) {
    res.status(404).json({ error: 'No such token' });
    return;
  }
  res.status(204).end();
});
