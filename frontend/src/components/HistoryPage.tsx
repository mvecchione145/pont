import { useCallback, useEffect, useState } from 'react';
import { api, type PageVersion, type PageVersionDetail } from '../api';
import { folderOf, href, nameOf, navigate } from '../route';
import { Diff } from './Diff';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Badges({ v }: { v: PageVersion }) {
  return (
    <span className="badges">
      {v.current && <span className="pill new">Current</span>}
      {v.deleted && <span className="pill deleted">Deleted</span>}
      {v.proposedBy && <span className="pill">From {v.proposedBy}’s agent</span>}
      {v.restoredFrom && <span className="pill">Restored</span>}
      {v.movedFrom && <span className="pill">Moved here</span>}
      {v.reviewId && <span className="pill">From a review</span>}
      {v.linkFix && <span className="pill">Link fix</span>}
    </span>
  );
}

export function HistoryPage({ path, onChanged }: { path: string; onChanged: () => void }) {
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PageVersionDetail | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.history(path).then(
      (list) => {
        setVersions(list);
        setSelected((current) =>
          current && list.some((v) => v.versionId === current) ? current : (list.find((v) => !v.deleted)?.versionId ?? null),
        );
      },
      (err: Error) => setError(err.message),
    );
  }, [path]);
  useEffect(load, [load]);

  useEffect(() => {
    setDetail(null);
    setConfirming(false);
    setShowFull(false);
    if (!selected) return;
    api.version(path, selected).then(setDetail, (err: Error) => setError(err.message));
  }, [path, selected]);

  async function restore() {
    if (!detail) return;
    setBusy(true);
    try {
      await api.restoreVersion(path, detail.versionId);
      setNotice(`Restored the version from ${when(detail.modifiedAt)}. It is now the current version.`);
      onChanged();
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const deletedNow = versions?.[0]?.deleted ?? false;
  const folder = folderOf(path);

  return (
    <div className="history">
      <p className="muted breadcrumbs-line">
        {folder && <>{folder} / </>}
        {deletedNow ? nameOf(path) : <a href={href({ view: 'page', path })}>{nameOf(path)}</a>}
      </p>
      <h1 className="page-title static">History</h1>

      {deletedNow && (
        <div className="banner">
          <span>
            This page was deleted on {when(versions![0].modifiedAt)}. Restore a version to bring it back.
          </span>
        </div>
      )}
      {notice && (
        <div className="banner">
          <span>{notice}</span>
          <a className="button" href={href({ view: 'page', path })}>
            Open page
          </a>
        </div>
      )}
      {error && <p className="down">{error}</p>}

      {versions === null ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <div className="history-layout">
          <ol className="version-list">
            {versions.map((v) => (
              <li key={v.versionId}>
                <button
                  className={v.versionId === selected ? 'selected' : ''}
                  disabled={v.deleted}
                  onClick={() => setSelected(v.versionId)}
                >
                  <span className="version-when">{when(v.modifiedAt)}</span>
                  <span className="muted">{v.deleted ? 'Page deleted' : (v.author?.name ?? 'Unknown author')}</span>
                  <Badges v={v} />
                </button>
              </li>
            ))}
          </ol>

          <div className="version-detail">
            {!detail ? (
              selected && <p className="muted">Loading…</p>
            ) : (
              <>
                <header>
                  <h2>{when(detail.modifiedAt)}</h2>
                  <p className="muted">
                    Saved by {detail.author?.name ?? 'an unknown author'}
                    {detail.proposedBy && <> from a proposal by {detail.proposedBy}’s agent</>}
                    {detail.restoredFrom && <> (restored from an earlier version)</>}
                    {detail.movedFrom && (
                      <>
                        {' '}
                        when the page was moved from{' '}
                        <a href={href({ view: 'history', path: detail.movedFrom })}>{detail.movedFrom}</a>
                      </>
                    )}
                    .
                  </p>
                </header>

                <div className="tabs" role="tablist">
                  <button role="tab" aria-selected={!showFull} onClick={() => setShowFull(false)}>
                    {detail.previousVersionId ? 'Changes from the previous version' : 'Content when created'}
                  </button>
                  <button role="tab" aria-selected={showFull} onClick={() => setShowFull(true)}>
                    Full page
                  </button>
                </div>

                {showFull ? (
                  <pre className="version-content">{detail.content}</pre>
                ) : (
                  <Diff patch={detail.patch} empty="No text changes in this version." />
                )}

                {!detail.current &&
                  (confirming ? (
                    <div className="restore-confirm">
                      <span>
                        Restore this version? It becomes the newest version{deletedNow ? ' and brings the page back' : ''};
                        the current one stays in history.
                      </span>
                      <button className="primary" onClick={restore} disabled={busy}>
                        {busy ? 'Restoring…' : 'Restore'}
                      </button>
                      <button onClick={() => setConfirming(false)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="actions">
                      <button onClick={() => setConfirming(true)}>Restore this version</button>
                    </div>
                  ))}
              </>
            )}
          </div>
        </div>
      )}
      {versions && !deletedNow && (
        <p className="muted hint">
          <a href="#" onClick={(e) => { e.preventDefault(); navigate({ view: 'page', path }); }}>
            Back to the page
          </a>
        </p>
      )}
    </div>
  );
}
