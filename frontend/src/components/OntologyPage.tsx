import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  CONCEPT_TYPES,
  type ChangePreview,
  type Concept,
  type Ontology,
  type OntologyRecommendation,
  type OntologyRun,
} from '../api';
import { href, navigate } from '../route';
import { OntologyGraph } from './OntologyGraph';
import { toRef, zoneName, type ZoneSummary } from '../zones';

const POLL_MS = 2000;

const money = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const humanType = (t: string) => t.replace(/_/g, ' ');

function pageLink(path: string, quote?: string) {
  return (
    <a href={href({ view: 'page', path })} title={quote}>
      {path}
    </a>
  );
}

// --- The "are you sure" dialog ---------------------------------------------

function ConfirmDialog({
  zone,
  preview,
  onConfirm,
  onClose,
  busy,
}: {
  zone: string;
  preview: ChangePreview;
  onConfirm: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const e = preview.estimate!;
  const groups: [string, string[]][] = [
    ['New', preview.added],
    ['Changed', preview.modified],
    ['Deleted', preview.deleted],
  ];
  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="confirm-dialog" role="alertdialog" aria-labelledby="confirm-title" onMouseDown={(ev) => ev.stopPropagation()}>
        <h2 id="confirm-title">Calculate the {zoneName(zone)} ontology?</h2>
        <p>
          This sends <strong>{preview.total} changed {preview.total === 1 ? 'page' : 'pages'}</strong> to{' '}
          <strong>{e.provider === 'anthropic' ? 'Anthropic' : 'your OpenAI-compatible provider'}</strong> ({e.model}),
          where two agents look for updates and new concepts. <strong>It will incur LLM costs</strong> on that
          account.
        </p>
        <div className="cost-box">
          <div>
            <span className="muted">Estimated usage</span>
            <strong>
              ~{tokens(e.inputTokens)} input + ~{tokens(e.outputTokens)} output tokens
            </strong>
            <span className="muted">{e.batches} {e.batches === 1 ? 'batch' : 'batches'}</span>
          </div>
          <div>
            <span className="muted">Estimated cost</span>
            <strong>{e.costUsd ? `${money(e.costUsd.low)} – ${money(e.costUsd.high)}` : 'Unknown for this model'}</strong>
            <span className="muted">at list prices; the agents decide how much to read</span>
          </div>
        </div>
        <details className="change-list">
          <summary>Which pages</summary>
          {groups
            .filter(([, paths]) => paths.length)
            .map(([label, paths]) => (
              <div key={label}>
                <strong>{label}</strong>
                <ul>
                  {paths.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ))}
        </details>
        <div className="actions end">
          <button onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </button>
          <button className="primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Starting…' : 'Yes, calculate'}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Recommendations --------------------------------------------------------

function describe(rec: OntologyRecommendation, ontology: Ontology | null): { title: string; detail?: string } {
  const p = rec.payload as Record<string, string & string[]>;
  const concept = (id: string) => ontology?.concepts.find((c) => c.id === id)?.name ?? id;
  switch (rec.action) {
    case 'create_concept':
      return {
        title: `New ${p.type}: ${p.name}`,
        detail: [p.definition, p.aliases?.length ? `Also called: ${p.aliases.join(', ')}` : ''].filter(Boolean).join(' · '),
      };
    case 'update_concept': {
      const changes = (['name', 'type', 'definition', 'aliases'] as const)
        .filter((k) => p[k] !== undefined)
        .map((k) => `${k}: ${Array.isArray(p[k]) ? (p[k] as string[]).join(', ') : p[k]}`);
      return { title: `Update ${concept(p.conceptId)}`, detail: changes.join(' · ') };
    }
    case 'delete_concept':
      return { title: `Delete ${concept(p.conceptId)}` };
    case 'add_alias':
      return { title: `Alias for ${concept(p.conceptId)}: “${p.alias}”` };
    case 'create_relation':
      return { title: `${concept(p.from)} ${humanType(p.type)} ${concept(p.to)}` };
    case 'delete_relation': {
      const r = ontology?.relations.find((x) => x.id === p.relationId);
      return { title: `Delete relationship: ${r ? `${concept(r.from)} ${humanType(r.type)} ${concept(r.to)}` : p.relationId}` };
    }
  }
}

function RecommendationCard({
  rec,
  ontology,
  onDecided,
}: {
  rec: OntologyRecommendation;
  ontology: Ontology | null;
  onDecided: (id: string, outcome: { ok: boolean; message: string; keep?: boolean }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { title, detail } = describe(rec, ontology);

  async function act(kind: 'approve' | 'reject') {
    setBusy(true);
    try {
      if (kind === 'approve') {
        const r = await api.approveRecommendation(rec.id);
        onDecided(rec.id, { ok: r.status === 'approved', message: r.message });
      } else {
        await api.rejectRecommendation(rec.id);
        onDecided(rec.id, { ok: true, message: 'Rejected.' });
      }
    } catch (err) {
      // e.g. "Approve the concepts … first": the recommendation stays pending.
      onDecided(rec.id, { ok: false, message: (err as Error).message, keep: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`rec-card ${rec.action.startsWith('delete') ? 'destructive' : ''}`}>
      <div className="rec-main">
        <div className="rec-title">
          <strong>{title}</strong>
          {rec.workflow !== 'agent' && (
            <span className="pill" title="How sure the agent was">
              {Math.round(rec.confidence * 100)}%
            </span>
          )}
        </div>
        {detail && <p className="rec-detail">{detail}</p>}
        <p className="muted rec-rationale">
          {rec.proposedBy && <>Proposed by {rec.proposedBy}’s agent: </>}
          {rec.rationale}
        </p>
        <ul className="evidence">
          {rec.evidence.map((e, i) => (
            <li key={i}>
              <q>{e.quote}</q> — {pageLink(e.path, e.quote)}
            </li>
          ))}
        </ul>
      </div>
      <div className="rec-actions">
        <button className="primary" onClick={() => act('approve')} disabled={busy}>
          Approve
        </button>
        <button onClick={() => act('reject')} disabled={busy}>
          Reject
        </button>
      </div>
    </li>
  );
}

// "Approve all" / "Reject all" for a set of recommendations, with an inline
// confirmation that says what is about to happen.
function BulkActions({
  items,
  scope,
  onDone,
}: {
  items: OntologyRecommendation[];
  scope: string;
  onDone: (action: 'approve' | 'reject', ids: string[]) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  if (items.length < 2) return null;
  const deletions = items.filter((r) => r.action.startsWith('delete')).length;

  if (!confirming) {
    return (
      <div className="bulk-actions">
        <button onClick={() => setConfirming('approve')}>Approve {scope}</button>
        <button onClick={() => setConfirming('reject')}>Reject {scope}</button>
      </div>
    );
  }
  return (
    <div className="bulk-actions restore-confirm">
      <span>
        {confirming === 'approve'
          ? `Approve ${items.length} recommendations?${deletions ? ` ${deletions} of them ${deletions === 1 ? 'deletes' : 'delete'} something.` : ''} New concepts go first, so relationships that need them apply.`
          : `Reject ${items.length} recommendations? Nothing in the ontology changes.`}
      </span>
      <button
        className={confirming === 'approve' ? 'primary' : 'danger'}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onDone(confirming, items.map((r) => r.id));
          setBusy(false);
          setConfirming(null);
        }}
      >
        {busy ? 'Working…' : confirming === 'approve' ? `Approve ${items.length}` : `Reject ${items.length}`}
      </button>
      <button onClick={() => setConfirming(null)} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

// --- Concept browser --------------------------------------------------------

function ConceptList({ zone, ontology }: { zone: string; ontology: Ontology }) {
  const [filter, setFilter] = useState('');
  const byId = useMemo(() => new Map(ontology.concepts.map((c) => [c.id, c])), [ontology]);
  const f = filter.trim().toLowerCase();
  const visible = ontology.concepts.filter(
    (c) => !f || c.name.toLowerCase().includes(f) || c.aliases.some((a) => a.toLowerCase().includes(f)) || c.type.toLowerCase() === f,
  );
  const types = [...new Set(visible.map((c) => c.type))].sort();

  const relationsOf = (c: Concept) =>
    ontology.relations
      .filter((r) => r.from === c.id || r.to === c.id)
      .map((r) => ({
        id: r.id,
        label:
          r.name ??
          (r.from === c.id
            ? `${humanType(r.type)} ${byId.get(r.to)?.name ?? r.to}`
            : `${byId.get(r.from)?.name ?? r.from} ${humanType(r.type)} this`),
      }));

  return (
    <>
      {ontology.concepts.length === 0 && (
        <p className="muted">No concepts yet.</p>
      )}
      <input className="concept-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter concepts" />
      {types.map((type) => (
        <div key={type} className="concept-group">
          <h3>{type}</h3>
          <ul>
            {visible
              .filter((c) => c.type === type)
              .map((c) => (
                <li key={c.id} className="concept">
                  <div>
                    <strong>
                      <a className="concept-link" href={href({ view: 'concept', id: toRef(zone, c.id) })}>
                        {c.name}
                      </a>
                    </strong>
                    {c.aliases.length > 0 && <span className="muted"> · {c.aliases.join(', ')}</span>}
                  </div>
                  {c.definition && <p>{c.definition}</p>}
                  {relationsOf(c).length > 0 && (
                    <p className="muted relations">
                      →{' '}
                      {relationsOf(c).map((r, i) => (
                        <span key={r.id}>
                          {i > 0 && ' · '}
                          <a href={href({ view: 'relation', id: toRef(zone, r.id) })}>{r.label}</a>
                        </span>
                      ))}
                    </p>
                  )}
                  <p className="muted sources">
                    From{' '}
                    {[...new Map(c.sources.map((s) => [s.path, s])).values()].map((s, i) => (
                      <span key={s.path}>
                        {i > 0 && ', '}
                        {pageLink(s.path, s.quote)}
                      </span>
                    ))}
                  </p>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </>
  );
}

// Opened from the "＋ New concept" button next to Calculate.
function NewConceptForm({ zone, onClose }: { zone: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('Term');
  const [definition, setDefinition] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="new-concept-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const c = await api.createConcept(zone, { name, type, definition });
          navigate({ view: 'concept', id: toRef(zone, c.id) });
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required autoFocus />
      <select value={type} onChange={(e) => setType(e.target.value)}>
        {CONCEPT_TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <input value={definition} onChange={(e) => setDefinition(e.target.value)} placeholder="Definition (optional)" />
      <button type="submit" className="primary">
        Create
      </button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
      {error && <span className="down">{error}</span>}
    </form>
  );
}

// --- Page -------------------------------------------------------------------

// List or graph, remembered per browser (a convenience; storage may be off).
const DISPLAY_KEY = 'pont:ontology-display';
function savedDisplay(): 'list' | 'graph' {
  try {
    return localStorage.getItem(DISPLAY_KEY) === 'graph' ? 'graph' : 'list';
  } catch {
    return 'list';
  }
}
function saveDisplay(d: 'list' | 'graph') {
  try {
    localStorage.setItem(DISPLAY_KEY, d);
  } catch {
    // not remembered
  }
}

// General (every page), plus one zone per top-level folder.
function ZoneTabs({ zones, current }: { zones: ZoneSummary[]; current: string }) {
  if (zones.length < 2) return null;
  return (
    <nav className="zone-tabs" aria-label="Zones">
      {zones.map((z) => (
        <a
          key={z.zone}
          className="zone-tab"
          href={href({ view: 'ontology', zone: z.zone || undefined })}
          aria-current={z.zone === current ? 'page' : undefined}
          title={`${z.pages} ${z.pages === 1 ? 'page' : 'pages'} · ${z.concepts} ${z.concepts === 1 ? 'concept' : 'concepts'}`}
        >
          {z.name}
          {z.pending > 0 && (
            <span className="zone-pending" aria-label={`${z.pending} waiting for review`}>
              {z.pending}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}

export function OntologyPage({ zone }: { zone: string }) {
  const [zones, setZones] = useState<ZoneSummary[]>([]);
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [runs, setRuns] = useState<OntologyRun[]>([]);
  const [recs, setRecs] = useState<OntologyRecommendation[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notices, setNotices] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [creatingConcept, setCreatingConcept] = useState(false);
  const [display, setDisplay] = useState<'list' | 'graph'>(savedDisplay);

  const active = runs.find((r) => r.status === 'running');

  const refresh = useCallback(async () => {
    try {
      const [z, o, p, r, rec] = await Promise.all([
        api.zones(),
        api.ontology(zone),
        api.ontologyChanges(zone),
        api.ontologyRuns(zone),
        api.ontologyRecommendations(zone),
      ]);
      setZones(z);
      setOntology(o);
      setPreview(p);
      setRuns(r);
      setRecs(rec);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [zone]);

  // Switching zones: clear the previous zone's state before loading.
  useEffect(() => {
    setOntology(null);
    setPreview(null);
    setRuns([]);
    setRecs([]);
    setNotices({});
    setSummary(null);
    setError(null);
    setConfirming(false);
    setCreatingConcept(false);
    void refresh();
  }, [refresh]);

  // While a run is going, poll it; refresh everything when it ends.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(async () => {
      const run = await api.ontologyRun(active.id).catch(() => null);
      if (!run) return;
      if (run.status === 'running') {
        setRuns((current) => current.map((r) => (r.id === run.id ? run : r)));
        api.ontologyRecommendations(zone).then(setRecs, () => undefined);
      } else {
        void refresh();
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh, zone]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const run = await api.startOntologyRun(zone);
      setConfirming(false);
      setRuns((current) => [run, ...current]);
    } catch (err) {
      setError((err as Error).message);
      setConfirming(false);
    } finally {
      setStarting(false);
    }
  }

  function decided(id: string, outcome: { ok: boolean; message: string; keep?: boolean }) {
    setNotices((n) => ({ ...n, [id]: outcome }));
    if (!outcome.keep) {
      window.setTimeout(() => {
        setRecs((current) => current.filter((r) => r.id !== id));
        api.ontology(zone).then(setOntology, () => undefined);
      }, 900);
    }
  }

  async function decideAll(action: 'approve' | 'reject', ids: string[]) {
    setError(null);
    try {
      const results = await api.decideRecommendations(action, ids);
      const done = results.filter((r) => r.status === 'approved' || r.status === 'rejected');
      const notDone = results.filter((r) => r.status === 'failed' || r.status === 'pending');
      // Leave the ones that didn't apply on screen with their reason.
      setNotices((n) => ({
        ...n,
        ...Object.fromEntries(notDone.map((r) => [r.id, { ok: false, message: r.message }])),
      }));
      const failedIds = new Set(results.filter((r) => r.status === 'failed').map((r) => r.id));
      const doneIds = new Set(done.map((r) => r.id));
      setRecs((current) => current.filter((r) => !doneIds.has(r.id)));
      setSummary(
        `${action === 'approve' ? 'Approved' : 'Rejected'} ${done.length} of ${results.length}.` +
          (notDone.length ? ` ${notDone.length} didn't apply; the reasons are shown below.` : ''),
      );
      // Failed ones are no longer pending; drop them after the reason has been seen.
      if (failedIds.size) {
        window.setTimeout(() => setRecs((current) => current.filter((r) => !failedIds.has(r.id))), 6000);
      }
      api.ontology(zone).then(setOntology, () => undefined);
    } catch (err) {
      setError((err as Error).message);
      void refresh();
    }
  }

  const last = runs.find((r) => r.status !== 'running');
  const canCalculate = Boolean(preview && preview.total > 0 && preview.estimate && !active);
  const groups: [string, string, OntologyRecommendation[]][] = [
    ['maintain', 'Updates and deletions', recs.filter((r) => r.workflow === 'maintain')],
    ['create', 'New concepts and relationships', recs.filter((r) => r.workflow === 'create')],
    ['agent', 'Proposed by agents (MCP)', recs.filter((r) => r.workflow === 'agent')],
  ];

  return (
    <div className="ontology">
      <div className="ontology-head">
        <div>
          <h1 className="page-title static">Ontology</h1>
          <ZoneTabs zones={zones} current={zone} />
        </div>
        <div className="calculate">
          <div className="calculate-buttons">
            <button onClick={() => setCreatingConcept(true)} disabled={creatingConcept}>
              ＋ New concept
            </button>
            <button className="primary" disabled={!canCalculate} onClick={() => setConfirming(true)}>
              Calculate
            </button>
          </div>
          <span className="muted hint">
            {!preview
              ? 'Checking for changes…'
              : !preview.estimate
                ? 'Set up an LLM in Settings first.'
                : active
                  ? 'A calculation is running.'
                  : preview.total === 0
                    ? 'Nothing changed in this zone since the last calculation.'
                    : `${preview.total} ${preview.total === 1 ? 'page has' : 'pages have'} changed in this zone since the last calculation.`}
          </span>
        </div>
      </div>

      {creatingConcept && <NewConceptForm zone={zone} onClose={() => setCreatingConcept(false)} />}

      {error && (
        <div className="banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {active && (
        <div className="run-progress">
          <div>
            <strong>Calculating…</strong>{' '}
            {active.progress.workflow && (
              <span className="muted">
                {active.progress.workflow === 'maintain' ? 'Checking existing concepts' : 'Looking for new concepts'}, batch{' '}
                {active.progress.batch} of {active.progress.batches} · {recs.length} recommendations so far
              </span>
            )}
          </div>
          <button onClick={() => api.cancelOntologyRun(active.id).then(refresh, (err: Error) => setError(err.message))}>
            Cancel run
          </button>
        </div>
      )}

      {!active && last && (
        <p className={`muted last-run ${last.status === 'failed' ? 'down' : ''}`}>
          Last calculation {last.status} on {new Date(last.finishedAt ?? last.startedAt).toLocaleString()} by {last.startedBy}
          {last.usage.inputTokens ? ` · ${tokens(last.usage.inputTokens)} input + ${tokens(last.usage.outputTokens ?? 0)} output tokens` : ''}
          {last.usage.costUsd != null ? ` (≈${money(last.usage.costUsd)})` : ''}
          {last.error ? ` · ${last.error}` : ''}
        </p>
      )}

      {/* Only when there is something to review (or the result of Approve all to show). */}
      {(recs.length > 0 || summary) && (
        <section>
          <div className="review-head">
            <h2 className="section-heading">Review ({recs.length})</h2>
            {!active && <BulkActions items={recs} scope="all" onDone={decideAll} />}
          </div>
          {summary && (
            <div className="banner bulk-summary">
              <span>{summary}</span>
              <button onClick={() => setSummary(null)}>Dismiss</button>
            </div>
          )}
          {groups
            .filter(([, , items]) => items.length)
            .map(([key, label, items]) => (
              <div key={key} className="rec-group">
                <div className="rec-group-head">
                  <h3>{label}</h3>
                  {!active && items.length < recs.length && <BulkActions items={items} scope="these" onDone={decideAll} />}
                </div>
                <ul>
                  {items.map((rec) => (
                    <Fragment key={rec.id}>
                      <RecommendationCard rec={rec} ontology={ontology} onDecided={decided} />
                      {notices[rec.id] && (
                        <li className={`rec-notice ${notices[rec.id].ok ? 'up' : 'down'}`}>{notices[rec.id].message}</li>
                      )}
                    </Fragment>
                  ))}
                  </ul>
                </div>
              ))}
        </section>
      )}

      <section>
        <h2 className="section-heading">
          Concepts ({ontology?.concepts.length ?? 0}) · Relationships ({ontology?.relations.length ?? 0})
          <span className="view-toggle" role="group" aria-label="Show concepts as">
            {(['list', 'graph'] as const).map((d) => (
              <button
                key={d}
                aria-pressed={display === d}
                onClick={() => {
                  setDisplay(d);
                  saveDisplay(d);
                }}
              >
                {d === 'list' ? 'List' : 'Graph'}
              </button>
            ))}
          </span>
        </h2>
        {ontology &&
          (display === 'graph' ? <OntologyGraph zone={zone} ontology={ontology} /> : <ConceptList zone={zone} ontology={ontology} />)}
      </section>

      {runs.length > 0 && (
        <section>
          <h2 className="section-heading">Recent calculations</h2>
          <table className="runs">
            <thead>
              <tr>
                <th>Started</th>
                <th>By</th>
                <th>Pages</th>
                <th>Recommendations</th>
                <th>Usage</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.startedAt).toLocaleString()}</td>
                  <td>{r.startedBy}</td>
                  <td>{r.changes.added.length + r.changes.modified.length + r.changes.deleted.length}</td>
                  <td>{r.recommendations}</td>
                  <td>
                    {r.usage.inputTokens ? `${tokens(r.usage.inputTokens + (r.usage.outputTokens ?? 0))} tokens` : '—'}
                    {r.usage.costUsd != null ? ` · ≈${money(r.usage.costUsd)}` : ''}
                  </td>
                  <td className={r.status === 'failed' ? 'down' : r.status === 'succeeded' ? 'up' : 'muted'} title={r.error ?? undefined}>
                    {r.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {confirming && preview && preview.estimate && (
        <ConfirmDialog zone={zone} preview={preview} busy={starting} onConfirm={start} onClose={() => setConfirming(false)} />
      )}
    </div>
  );
}

