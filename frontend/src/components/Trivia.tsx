import { useCallback, useEffect, useState } from 'react';
import { api, type LeaderboardRow, type Scores, type TriviaQuestion, type TriviaResult, type User } from '../api';
import { href, nameOf, navigate } from '../route';
import { GameTabs } from './OntologyGames';

const LETTERS = ['A', 'B', 'C', 'D'];
// A per-question cost range, in cents when small: "1–2¢", "$0.10–$0.40".
function costRange({ low, high }: { low: number; high: number }): string {
  if (high < 1) {
    const lo = Math.max(1, Math.round(low * 100));
    const hi = Math.max(lo, Math.ceil(high * 100));
    return lo === hi ? `${lo}¢` : `${lo}–${hi}¢`;
  }
  return `$${low.toFixed(2)}–$${high.toFixed(2)}`;
}

function Leaderboard({ me, refreshKey }: { me: User | null; refreshKey: number }) {
  const [period, setPeriod] = useState<'all' | 'week'>('week');
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    api.leaderboard(period).then(setRows, () => setRows([]));
  }, [period, refreshKey]);

  return (
    <aside className="leaderboard">
      <div className="leaderboard-head">
        <h2>Leaderboard</h2>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={period === 'week'} onClick={() => setPeriod('week')}>
            This week
          </button>
          <button role="tab" aria-selected={period === 'all'} onClick={() => setPeriod('all')}>
            All time
          </button>
        </div>
      </div>
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No scores yet{period === 'week' ? ' this week' : ''}. Be the first!</p>
      ) : (
        <ol className="ranks">
          {rows.map((r, i) => (
            <li key={r.userId} className={r.userId === me?.id ? 'me' : undefined}>
              <span className="rank">{i + 1}</span>
              <span className="name">{r.name}</span>
              <span className="muted record">
                {r.correct}/{r.answered}
              </span>
              <span className={`score ${r.score < 0 ? 'down' : ''}`}>{r.score > 0 ? `+${r.score}` : r.score}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="muted rules">+1 for a correct answer, −1 for a wrong one. Weeks start on Monday.</p>
    </aside>
  );
}

interface Props {
  user: User | null;
}

export function Trivia({ user }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [question, setQuestion] = useState<TriviaQuestion | null>(null);
  const [result, setResult] = useState<(TriviaResult & { chosen: number | null }) | null>(null);
  const [scores, setScores] = useState<Scores | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'answering'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cost, setCost] = useState<Awaited<ReturnType<typeof api.triviaCost>>>(null);

  useEffect(() => {
    api.getLlmSettings().then((s) => setConfigured(s.configured), () => setConfigured(false));
    api.triviaCost().then(setCost, () => undefined);
    api.currentQuestion().then(setQuestion, (err: Error) => setError(err.message));
  }, []);

  const next = useCallback(async () => {
    setState('loading');
    setError(null);
    setResult(null);
    try {
      setQuestion(await api.nextQuestion());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setState('idle');
    }
  }, []);

  const choose = useCallback(
    async (choice: number) => {
      if (!question || result || state !== 'idle') return;
      setState('answering');
      try {
        const r = await api.answer(question.id, choice);
        setResult({ ...r, chosen: choice });
        setScores(r.scores);
        setRefreshKey((k) => k + 1);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setState('idle');
      }
    },
    [question, result, state],
  );

  async function skip() {
    if (!question || result) return;
    try {
      const r = await api.skip(question.id);
      setResult({ ...r, chosen: null });
      setScores(r.scores);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Keyboard: 1-4 or A-D to answer, Enter or N for the next question.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) return;
      const key = e.key.toLowerCase();
      const index = ['1', '2', '3', '4'].indexOf(key) >= 0 ? Number(key) - 1 : ['a', 'b', 'c', 'd'].indexOf(key);
      if (question && !result && index >= 0) {
        e.preventDefault();
        void choose(index);
      } else if ((key === 'enter' || key === 'n') && (result || !question) && state === 'idle') {
        e.preventDefault();
        void next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [question, result, state, choose, next]);

  const section = (path: string, headings: string) => (headings ? `${nameOf(path)} › ${headings}` : nameOf(path));
  const factCheck = () =>
    result &&
    navigate({
      view: 'page',
      path: result.path,
      section: result.headings.split(' > ').pop() || nameOf(result.path),
      check: true,
    });

  return (
    <div className="trivia-layout">
      <section className="trivia">
        <GameTabs current="trivia" />
        <h1 className="page-title static">Trivia</h1>
        <p className="lead">
          How well do you know your docs? Questions are written on the fly from a random page.
          {scores && (
            <>
              {' '}
              Your score: <strong>{scores.week}</strong> this week, <strong>{scores.allTime}</strong> all time.
            </>
          )}
        </p>

        {configured && (
          <div className="ai-notice" role="note">
            <span className="ai-star" aria-hidden>
              ✦
            </span>
            <span>
              <strong>Uses AI, which costs money.</strong> Each question is written by{' '}
              {cost ? (
                <>
                  {cost.model} ({cost.provider === 'anthropic' ? 'Anthropic' : 'your OpenAI-compatible provider'})
                </>
              ) : (
                'the LLM set up in Settings'
              )}{' '}
              and incurs LLM costs on that account
              {cost?.costUsd && (
                <>
                  , about {costRange(cost.costUsd)} per question
                </>
              )}
              . Flashcards and Match are free.
            </span>
          </div>
        )}

        {configured === false && (
          <div className="empty-state">
            <p>Trivia needs an LLM to write questions.</p>
            <a className="button primary" href={href({ view: 'settings' })}>
              Set it up in Settings
            </a>
          </div>
        )}

        {error && <div className="banner"><span>{error}</span></div>}

        {configured && !question && state !== 'loading' && (
          <div className="empty-state">
            <p>Ready? Each question comes from a real section of your documentation.</p>
            <button className="primary" onClick={next} title="Writes a question with the LLM (incurs LLM costs)">
              ✦ Start
            </button>
          </div>
        )}

        {state === 'loading' && <div className="question-card loading">Writing a question from your docs…</div>}

        {question && state !== 'loading' && (
          <div className="question-card">
            <p className="question-source muted">From {section(question.path, question.headings)}</p>
            <h2 className="question-text">{question.question}</h2>
            <ol className="options">
              {question.options.map((option, i) => {
                const status = !result
                  ? ''
                  : i === result.correctIndex
                    ? 'right'
                    : i === result.chosen
                      ? 'wrong'
                      : 'dim';
                return (
                  <li key={i}>
                    <button
                      className={`option ${status}`}
                      onClick={() => choose(i)}
                      disabled={Boolean(result) || state !== 'idle'}
                    >
                      <span className="letter">{LETTERS[i]}</span>
                      <span>{option}</span>
                    </button>
                  </li>
                );
              })}
            </ol>

            {!result ? (
              <div className="question-actions">
                <span className="muted hint">Press 1–4 to answer.</span>
                <button onClick={skip} disabled={state !== 'idle'}>
                  Skip (no points)
                </button>
              </div>
            ) : (
              <div className="verdict">
                <p>
                  <strong className={result.correct === undefined ? 'muted' : result.correct ? 'up' : 'down'}>
                    {result.correct === undefined ? 'Skipped.' : result.correct ? 'Correct! +1' : 'Not quite. −1'}
                  </strong>{' '}
                  {result.explanation}
                </p>
                <div className="question-actions">
                  <button onClick={factCheck} title="Open the section this question came from and fix anything that's wrong">
                    Fact check this section
                  </button>
                  <button className="primary" onClick={next} title="Writes a question with the LLM (incurs LLM costs)">
                    ✦ Next question
                  </button>
                </div>
                <p className="muted hint">
                  Was the question wrong or confusing? The docs may be out of date: fact check them.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <Leaderboard me={user} refreshKey={refreshKey} />
    </div>
  );
}
