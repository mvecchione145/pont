import { useEffect, useState, type FormEvent } from 'react';
import { api, type TokenInfo } from '../api';

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function NewToken({ token }: { token: string }) {
  const mcpUrl = `${window.location.origin}/mcp`;
  const command = `claude mcp add --transport http pont ${mcpUrl} --header "Authorization: Bearer ${token}"`;
  return (
    <div className="callout">
      <p>
        <strong>Copy this token now.</strong> pont only stores a hash of it, so it can't be shown
        again.
      </p>
      <div className="copy-row">
        <code>{token}</code>
        <CopyButton value={token} />
      </div>
      <p>To connect Claude Code, run:</p>
      <div className="copy-row">
        <code>{command}</code>
        <CopyButton value={command} />
      </div>
    </div>
  );
}

export function Tokens() {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.listTokens().then(setTokens, (err: Error) => setError(err.message));
  useEffect(() => {
    refresh();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { token } = await api.createToken(name.trim());
      setCreated(token);
      setName('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api.revokeToken(id);
      setConfirming(null);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <h1 className="page-title static">API tokens</h1>
      <p className="muted">
        Tokens let your agents, such as Claude Code, read pont through MCP as you. Anyone with a
        token can read all knowledge in pont, so treat it like a password and revoke it when you no
        longer need it.
      </p>

      <form className="token-form" onSubmit={create}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name, for example: Claude Code on my laptop"
          maxLength={100}
          required
        />
        <button type="submit" className="primary">
          Create token
        </button>
      </form>

      {created && <NewToken token={created} />}
      {error && <p className="down">{error}</p>}

      {tokens === null ? (
        <p className="muted">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="muted">You have no tokens.</p>
      ) : (
        <table className="tokens">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <code>{t.prefix}…</code>
                </td>
                <td>{formatDate(t.createdAt)}</td>
                <td>{formatDate(t.lastUsedAt)}</td>
                <td className="actions">
                  {confirming === t.id ? (
                    <>
                      <button className="danger" onClick={() => revoke(t.id)}>
                        Confirm revoke
                      </button>
                      <button onClick={() => setConfirming(null)}>Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirming(t.id)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
