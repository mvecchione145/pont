import { useEffect, useState, type FormEvent } from 'react';
import { api, type GithubStatus } from '../api';

// Links a Markdown file in a GitHub repository to a new pont page. Paste the
// file's GitHub link, or give the repository, branch, and path.
export function GithubLinkDialog({ onClose, onLinked }: { onClose: () => void; onLinked: (pagePath: string) => void }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [url, setUrl] = useState('');
  const [manual, setManual] = useState(false);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [path, setPath] = useState('README.md');
  const [pagePath, setPagePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.githubStatus().then(setStatus, (err: Error) => setError(err.message));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const [owner, name] = repo.split('/').map((s) => s.trim());
      const result = await api.githubLink(
        manual
          ? { owner, repo: name, branch: branch || undefined, path, pagePath: pagePath || undefined }
          : { url, pagePath: pagePath || undefined },
      );
      onLinked(result.pagePath);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="upload-dialog" role="dialog" aria-label="Link a GitHub doc" onMouseDown={(e) => e.stopPropagation()}>
        <header className="upload-head">
          <h2>Link a GitHub doc</h2>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </header>
        {!status ? (
          <p className="muted">Loading…</p>
        ) : !status.connected ? (
          <div className="empty-state">
            <p>{status.configured ? 'Connect your GitHub account first.' : 'GitHub is not set up on this pont server yet.'}</p>
            <a className="button primary" href="#/settings?tab=integrations" onClick={onClose}>
              Open Settings
            </a>
          </div>
        ) : (
          <form className="settings-form github-link-form" onSubmit={submit}>
            {manual ? (
              <>
                <label>
                  Repository
                  <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" required autoFocus />
                </label>
                <label>
                  Branch <span className="muted">(empty: the default branch)</span>
                  <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
                </label>
                <label>
                  File
                  <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="docs/guide.md" required />
                </label>
              </>
            ) : (
              <label>
                GitHub link to the file
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/org/repo/blob/main/README.md"
                  required
                  autoFocus
                />
              </label>
            )}
            <button type="button" className="link-button" onClick={() => setManual(!manual)}>
              {manual ? 'Paste a link instead' : 'Enter repository, branch, and file instead'}
            </button>
            <label>
              pont page <span className="muted">(empty: github/&lt;owner&gt;/&lt;repo&gt;/&lt;file&gt;)</span>
              <input value={pagePath} onChange={(e) => setPagePath(e.target.value)} placeholder="Engineering/App README" />
            </label>
            {error && <p className="down">{error}</p>}
            <div className="actions end">
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Linking…' : 'Link'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
