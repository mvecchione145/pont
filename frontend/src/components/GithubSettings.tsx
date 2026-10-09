import { useEffect, useState, type FormEvent } from 'react';
import { api, type GithubStatus } from '../api';

// Settings → Integrations → GitHub. First the OAuth App pont signs people in
// with (entered here and stored encrypted, or set by the server's environment,
// which then wins), then each person connects their own GitHub account so they
// can link repository docs and publish changes as pull requests.
export function GithubSettings() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set by the OAuth callback's redirect: #/settings?tab=integrations&github=connected
  const result = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('github');

  const load = () =>
    api.githubStatus().then(
      (s) => {
        setStatus(s);
        setClientId(s.app.clientId);
        setClientSecret('');
      },
      (err: Error) => setError(err.message),
    );
  useEffect(() => {
    void load();
  }, []);

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      if (done) setNotice(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

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

  function saveApp(e: FormEvent) {
    e.preventDefault();
    void run(() => api.saveGithubApp(clientId, clientSecret || undefined), 'Saved.');
  }

  if (!status) return <section className="github-settings">{error ? <p className="down">{error}</p> : <p className="muted">Loading…</p>}</section>;
  const app = status.app;

  return (
    <section className="github-settings">
      <h2 className="section-heading">GitHub</h2>
      <p className="muted">
        Link Markdown files in your repositories (like a README) to pont pages. Linked pages don't autosave: you edit,
        then <strong>Publish</strong>, which opens a pull request as you.
      </p>
      {result === 'connected' && status.connected && <p className="up">GitHub is connected.</p>}
      {result === 'failed' && <p className="down">Connecting GitHub didn't work. Try again.</p>}
      {result === 'cancelled' && <p className="muted">Connecting GitHub was cancelled.</p>}

      <h3 className="settings-subheading">OAuth App</h3>
      {app.source === 'env' ? (
        <p className="muted">
          Set by the server (<code>GITHUB_CLIENT_ID</code> / <code>GITHUB_CLIENT_SECRET</code>): client ID{' '}
          <code>{app.clientId || '—'}</code>, secret {app.hasSecret ? <code>{app.secretHint}</code> : <strong>missing</strong>}.
          To change it, edit <code>.env</code> and restart pont.
        </p>
      ) : (
        <form className="settings-form" onSubmit={saveApp}>
          <p className="muted">
            Register an OAuth App on GitHub (<em>Settings → Developer settings → OAuth Apps → New OAuth App</em>) with
            this authorization callback URL, then enter its client ID and a client secret.
          </p>
          <label>
            Callback URL
            <input value={status.callbackUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
          </label>
          <label>
            Client ID
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Ov23li…" required />
          </label>
          <label>
            Client secret
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={app.hasSecret ? `Saved (${app.secretHint}). Leave empty to keep it.` : 'Paste a client secret'}
              required={!app.hasSecret}
              autoComplete="off"
            />
            <span className="muted hint">Stored encrypted on the server and never shown again.</span>
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              Save
            </button>
            {app.source === 'settings' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => api.removeGithubApp(), 'Removed. GitHub is off until an app is set up again.')}
              >
                Remove app
              </button>
            )}
          </div>
          {app.updatedBy && app.updatedAt && (
            <p className="muted hint">
              Last changed by {app.updatedBy} on {new Date(app.updatedAt).toLocaleString()}.
            </p>
          )}
        </form>
      )}

      <h3 className="settings-subheading">Your account</h3>
      {!status.configured ? (
        <p className="muted">Set up the OAuth App above first.</p>
      ) : status.connected ? (
        <div className="actions">
          <span>
            Connected as <strong>@{status.login}</strong>.
          </span>
          <button onClick={() => run(() => api.githubDisconnect())} disabled={busy}>
            Disconnect
          </button>
        </div>
      ) : (
        <button className="primary" onClick={connect} disabled={busy}>
          {busy ? 'Opening GitHub…' : 'Connect GitHub'}
        </button>
      )}
      {notice && <p className="up">{notice}</p>}
      {error && <p className="down">{error}</p>}
    </section>
  );
}
