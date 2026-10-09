import { useState, type FormEvent } from 'react';
import { api, type GithubPage, type GithubPublishResult } from '../api';

// The parts of a page linked to a file on GitHub: the bar saying where it
// comes from (and its pull request), and the Publish dialog.

// Unpublished edits are kept in this browser, so a reload doesn't lose them.
export const draftKey = (path: string) => `pont.github-draft:${path}`;

export function GithubBar({
  github,
  draft,
  restoredDraft,
  onDiscard,
  onPull,
}: {
  github: GithubPage;
  draft: boolean;
  restoredDraft: boolean;
  onDiscard: () => void;
  onPull: () => Promise<void>;
}) {
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
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
            </a>
            ; publishing again adds to it.
          </>
        ) : (
          <>Changes aren't saved automatically: click Publish to open a pull request.</>
        )}
        {github.synced === 'merged' && <strong> The pull request was merged; pont now has the merged version.</strong>}
        {github.synced === 'updated' && <strong> Updated with the latest version from GitHub.</strong>}
        {restoredDraft && draft && <strong> Restored your unpublished changes.</strong>}
        {!github.canPublish && (
          <>
            {' '}
            <a href="#/settings?tab=integrations">Connect GitHub</a> to publish.
          </>
        )}
        {error && <span className="down"> {error}</span>}
      </span>
      {draft && <button onClick={onDiscard}>Discard changes</button>}
      {!draft && github.canPublish && (
        <button
          disabled={pulling}
          onClick={async () => {
            setPulling(true);
            setError(null);
            try {
              await onPull();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setPulling(false);
            }
          }}
        >
          {pulling ? 'Pulling…' : 'Pull latest'}
        </button>
      )}
    </div>
  );
}

export function PublishDialog({
  path,
  github,
  content,
  onClose,
  onPublished,
}: {
  path: string;
  github: GithubPage;
  content: string;
  onClose: () => void;
  onPublished: (result: GithubPublishResult) => void;
}) {
  const [title, setTitle] = useState(`Update ${github.filePath}`);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<GithubPublishResult | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await api.githubPublish(path, content, title, description));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
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
              on {github.owner}/{github.repo}. pont will show the merged version once it's merged.
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
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Publishing…' : github.pr ? 'Add to pull request' : 'Open pull request'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
