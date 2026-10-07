import { Router, type ErrorRequestHandler } from 'express';
import { answer, currentQuestion, leaderboard, LlmError, nextQuestion, skip, TriviaError } from '../trivia.js';

export const triviaRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function questionId(id: string): string {
  if (!UUID.test(id)) throw new TriviaError('No such question.', 404);
  return id;
}

triviaRouter.get('/current', async (req, res) => {
  res.json(await currentQuestion(req.user!));
});

// Returns the open question, or generates a new one.
triviaRouter.post('/questions', async (req, res) => {
  res.status(201).json(await nextQuestion(req.user!));
});

triviaRouter.post('/questions/:id/answer', async (req, res) => {
  const choice = req.body?.choice;
  if (!Number.isInteger(choice) || choice < 0 || choice > 3) {
    throw new TriviaError('"choice" must be 0, 1, 2, or 3.', 400);
  }
  res.json(await answer(req.user!, questionId(req.params.id), choice));
});

triviaRouter.post('/questions/:id/skip', async (req, res) => {
  res.json(await skip(req.user!, questionId(req.params.id)));
});

triviaRouter.get('/leaderboard', async (req, res) => {
  const period = req.query.period === 'week' ? 'week' : 'all';
  res.json(await leaderboard(period));
});

export const triviaErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof TriviaError || err instanceof LlmError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
};
