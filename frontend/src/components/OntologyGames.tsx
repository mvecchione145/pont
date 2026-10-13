import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Concept, type Ontology, type Relation } from '../api';
import { href, type Route } from '../route';
import { toRef } from '../zones';

// Games built from the approved ontology, alongside Trivia: flashcards for
// concepts (name ↔ definition) and a match game for relationships ("APPY
// uses …" ↔ "Xibo"). They run entirely in the browser, with no LLM and no
// cost, and don't affect the trivia leaderboard.

const human = (t: string) => t.replace(/_/g, ' ');

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Tabs shared by the game pages -----------------------------------------------

const GAMES: { view: 'trivia' | 'flashcards' | 'match'; label: string; ai?: boolean }[] = [
  { view: 'trivia', label: 'Trivia', ai: true },
  { view: 'flashcards', label: 'Flashcards' },
  { view: 'match', label: 'Match' },
];

export function GameTabs({ current }: { current: Route['view'] }) {
  return (
    <nav className="game-tabs" aria-label="Games">
      {GAMES.map((g) => (
        <a
          key={g.view}
          href={href({ view: g.view })}
          aria-current={current === g.view ? 'page' : undefined}
          title={g.ai ? 'Uses AI: each question is written by an LLM and incurs LLM costs' : 'Free: no AI involved'}
        >
          {g.label}
          {g.ai && (
            <span className="ai-star" aria-label="(uses AI, incurs LLM costs)">
              ✦
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}

// Every zone's ontology in one, with ids replaced by refs ("<zone>/<id>") so
// they stay unique and work as links.
async function allZones(): Promise<Ontology> {
  const zones = await api.zones();
  const parts = await Promise.all(zones.map(async ({ zone }) => ({ zone, ontology: await api.ontology(zone) })));
  return {
    concepts: parts.flatMap(({ zone, ontology }) => ontology.concepts.map((c) => ({ ...c, id: toRef(zone, c.id) }))),
    relations: parts.flatMap(({ zone, ontology }) =>
      ontology.relations.map((r) => ({ ...r, id: toRef(zone, r.id), from: toRef(zone, r.from), to: toRef(zone, r.to) })),
    ),
  };
}

function useOntology() {
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    allZones().then(setOntology, (err: Error) => setError(err.message));
  }, []);
  return { ontology, error };
}

function NotEnough({ what }: { what: string }) {
  return (
    <div className="empty-state">
      <p>{what}</p>
      <a className="button primary" href={href({ view: 'ontology' })}>
        Go to the Ontology
      </a>
    </div>
  );
}

// --- Flashcards -----------------------------------------------------------------

type Direction = 'name' | 'definition';

export function Flashcards() {
  const { ontology, error } = useOntology();
  const [type, setType] = useState('all');
  const [direction, setDirection] = useState<Direction>('name');
  const [queue, setQueue] = useState<string[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [learned, setLearned] = useState<string[]>([]);
  const [missed, setMissed] = useState<Set<string>>(new Set());

  const cards = useMemo(
    () => (ontology?.concepts ?? []).filter((c) => c.definition.trim() && (type === 'all' || c.type === type)),
    [ontology, type],
  );
  const types = useMemo(() => [...new Set((ontology?.concepts ?? []).map((c) => c.type))].sort(), [ontology]);
  const byId = useMemo(() => new Map((ontology?.concepts ?? []).map((c) => [c.id, c])), [ontology]);

  const start = useCallback((ids: string[]) => {
    setQueue(shuffle(ids));
    setLearned([]);
    setMissed(new Set());
    setFlipped(false);
  }, []);
  useEffect(() => start(cards.map((c) => c.id)), [cards, start]);

  const current = queue.length ? byId.get(queue[0]) : undefined;

  const answer = useCallback(
    (gotIt: boolean) => {
      if (!current || !flipped) return;
      setFlipped(false);
      setQueue(([head, ...rest]) => {
        if (gotIt) return rest;
        // Missed: see it again in a few cards.
        const at = Math.min(rest.length, 3);
        return [...rest.slice(0, at), head, ...rest.slice(at)];
      });
      if (gotIt) setLearned((l) => [...l, current.id]);
      else setMissed((m) => new Set(m).add(current.id));
    },
    [current, flipped],
  );

  // Keyboard: space flips, ← again, → got it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === 'ArrowLeft') answer(false);
      else if (e.key === 'ArrowRight') answer(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer]);

  const relationsOf = (c: Concept) =>
    (ontology?.relations ?? [])
      .filter((r) => r.from === c.id || r.to === c.id)
      .slice(0, 4)
      .map((r) =>
        r.from === c.id
          ? `${human(r.type)} ${byId.get(r.to)?.name ?? r.to}`
          : `${byId.get(r.from)?.name ?? r.from} ${human(r.type)} this`,
      );

  const front = (c: Concept) =>
    direction === 'name' ? (
      <>
        <span className="pill">{c.type}</span>
        <strong className="flashcard-term">{c.name}</strong>
        <span className="muted hint">What does it mean?</span>
      </>
    ) : (
      <>
        <span className="pill">{c.type}</span>
        <p className="flashcard-definition">{c.definition}</p>
        <span className="muted hint">What is it called?</span>
      </>
    );

  const back = (c: Concept) => (
    <>
      <strong className="flashcard-term small">{c.name}</strong>
      {c.aliases.length > 0 && <span className="muted">Also called {c.aliases.join(', ')}</span>}
      <p className="flashcard-definition">{c.definition}</p>
      {relationsOf(c).length > 0 && <p className="muted flashcard-relations">→ {relationsOf(c).join(' · ')}</p>}
      <a className="hint" href={href({ view: 'concept', id: c.id })} onClick={(e) => e.stopPropagation()}>
        Open concept
      </a>
    </>
  );

  return (
    <section className="game">
      <GameTabs current="flashcards" />
      <h1 className="page-title static">Flashcards</h1>
      {error && <p className="down">{error}</p>}
      {!ontology ? (
        !error && <p className="muted">Loading…</p>
      ) : (ontology.concepts.filter((c) => c.definition.trim()).length === 0 ? (
        <NotEnough what="Flashcards need concepts with definitions." />
      ) : (
        <>
          <div className="game-controls">
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Concept type">
              <option value="all">All types</option>
              {types.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <div className="tabs" role="tablist" aria-label="Card front">
              <button role="tab" aria-selected={direction === 'name'} onClick={() => setDirection('name')}>
                Name first
              </button>
              <button role="tab" aria-selected={direction === 'definition'} onClick={() => setDirection('definition')}>
                Definition first
              </button>
            </div>
            <span className="muted game-progress">
              {learned.length} of {cards.length} learned
            </span>
          </div>
          <div className="game-bar" aria-hidden>
            <div style={{ width: `${cards.length ? (learned.length / cards.length) * 100 : 0}%` }} />
          </div>

          {current ? (
            <>
              <button
                className={`flashcard ${flipped ? 'flipped' : ''}`}
                onClick={() => setFlipped(!flipped)}
                aria-label={flipped ? 'Card back; click to flip' : 'Card front; click to flip'}
              >
                <div className="flashcard-inner">
                  <div className="flashcard-face front">{front(current)}</div>
                  <div className="flashcard-face back">{back(current)}</div>
                </div>
              </button>
              <div className="flashcard-actions">
                {flipped ? (
                  <>
                    <button onClick={() => answer(false)}>← Again</button>
                    <button className="primary" onClick={() => answer(true)}>
                      Got it →
                    </button>
                  </>
                ) : (
                  <button onClick={() => setFlipped(true)}>Flip (space)</button>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state game-done">
              <p>
                <strong>Deck done!</strong> You worked through all {cards.length} cards
                {missed.size ? `, and missed ${missed.size} along the way.` : ' without a miss.'}
              </p>
              <div className="actions">
                {missed.size > 0 && (
                  <button className="primary" onClick={() => start([...missed])}>
                    Practice the {missed.size} I missed
                  </button>
                )}
                <button onClick={() => start(cards.map((c) => c.id))}>Study the deck again</button>
              </div>
            </div>
          )}
        </>
      ))}
    </section>
  );
}

// --- Match ----------------------------------------------------------------------

const ROUND = 6;
const BEST_KEY = 'pont.match.best';

interface Pair {
  relation: Relation;
  prompt: string;
  answer: string;
}

// Picks a round of relationships where every prompt has exactly one right
// answer among the round's answers, so no correct-looking match is refused.
function pickRound(ontology: Ontology): Pair[] {
  const name = new Map(ontology.concepts.map((c) => [c.id, c.name]));
  const exists = new Set(ontology.relations.map((r) => `${r.from}|${r.type}|${r.to}`));
  const chosen: Relation[] = [];
  for (const r of shuffle(ontology.relations)) {
    if (chosen.length >= ROUND) break;
    if (!name.has(r.from) || !name.has(r.to) || r.from === r.to) continue;
    const clash = chosen.some(
      (c) =>
        (c.from === r.from && c.type === r.type) ||
        c.to === r.to ||
        exists.has(`${c.from}|${c.type}|${r.to}`) ||
        exists.has(`${r.from}|${r.type}|${c.to}`),
    );
    if (!clash) chosen.push(r);
  }
  return chosen.map((r) => ({
    relation: r,
    prompt: `${name.get(r.from)} ${human(r.type)} …`,
    answer: name.get(r.to)!,
  }));
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function readBest(): number | null {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function MatchGame() {
  const { ontology, error } = useOntology();
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ side: 'prompt' | 'answer'; index: number } | null>(null);
  const [matched, setMatched] = useState<Set<number>>(new Set());
  const [wrong, setWrong] = useState<{ prompt: number; answer: number } | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedIn, setFinishedIn] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [best, setBest] = useState<number | null>(readBest);
  const wrongTimer = useRef<number | undefined>(undefined);

  const newRound = useCallback(() => {
    if (!ontology) return;
    const round = pickRound(ontology);
    setPairs(round);
    setAnswers(shuffle(round.map((p) => p.answer)));
    setSelected(null);
    setMatched(new Set());
    setWrong(null);
    setMistakes(0);
    setStartedAt(null);
    setFinishedIn(null);
  }, [ontology]);
  useEffect(newRound, [newRound]);

  // Tick the clock while a round is being played.
  useEffect(() => {
    if (!startedAt || finishedIn !== null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [startedAt, finishedIn]);

  function pick(side: 'prompt' | 'answer', index: number) {
    if (finishedIn !== null) return;
    const answerMatched = side === 'answer' && [...matched].some((m) => pairs[m].answer === answers[index]);
    if ((side === 'prompt' && matched.has(index)) || answerMatched) return;
    if (!startedAt) setStartedAt(Date.now());
    if (!selected || selected.side === side) {
      setSelected({ side, index });
      return;
    }
    const prompt = side === 'prompt' ? index : selected.index;
    const answer = side === 'answer' ? index : selected.index;
    setSelected(null);
    if (pairs[prompt].answer === answers[answer]) {
      const done = new Set(matched).add(prompt);
      setMatched(done);
      if (done.size === pairs.length) {
        const took = Date.now() - (startedAt ?? Date.now());
        setFinishedIn(took);
        if (!best || took < best) {
          setBest(took);
          try {
            localStorage.setItem(BEST_KEY, String(took));
          } catch {
            // Best time is a convenience; ignore storage failures.
          }
        }
      }
    } else {
      setMistakes((m) => m + 1);
      setWrong({ prompt, answer });
      window.clearTimeout(wrongTimer.current);
      wrongTimer.current = window.setTimeout(() => setWrong(null), 600);
    }
  }

  const answerDone = (i: number) => [...matched].some((m) => pairs[m].answer === answers[i]);
  const usable = (ontology?.relations ?? []).length;

  return (
    <section className="game">
      <GameTabs current="match" />
      <h1 className="page-title static">Match</h1>
      {error && <p className="down">{error}</p>}
      {!ontology ? (
        !error && <p className="muted">Loading…</p>
      ) : usable < 2 || pairs.length < 2 ? (
        <NotEnough what="Match needs at least two relationships." />
      ) : (
        <>
          <div className="game-controls">
            <span className="match-clock" aria-live="off">
              ⏱ {clock(finishedIn ?? (startedAt ? now - startedAt : 0))}
            </span>
            <span className="muted">
              {matched.size} of {pairs.length} matched · {mistakes} {mistakes === 1 ? 'mistake' : 'mistakes'}
              {best && ` · best ${clock(best)}`}
            </span>
            <button onClick={newRound}>New round</button>
          </div>

          <div className="match-board">
            <ul aria-label="Relationships">
              {pairs.map((p, i) => (
                <li key={p.relation.id}>
                  <button
                    className={`match-tile ${matched.has(i) ? 'matched' : ''} ${selected?.side === 'prompt' && selected.index === i ? 'selected' : ''} ${wrong?.prompt === i ? 'wrong' : ''}`}
                    onClick={() => pick('prompt', i)}
                    disabled={matched.has(i)}
                  >
                    {matched.has(i) ? (
                      <>
                        {p.prompt.replace(/ …$/, '')} <strong>{p.answer}</strong>
                        {p.relation.name && <span className="muted"> · {p.relation.name}</span>}
                      </>
                    ) : (
                      p.prompt
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <ul aria-label="Concepts">
              {answers.map((a, i) => (
                <li key={a}>
                  <button
                    className={`match-tile answer ${answerDone(i) ? 'matched' : ''} ${selected?.side === 'answer' && selected.index === i ? 'selected' : ''} ${wrong?.answer === i ? 'wrong' : ''}`}
                    onClick={() => pick('answer', i)}
                    disabled={answerDone(i)}
                  >
                    {a}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {finishedIn !== null && (
            <div className="empty-state game-done">
              <p>
                <strong>All matched in {clock(finishedIn)}</strong> with {mistakes}{' '}
                {mistakes === 1 ? 'mistake' : 'mistakes'}.{best === finishedIn && ' New best time!'}
              </p>
              <button className="primary" onClick={newRound}>
                Next round
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
