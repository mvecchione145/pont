import { useCallback, useEffect, useState } from 'react';
import { api, type Proposal, type ProposalDetail } from '../api';
import { href, navigate } from '../route';
import { Diff } from './Diff';

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : new Date(iso).toLocaleDateString();
}

function Review({ id, onDone }: { id: string; onDone: (message: string) => void }) {
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setDetail(null);
    setError(null);
    setMode('view');
    api.proposal(id).then(setDetail, (err: Error) => setError(err.message));
  }, [id]);
  useEffect(load, [load]);

  if (error && !detail) return <p className="down">{error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone(message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const startEdit = () => {
    setDraft(detail.proposedContent ?? detail.currentContent ?? '');
    setMode('edit');
  };
  const canApproveAsIs = !detail.problem && detail.proposedContent !== null;

  return (
    <div className="proposal-review">
      <header>
        <p className="muted">
          {detail.kind === 'new' ? 'New page' : 'Edit'} proposed by <strong>{detail.proposedBy}</strong>’s agent ·{' '}
          {timeAgo(detail.createdAt)}
        </p>
        <h2>
          {detail.kind === 'new' ? (
            detail.path
          ) : (
            <a href={href({ view: 'page', path: detail.path })}>{detail.path}</a>
          )}
        </h2>
        <blockquote className="reason">{detail.reason}</blockquote>
      </header>

      {detail.problem ? (
        <div className="banner">
          <span>
            <strong>Can’t apply as proposed:</strong> {detail.problem} You can edit it into the current page or reject it.
          </span>
        </div>
      ) : (
        detail.stale && (
          <div className="banner">
            <span>
              <strong>The page changed since this was proposed.</strong> The change still applies; the diff below is
              against the current version.
            </span>
          </div>
        )
      )}

      {mode === 'edit' ? (
        <div className="proposal-edit">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !draft.trim()}
              onClick={() =>
                act(
                  () => api.approveProposal(detail.id, { content: draft, baseVersionId: detail.kind === 'new' ? null : detail.currentVersionId }),
                  `Saved your edited version of ${detail.path}.`,
                )
              }
            >
              Save and approve
            </button>
            <button onClick={() => setMode('view')} disabled={busy}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <Diff patch={detail.patch} />
      )}

      {error && <p className="down">{error}</p>}

      {mode === 'reject' ? (
        <div className="reject-form">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for the agent, e.g. why this is wrong"
            autoFocus
          />
          <button className="danger" disabled={busy} onClick={() => act(() => api.rejectProposal(detail.id, note), `Rejected the proposal for ${detail.path}.`)}>
            Reject
          </button>
          <button onClick={() => setMode('view')} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        mode === 'view' && (
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !canApproveAsIs}
              onClick={() =>
                act(() => api.approveProposal(detail.id), `Approved: ${detail.kind === 'new' ? 'created' : 'updated'} ${detail.path}.`)
              }
            >
              Approve
            </button>
            <button onClick={startEdit} disabled={busy}>
              Edit & approve
            </button>
            <button onClick={() => setMode('reject')} disabled={busy}>
              Reject…
            </button>
          </div>
        )
      )}
    </div>
  );
}

export function ProposalsPage({ pathFilter, onChanged }: { pathFilter?: string; onChanged: () => void }) {
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.proposals(tab).then((list) => {
      const filtered = pathFilter ? list.filter((p) => p.path === pathFilter) : list;
      setItems(filtered);
      setSelected((current) => (current && filtered.some((p) => p.id === current) ? current : (filtered[0]?.id ?? null)));
    }, () => setItems([]));
  }, [tab, pathFilter]);
  useEffect(refresh, [refresh]);

  return (
    <div className="proposals">
      <h1 className="page-title static">Agent Proposals</h1>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pending'} onClick={() => setTab('pending')}>
          Waiting for review
        </button>
        <button role="tab" aria-selected={tab === 'decided'} onClick={() => setTab('decided')}>
          Reviewed
        </button>
        {pathFilter && (
          <button onClick={() => navigate({ view: 'proposals' })} title="Show proposals for all pages">
            Only “{pathFilter}” ✕
          </button>
        )}
      </div>

      {notice && (
        <div className="banner">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {items === null ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">{tab === 'pending' ? 'No proposals waiting for review.' : 'Nothing reviewed yet.'}</p>
      ) : tab === 'decided' ? (
        <table className="runs">
          <thead>
            <tr>
              <th>Page</th>
              <th>Proposed by</th>
              <th>Outcome</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.status === 'approved' ? <a href={href({ view: 'page', path: p.path })}>{p.path}</a> : p.path}</td>
                <td>{p.proposedBy}</td>
                <td className={p.status === 'approved' ? 'up' : 'muted'}>
                  {p.status} by {p.decidedBy} {p.decidedAt && timeAgo(p.decidedAt)}
                </td>
                <td className="muted">{p.decisionNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="proposals-layout">
          <ul className="proposal-list">
            {items.map((p) => (
              <li key={p.id}>
                <button className={p.id === selected ? 'selected' : ''} onClick={() => setSelected(p.id)}>
                  <span className="proposal-path">{p.path}</span>
                  <span className="muted">
                    {p.kind === 'new' ? 'New page' : 'Edit'} · {p.proposedBy} · {timeAgo(p.createdAt)}
                  </span>
                  <span className="proposal-reason">{p.reason}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <Review
              key={selected}
              id={selected}
              onDone={(message) => {
                setNotice(message);
                refresh();
                onChanged();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
