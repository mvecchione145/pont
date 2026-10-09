import { useState, type FormEvent } from 'react';
import { api, ApiError, type GithubPage, type GithubPublishResult, type PullLogEntry, type PullStatus } from '../api';

// The parts of a page linked to a file on GitHub: the bar saying where it
// comes from (with its pull request's status and log), and the Publish dialog.

// Unpublished edits are kept in this browser, so a reload doesn't lose them,
// together with the SHA of the file version they started from.
export const draftKey = (path: string) => `pont.github-draft:${path}`;

export interface Draft {
  content: string;
  // Blob SHA of the GitHub version the draft started from.
  sha: string | null;
}

export function readDraft(path: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(path));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<Draft>;
      if (typeof parsed?.content === 'string') return { content: parsed.content, sha: parsed.sha ?? null };
    } catch {
      // Drafts saved before SHAs were kept are plain text.
    }
    return { content: raw, sha: null };
  } catch {
    return null;
  }
}

export function writeDraft(path: string, draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(draftKey(path), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(path));
  } catch {
    // The draft just isn't kept across reloads.
  }
}

const STATE_LABEL: Record<string, string> = {
  open: 'Open',
  draft: 'Draft',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  merged: 'Merged',
  closed: 'Closed',
};

export function pullLabel(p: Pick<PullStatus, 'state' | 'draft' | 'reviewState'>): { key: string; label: string } {
  const key =
    p.state !== 'open'
      ? p.state
      : p.draft
        ? 'draft'
        : p.reviewState === 'changes_requested'
          ? 'changes_requested'
          : p.reviewState === 'approved'
            ? 'approved'
            : 'open';
  return { key, label: STATE_LABEL[key] };
}

function PullChip({ pull }: { pull: Pick<PullStatus, 'state' | 'draft' | 'reviewState'> }) {
  const { key, label } = pullLabel(pull);
  return <span className={`pr-chip ${key}`}>{label}</span>;
}

function PullLog({ pulls }: { pulls: PullLogEntry[] }) {
  return (
    <ul className="pr-log">
      {pulls.map((p) => (
        <li key={p.number}>
          <a href={p.url} target="_blank" rel="noreferrer">
            #{p.number}
          </a>{' '}
          {p.title} <PullChip pull={p} />
          <span className="muted">
            {' '}
            · opened by {p.openedBy} on {new Date(p.openedAt).toLocaleDateString()}
            {p.publishes > 1 && ` · ${p.publishes} publishes`}
            {p.closedAt && ` · ${p.state} ${new Date(p.closedAt).toLocaleDateString()}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function GithubBar({
  github,
  draft,
  staleDraft,
  remoteChanged,
  notice,
  onDiscard,
  onRefresh,
  onDismissNotice,
}: {
  github: GithubPage;
  draft: boolean;
  // The unpublished draft started from an older version of the file.
  staleDraft: boolean;
  // GitHub has a newer version than the one in the editor.
  remoteChanged: boolean;
  // A change to the pull request's status while the page was open.
  notice: string | null;
  onDiscard: () => void;
  onRefresh: () => Promise<void>;
  onDismissNotice: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      {notice && (
        <div className="banner github-notice" role="status">
          <span>{notice}</span>
          <button onClick={onDismissNotice}>Dismiss</button>
        </div>
      )}
      {remoteChanged && (
        <div className="banner github-changed" role="alert">
          <span>
            <strong>This file changed on GitHub</strong>{' '}
            {github.pr ? `in pull request #${github.pr.number}` : `on ${github.branch}`} since you opened it.{' '}
            {draft ? 'Refresh to see the new version; your unpublished changes are kept.' : 'Refresh to see the new version.'}
          </span>
          <button className="primary" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
      <div className="banner github-bar">
        <span>
          <span className="github-mark" aria-hidden>
            ⎇
          </span>{' '}
          Linked to{' '}
          <a href={github.fileUrl} target="_blank" rel="noreferrer">
            {github.owner}/{github.repo} · {github.filePath}
          </a>{' '}
          on <code>{github.branch}</code>.{' '}
          {github.pr ? (
            <>
              Showing your changes in{' '}
              <a href={github.pr.url} target="_blank" rel="noreferrer">
                pull request #{github.pr.number}
              </a>{' '}
              <PullChip pull={github.pr} />; publishing again adds to it.
            </>
          ) : (
            <>Changes aren't saved automatically: click Publish to open a pull request.</>
          )}
          {github.synced === 'merged' && <strong> The pull request was merged; pont now has the merged version.</strong>}
          {github.synced === 'updated' && <strong> Updated with the latest version from GitHub.</strong>}
          {draft && staleDraft && <strong> Your unpublished changes started from an older version of the file.</strong>}
          {github.warning && <span className="down"> {github.warning}</span>}
          {!github.canPublish && (
            <>
              {' '}
              <a href="#/settings?tab=integrations">Connect GitHub</a> to publish.
            </>
          )}
          {github.pulls.length > 0 && (
            <>
              {' '}
              <button className="link-button inline" onClick={() => setShowLog(!showLog)}>
                {showLog ? 'Hide pull requests' : `Pull requests (${github.pulls.length})`}
              </button>
            </>
          )}
          {error && <span className="down"> {error}</span>}
        </span>
        {draft && <button onClick={onDiscard}>Discard changes</button>}
      </div>
      {showLog && (
        <div className="github-log">
          <PullLog pulls={github.pulls} />
        </div>
      )}
    </>
  );
}

export function PublishDialog({
  path,
  github,
  content,
  baseSha,
  onClose,
  onPublished,
}: {
  path: string;
  github: GithubPage;
  content: string;
  // The SHA of the version the edits started from: publishing is refused if
  // GitHub has a newer one, unless forced, so nobody's change is overwritten.
  baseSha: string | null;
  onClose: () => void;
  onPublished: (result: GithubPublishResult) => void;
}) {
  const [title, setTitle] = useState(`Update ${github.filePath}`);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState<GithubPublishResult | null>(null);

  async function send(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      setDone(await api.githubPublish(path, content, title, description, baseSha, force));
      setStale(false);
    } catch (err) {
      setStale(err instanceof ApiError && err.code === 'stale');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(false);
  }

  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && (done ? onPublished(done) : onClose())}>
      <div className="confirm-dialog" role="dialog" aria-labelledby="publish-title" onMouseDown={(e) => e.stopPropagation()}>
        {done ? (
          <>
            <h2 id="publish-title">Published</h2>
            <p>
              {done.opened ? 'Opened ' : 'Added your changes to '}
              <a href={done.pr.url} target="_blank" rel="noreferrer">
                pull request #{done.pr.number}
              </a>{' '}
              on {github.owner}/{github.repo}. pont shows its status on the page, and the merged version once it's merged.
            </p>
            <div className="actions end">
              <button className="primary" onClick={() => onPublished(done)} autoFocus>
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="settings-form">
            <h2 id="publish-title">Publish to GitHub</h2>
            <p>
              {github.pr ? (
                <>
                  Adds a commit with your changes to{' '}
                  <a href={github.pr.url} target="_blank" rel="noreferrer">
                    pull request #{github.pr.number}
                  </a>
                  .
                </>
              ) : (
                <>
                  Commits your changes to <code>{github.filePath}</code> on a new branch and opens a pull request into{' '}
                  <code>{github.branch}</code> on {github.owner}/{github.repo}, as you.
                </>
              )}
            </p>
            <label>
              {github.pr ? 'Commit message' : 'Pull request title'}
              <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
            </label>
            {!github.pr && (
              <label>
                Description <span className="muted">(optional)</span>
                <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
            )}
            {error && <p className="down">{error}</p>}
            <div className="actions end">
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              {stale ? (
                <button type="button" className="danger" onClick={() => send(true)} disabled={busy}>
                  Publish anyway
                </button>
              ) : (
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? 'Publishing…' : github.pr ? 'Add to pull request' : 'Open pull request'}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
