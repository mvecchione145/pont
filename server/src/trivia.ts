import { randomInt } from 'node:crypto';
import { db } from './clients.js';
import { generateQuestion, LlmError } from './llm/generate.js';
import { getSettings } from './llm/settings.js';
import { randomChunk, status as indexStatus } from './search/index.js';
import type { User } from './auth.js';

// Trivia: multiple-choice questions generated from random documentation
// chunks. +1 for a correct answer, -1 for a wrong one; skipped questions score
// nothing. The correct answer stays on the server until the question is
// answered.

const MIN_WORDS = 25;
const ATTEMPTS = 8;
const RECENT = 15;

export class TriviaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(message);
  }
}

export interface Question {
  id: string;
  path: string;
  headings: string;
  question: string;
  options: string[];
}

export interface AnswerResult {
  correct: boolean;
  correctIndex: number;
  explanation: string;
  path: string;
  headings: string;
  scores: { allTime: number; week: number };
}

interface Row {
  id: string;
  path: string;
  headings: string;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  answered_at: Date | null;
}

const toQuestion = (r: Row): Question => ({
  id: r.id,
  path: r.path,
  headings: r.headings,
  question: r.question,
  options: r.options,
});

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The user's open (unanswered) question, if any. Reloading the page brings it
// back instead of generating (and paying for) a new one.
export async function currentQuestion(user: User): Promise<Question | null> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM trivia_questions WHERE user_id = $1 AND answered_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  );
  return rows[0] ? toQuestion(rows[0]) : null;
}

export async function nextQuestion(user: User): Promise<Question> {
  const open = await currentQuestion(user);
  if (open) return open;

  const settings = await getSettings();
  if (!settings) throw new TriviaError('Set up an LLM provider in Settings to play trivia.', 400);
  if (indexStatus.state !== 'ready') throw new TriviaError(`Search index not ready: ${indexStatus.detail}`, 503);

  const { rows: recent } = await db.query<{ chunk_key: string }>(
    'SELECT chunk_key FROM trivia_questions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [user.id, RECENT],
  );
  const seen = new Set(recent.map((r) => r.chunk_key));

  // Prefer a substantial chunk this user hasn't seen recently; fall back to
  // any substantial chunk.
  let chunk = null;
  let fallback = null;
  for (let i = 0; i < ATTEMPTS && !chunk; i++) {
    const candidate = await randomChunk();
    if (!candidate || wordCount(candidate.content) < MIN_WORDS) continue;
    if (!seen.has(candidate.key)) chunk = candidate;
    else fallback ??= candidate;
  }
  chunk ??= fallback;
  if (!chunk) throw new TriviaError('There isn’t enough documentation yet. Write a few pages first.', 409);

  const generated = await generateQuestion(settings, {
    title: nameOf(chunk.path),
    headings: chunk.headings,
    content: chunk.content,
  });
  const options = shuffle([generated.correct_answer, ...generated.wrong_answers].map((o) => o.trim()));
  const correctIndex = options.indexOf(generated.correct_answer.trim());

  const { rows } = await db.query<Row>(
    `INSERT INTO trivia_questions
       (user_id, user_name, path, headings, chunk_key, question, options, correct_index, explanation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      user.id,
      user.name ?? user.username,
      chunk.path,
      chunk.headings,
      chunk.key,
      generated.question.trim(),
      JSON.stringify(options),
      correctIndex,
      generated.explanation.trim(),
    ],
  );
  return toQuestion(rows[0]);
}

async function scoresFor(userId: string): Promise<{ allTime: number; week: number }> {
  const { rows } = await db.query<{ all_time: string | null; week: string | null }>(
    `SELECT sum(CASE WHEN is_correct THEN 1 ELSE -1 END) AS all_time,
            sum(CASE WHEN is_correct THEN 1 ELSE -1 END)
              FILTER (WHERE answered_at >= date_trunc('week', now())) AS week
     FROM trivia_questions WHERE user_id = $1 AND is_correct IS NOT NULL`,
    [userId],
  );
  return { allTime: Number(rows[0]?.all_time ?? 0), week: Number(rows[0]?.week ?? 0) };
}

// Records an answer once. Only the person the question was generated for can answer it.
export async function answer(user: User, id: string, choice: number): Promise<AnswerResult> {
  const { rows } = await db.query<Row>(
    `UPDATE trivia_questions
     SET answered_at = now(), chosen_index = $3, is_correct = (correct_index = $3), user_name = $4
     WHERE id = $1 AND user_id = $2 AND answered_at IS NULL
     RETURNING *`,
    [id, user.id, choice, user.name ?? user.username],
  );
  const row = rows[0];
  if (!row) throw new TriviaError('That question was already answered or doesn’t exist.', 409);
  return {
    correct: row.correct_index === choice,
    correctIndex: row.correct_index,
    explanation: row.explanation,
    path: row.path,
    headings: row.headings,
    scores: await scoresFor(user.id),
  };
}

// Skips the open question with no points either way, and reveals the answer.
export async function skip(user: User, id: string): Promise<Omit<AnswerResult, 'correct'>> {
  const { rows } = await db.query<Row>(
    `UPDATE trivia_questions SET answered_at = now()
     WHERE id = $1 AND user_id = $2 AND answered_at IS NULL RETURNING *`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) throw new TriviaError('That question was already answered or doesn’t exist.', 409);
  return {
    correctIndex: row.correct_index,
    explanation: row.explanation,
    path: row.path,
    headings: row.headings,
    scores: await scoresFor(user.id),
  };
}

export interface LeaderboardRow {
  userId: string;
  name: string;
  score: number;
  answered: number;
  correct: number;
}

// Weeks start on Monday (Postgres date_trunc('week')), in the database's time zone.
export async function leaderboard(period: 'all' | 'week', limit = 50): Promise<LeaderboardRow[]> {
  const { rows } = await db.query<{ user_id: string; name: string; score: string; answered: string; correct: string }>(
    `SELECT user_id,
            (array_agg(user_name ORDER BY answered_at DESC))[1] AS name,
            sum(CASE WHEN is_correct THEN 1 ELSE -1 END) AS score,
            count(*) AS answered,
            count(*) FILTER (WHERE is_correct) AS correct
     FROM trivia_questions
     WHERE is_correct IS NOT NULL ${period === 'week' ? "AND answered_at >= date_trunc('week', now())" : ''}
     GROUP BY user_id
     ORDER BY score DESC, correct DESC, name
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    score: Number(r.score),
    answered: Number(r.answered),
    correct: Number(r.correct),
  }));
}

export { LlmError };
