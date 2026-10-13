import { useEffect, useState } from 'react';
import {
  api,
  type PageReview,
  type ReviewConflict,
  type ReviewEstimate,
  type ReviewLink,
  type ReviewSuggestion,
} from '../api';
import { href } from '../route';
import { DeadLinkList, useDeadLinks } from './DeadLinks';

// The page review side panel: asks before spending on the LLM, runs the review
// in the background, and lists suggestions, conflicts, and missing ontology
// links that can be applied to the page (as a new version) or dismissed.

const POLL_MS = 2000;
const money = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const CATEGORY: Record<string, string> = {
  clarity: 'Clarity',
  ambiguity: 'Ambiguous',
  structure: 'Structure',
  missing_context: 'Missing context',
  terminology: 'Terminology',
  typo: 'Typo',
};
const CORRECT: Record<ReviewConflict['likelyCorrect'], string> = {
  this_page: 'This page looks right',
  other_page: 'The other page looks right',
  unclear: 'Unclear which is right',
};

// Scrolls the editor to the block containing (the start of) a quote and
// flashes it. Markdown syntax is stripped so it matches the rendered text.
function showInEditor(quote: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const text = norm(
    quote
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
      .replace(/[*_`~]/g, ''),
  );
  const snippet = text.slice(0, 60);
  if (!snippet) return false;
  const blocks = document.querySelectorAll<HTMLElement>(
    '.editor-root .ProseMirror :is(p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote)',
  );
  const target = [...blocks].reverse().find((b) => norm(b.textContent ?? '').includes(snippet));
  if (!target) return false;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => {
    const rect = target.getBoundingClientRect();
    const flash = document.createElement('div');
    flash.className = 'fact-check-flash';
    Object.assign(flash.style, {
      top: `${rect.top + window.scrollY - 4}px`,
      left: `${rect.left + window.scrollX - 8}px`,
      width: `${rect.width + 16}px`,
      height: `${rect.height + 8}px`,
    });
    document.body.appendChild(flash);
    window.setTimeout(() => flash.remove(), 2600);
  }, 350);
  return true;
}

function Change({ quote, replacement }: { quote: string; replacement: string }) {
  return (
    <div className="review-change">
      <del>{quote}</del>
      {replacement && <ins>{replacement}</ins>}
    </div>
  );
}

interface ItemActions {
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
}

function Actions({ applicable, quote, busy, onApply, onDismiss }: ItemActions & { applicable: boolean; quote: string }) {
  const [missing, setMissing] = useState(false);
  return (
    <div className="review-item-actions">
      {applicable && (
        <button className="primary" disabled={busy} onClick={onApply}>
          Apply
        </button>
      )}
      <button
        disabled={busy}
        onClick={() => {
          setMissing(!showInEditor(quote));
        }}
      >
        Show
      </button>
      <button disabled={busy} onClick={onDismiss}>
        Dismiss
      </button>
      {missing && <span className="muted">Not found in the editor.</span>}
    </div>
  );
}

function SuggestionCard({ s, ...actions }: { s: ReviewSuggestion } & ItemActions) {
  return (
    <li className="review-item">
      <div className="review-item-head">
        <span className="pill">{CATEGORY[s.category] ?? s.category}</span>
      </div>
      <p>{s.reason}</p>
      <Change quote={s.quote} replacement={s.replacement} />
      {!s.applicable && <p className="muted hint">This text appears more than once on the page; edit it by hand.</p>}
      <Actions applicable={s.applicable} quote={s.quote} {...actions} />
    </li>
  );
}

function ConflictCard({ c, ...actions }: { c: ReviewConflict } & ItemActions) {
  return (
    <li className="review-item conflict">
      <div className="review-item-head">
        <span className="pill conflict">Conflict</span>
        <span className="muted">{CORRECT[c.likelyCorrect]}</span>
      </div>
      <p>{c.explanation}</p>
      <div className="review-sides">
        <div>
          <span className="muted">This page</span>
          <q>{c.quote}</q>
        </div>
        <div>
          <span className="muted">
            <a href={href({ view: 'page', path: c.otherPath, section: c.otherSection.split(' > ').pop() || undefined, check: true })}>
              {c.otherPath}
            </a>
            {c.otherSection && <> · {c.otherSection}</>}
          </span>
          <q>{c.otherQuote}</q>
        </div>
      </div>
      {c.applicable && (
        <>
          <span className="muted hint">Suggested fix on this page:</span>
          <Change quote={c.quote} replacement={c.replacement} />
        </>
      )}
      {c.likelyCorrect === 'this_page' && <p className="muted hint">If so, fix the other page instead.</p>}
      <Actions applicable={c.applicable} quote={c.found ? c.quote : ''} {...actions} />
    </li>
  );
}

// Shows the mention in its sentence, with the term emphasised.
function InContext({ context, term }: { context: string; term: string }) {
  const at = context.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return <q>{context}</q>;
  return (
    <q>
      {context.slice(0, at)}
      <mark>{context.slice(at, at + term.length)}</mark>
      {context.slice(at + term.length)}
    </q>
  );
}

function LinkCard({ l, ...actions }: { l: ReviewLink } & ItemActions) {
  return (
    <li className="review-item link">
      <div className="review-item-head">
        <span className="pill">{l.targetType}</span>
      </div>
      <p>
        Link “{l.term}” to{' '}
        <a href={href({ view: l.kind, id: l.targetId })} target="_blank" rel="noreferrer">
          {l.targetName}
        </a>
      </p>
      <p className="review-context">
        <InContext context={l.context} term={l.term} />
      </p>
      {l.reason && <p className="muted hint">{l.reason}</p>}
      <div className="review-item-actions">
        <button className="primary" disabled={actions.busy} onClick={actions.onApply}>
          Add link
        </button>
        <button disabled={actions.busy} onClick={() => showInEditor(l.context.replace(/^…|…$/g, ''))}>
          Show
        </button>
        <button disabled={actions.busy} onClick={actions.onDismiss}>
          Dismiss
        </button>
      </div>
    </li>
  );
}

interface Props {
  path: string;
  // The page version shown in the editor, to tell whether the review is stale.
  currentVersionId: string | null;
  // Saves any pending edits; resolves false if the page can't be saved.
  beforeApply: () => Promise<boolean>;
  // Called after a suggestion was saved to the page, to reload the editor.
  onApplied: () => void;
  // The page is linked to a file on GitHub: no link fixes are offered (links
  // are edited in the GitHub file), and Apply edits the unpublished draft.
  githubLinked?: boolean;
  // Applies a suggestion to the draft in the editor; false if the quoted text
  // isn't in the draft exactly once.
  applyToDraft?: (quote: string, replacement: string) => boolean;
  onClose: () => void;
}

export function ReviewPanel({
  path,
  currentVersionId,
  beforeApply,
  onApplied,
  githubLinked = false,
  applyToDraft,
  onClose,
}: Props) {
  const [review, setReview] = useState<PageReview | null | undefined>(undefined);
  const [estimate, setEstimate] = useState<ReviewEstimate | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHandled, setShowHandled] = useState(false);
  // Dead links are checked without the LLM, as soon as the panel opens.
  const dead = useDeadLinks(path, !githubLinked);

  useEffect(() => {
    let cancelled = false;
    setReview(undefined);
    setConfirming(false);
    api.latestReview(path).then(
      (r) => !cancelled && setReview(r),
      (err: Error) => !cancelled && (setReview(null), setError(err.message)),
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Poll while the review runs.
  const runningId = review?.status === 'running' ? review.id : null;
  useEffect(() => {
    if (!runningId) return;
    const timer = window.setInterval(() => {
      api.review(runningId).then((r) => r.status !== 'running' && setReview(r), () => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [runningId]);

  async function ask() {
    setError(null);
    setConfirming(true);
    setEstimate(undefined);
    try {
      // GitHub-linked pages have no autosave to wait for: their draft stays in the editor.
      if (!githubLinked && !(await beforeApply())) {
        throw new Error('Save the page first (it has unsaved changes that could not be saved).');
      }
      setEstimate(await api.reviewEstimate(path));
    } catch (err) {
      setConfirming(false);
      setError((err as Error).message);
    }
  }

  async function start() {
    setStarting(true);
    setError(null);
    try {
      setReview(await api.startReview(path));
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function decide(itemId: string, action: 'apply' | 'dismiss') {
    if (!review) return;
    setBusyItem(itemId);
    setError(null);
    try {
      if (action === 'apply' && applyToDraft) {
        // GitHub-linked page: edit the draft, then record the suggestion as applied.
        const item = [...(review.result?.suggestions ?? []), ...(review.result?.conflicts ?? [])].find((x) => x.id === itemId);
        if (!item || !applyToDraft(item.quote, item.replacement)) {
          throw new Error("That text isn't in your draft any more (or appears more than once); edit it by hand.");
        }
        setReview(await api.decideReviewItem(review.id, itemId, 'accept'));
        return;
      }
      if (action === 'apply' && !(await beforeApply())) {
        throw new Error('Your latest edits could not be saved, so nothing was applied.');
      }
      const updated = await api.decideReviewItem(review.id, itemId, action);
      setReview(updated);
      if (action === 'apply') {
        onApplied();
        dead.reload();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyItem(null);
    }
  }

  const result = review?.status === 'succeeded' ? review.result : null;
  const openSuggestions = result?.suggestions.filter((s) => s.state === 'open') ?? [];
  const openConflicts = result?.conflicts.filter((c) => c.state === 'open') ?? [];
  const links = result?.links ?? [];
  const openLinks = links.filter((l) => l.state === 'open');
  const handled = result
    ? [
        ...[...result.suggestions, ...result.conflicts].map((x) => ({ id: x.id, state: x.state, label: x.quote })),
        ...links.map((l) => ({ id: l.id, state: l.state, label: `Link “${l.term}” to ${l.targetName}` })),
      ].filter((x) => x.state !== 'open')
    : [];
  const stale = Boolean(review && currentVersionId && review.versionId && review.versionId !== currentVersionId);
  const actions = (id: string) => ({
    busy: busyItem !== null,
    onApply: () => void decide(id, 'apply'),
    onDismiss: () => void decide(id, 'dismiss'),
  });

  return (
    <aside className="review-panel" aria-label="Page review">
      <header>
        <h2>Review</h2>
        <button className="icon-button" aria-label="Close review" onClick={onClose}>
          ×
        </button>
      </header>

      {error && <p className="down review-error">{error}</p>}

      {!githubLinked && dead.links && dead.links.length > 0 && !confirming && (
        <div className="review-dead">
          <h3>Dead links ({dead.links.length})</h3>
          <DeadLinkList
            path={path}
            links={dead.links}
            beforeFix={beforeApply}
            onFixed={() => {
              dead.reload();
              onApplied();
            }}
          />
        </div>
      )}

      {confirming ? (
        <div className="review-confirm">
          {estimate === undefined ? (
            <p className="muted">Finding related pages…</p>
          ) : estimate === null ? (
            <p>
              Set up an LLM in <a href={href({ view: 'settings' })}>Settings</a> first.
            </p>
          ) : (
            <>
              <p>
                This sends the page{' '}
                {estimate.compared.length > 0 && (
                  <>
                    and {estimate.passages} related {estimate.passages === 1 ? 'passage' : 'passages'} from{' '}
                    {estimate.compared.length} other {estimate.compared.length === 1 ? 'page' : 'pages'}{' '}
                  </>
                )}
                to <strong>{estimate.provider === 'anthropic' ? 'Anthropic' : 'your OpenAI-compatible provider'}</strong>{' '}
                ({estimate.model}). <strong>It will incur LLM costs.</strong>
              </p>
              {estimate.linkCandidates > 0 && (
                <p className="muted">
                  It also checks {estimate.linkCandidates} ontology{' '}
                  {estimate.linkCandidates === 1 ? 'term that appears' : 'terms that appear'} on the page without a link.
                </p>
              )}
              <p className="muted">
                ~{tokens(estimate.inputTokens)} input + ~{tokens(estimate.outputTokens)} output tokens
                {estimate.costUsd && <> · {money(estimate.costUsd.low)} – {money(estimate.costUsd.high)}</>}
              </p>
              {estimate.compared.length > 0 && (
                <details>
                  <summary>Compared against</summary>
                  <ul className="plain-list">
                    {estimate.compared.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          <div className="actions">
            {estimate && (
              <button className="primary" onClick={start} disabled={starting}>
                {starting ? 'Starting…' : 'Yes, review'}
              </button>
            )}
            <button onClick={() => setConfirming(false)} disabled={starting}>
              Cancel
            </button>
          </div>
        </div>
      ) : review === undefined ? (
        <p className="muted">Loading…</p>
      ) : review?.status === 'running' ? (
        <div className="review-running">
          <span className="spinner" aria-hidden />
          <div>
            <strong>Reviewing…</strong>
            <p className="muted">
              Reading the page
              {review.compared.length > 0 && ` and comparing it with ${review.compared.length} related pages`}…
            </p>
          </div>
        </div>
      ) : (
        <>
          <button className={review ? undefined : 'primary'} onClick={ask}>
            {review ? 'Review again' : 'Review this page'}
          </button>
        </>
      )}

      {review?.status === 'failed' && !confirming && <p className="down">The review failed: {review.error}</p>}

      {result && !confirming && (
        <div className="review-result">
          <p className="muted hint">
            By {review!.startedBy} on {new Date(review!.startedAt).toLocaleString()}
            {review!.usage.costUsd != null && ` · ≈${money(review!.usage.costUsd)}`}
            {review!.compared.length > 0 && ` · compared with ${review!.compared.length} pages`}
          </p>
          {stale && (
            <p className="review-stale">The page changed since this review; some suggestions may no longer apply.</p>
          )}
          <p className="review-summary">{result.summary}</p>

          <h3>Conflicts ({openConflicts.length})</h3>
          {openConflicts.length === 0 ? (
            <p className="muted">
              {result.conflicts.length ? 'All handled.' : 'No contradictions with related pages were found.'}
            </p>
          ) : (
            <ul>
              {openConflicts.map((c) => (
                <ConflictCard key={c.id} c={c} {...actions(c.id)} />
              ))}
            </ul>
          )}

          {result.links && !githubLinked && (
            <>
              <h3>Missing links ({openLinks.length})</h3>
              {openLinks.length === 0 ? (
                <p className="muted">
                  {links.length ? 'All handled.' : 'Every ontology term on this page is linked, or none appear.'}
                </p>
              ) : (
                <ul>
                  {openLinks.map((l) => (
                    <LinkCard key={l.id} l={l} {...actions(l.id)} />
                  ))}
                </ul>
              )}
            </>
          )}

          <h3>Suggestions ({openSuggestions.length})</h3>
          {openSuggestions.length === 0 ? (
            <p className="muted">{result.suggestions.length ? 'All handled.' : 'Nothing to suggest; the page reads clearly.'}</p>
          ) : (
            <ul>
              {openSuggestions.map((s) => (
                <SuggestionCard key={s.id} s={s} {...actions(s.id)} />
              ))}
            </ul>
          )}

          {handled.length > 0 && (
            <>
              <button className="link-button" onClick={() => setShowHandled(!showHandled)}>
                {showHandled ? 'Hide' : 'Show'} {handled.length} handled
              </button>
              {showHandled && (
                <ul className="review-handled">
                  {handled.map((x) => (
                    <li key={x.id} className="muted">
                      <span className={x.state === 'applied' ? 'up' : undefined}>{x.state === 'applied' ? 'Applied' : 'Dismissed'}</span>
                      : {x.label.length > 80 ? `${x.label.slice(0, 80)}…` : x.label}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
