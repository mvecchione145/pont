import { useEffect, useState } from 'react';
import { api, type GithubStatus } from '../api';

// Settings → GitHub: connect your account so you can link repository docs to
// pont pages and publish changes as pull requests.
export function GithubSettings() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by the OAuth callback's redirect: #/settings?github=connected
  const result = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('github');

  const load = () => api.githubStatus().then(setStatus, (err: Error) => setError(err.message));
  useEffect(() => {
    void load();
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      window.location.href = (await api.githubConnect()).url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.githubDisconnect();
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="github-settings">
      <h2 className="section-heading">GitHub</h2>
      <p className="muted">
        Connect GitHub to link Markdown files in your repositories (like a README) to pont pages. Linked pages don't
        autosave: you edit, then <strong>Publish</strong>, which opens a pull request as you.
      </p>
      {result === 'connected' && status?.connected && <p className="up">GitHub is connected.</p>}
      {result === 'failed' && <p className="down">Connecting GitHub didn't work. Try again.</p>}
      {result === 'cancelled' && <p className="muted">Connecting GitHub was cancelled.</p>}
      {error && <p className="down">{error}</p>}
      {!status ? (
        <p className="muted">Loading…</p>
      ) : !status.configured ? (
        <div className="github-setup">
          <p>GitHub isn't set up on this pont server yet. An admin needs to:</p>
          <ol>
            <li>
              Register an OAuth App on GitHub (<em>Settings → Developer settings → OAuth Apps → New OAuth App</em>) with
              the callback URL <code>{status.callbackUrl}</code>.
            </li>
            <li>
              Put its client ID and a client secret in <code>.env</code> as <code>GITHUB_CLIENT_ID</code> and{' '}
              <code>GITHUB_CLIENT_SECRET</code>, then run <code>docker compose up -d</code>.
            </li>
          </ol>
        </div>
      ) : status.connected ? (
        <div className="actions">
          <span>
            Connected as <strong>@{status.login}</strong>.
          </span>
          <button onClick={disconnect} disabled={busy}>
            Disconnect
          </button>
        </div>
      ) : (
        <button className="primary" onClick={connect} disabled={busy}>
          {busy ? 'Opening GitHub…' : 'Connect GitHub'}
        </button>
      )}
    </section>
  );
}
