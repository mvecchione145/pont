import type { User } from '../auth.js';
import { db } from '../clients.js';
import { config } from '../config.js';
import { decrypt, encrypt } from '../secrets.js';

// The GitHub OAuth App pont signs people in with. It comes from the
// environment (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET), which wins when set so
// an admin can lock it down, or else from Settings → Integrations, stored like
// the LLM key: the secret encrypted with PONT_SECRET_KEY, never sent back to
// the browser (only whether it's set and its last four characters).

export class GithubAppError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

const KEY = 'github_app';

interface Stored {
  clientId: string;
  clientSecretEncrypted: string | null;
  secretHint: string;
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface PublicGithubApp {
  // Where it comes from: the server's environment, Settings, or nowhere yet.
  source: 'env' | 'settings' | null;
  clientId: string;
  hasSecret: boolean;
  secretHint: string;
  updatedBy?: string;
  updatedAt?: string;
}

const fromEnv = () => Boolean(config.github.clientId || config.github.clientSecret);

async function load() {
  const { rows } = await db.query<{ value: Stored; updated_by: string; updated_at: Date }>(
    'SELECT value, updated_by, updated_at FROM settings WHERE key = $1',
    [KEY],
  );
  return rows[0] ?? null;
}

// The app to use, or null when it isn't fully set up.
export async function oauthApp(): Promise<OAuthApp | null> {
  if (fromEnv()) {
    const { clientId, clientSecret } = config.github;
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }
  const row = await load();
  if (!row?.value.clientId || !row.value.clientSecretEncrypted) return null;
  try {
    return { clientId: row.value.clientId, clientSecret: decrypt(row.value.clientSecretEncrypted) };
  } catch {
    // PONT_SECRET_KEY changed: the secret has to be entered again.
    return null;
  }
}

export async function publicApp(): Promise<PublicGithubApp> {
  if (fromEnv()) {
    const secret = config.github.clientSecret;
    return { source: 'env', clientId: config.github.clientId, hasSecret: Boolean(secret), secretHint: secret ? `…${secret.slice(-4)}` : '' };
  }
  const row = await load();
  if (!row) return { source: null, clientId: '', hasSecret: false, secretHint: '' };
  return {
    source: 'settings',
    clientId: row.value.clientId,
    hasSecret: Boolean(row.value.clientSecretEncrypted),
    secretHint: row.value.secretHint,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

// "clientSecret": undefined keeps the stored one; '' removes it.
export async function saveApp(update: { clientId: string; clientSecret?: string }, user: User): Promise<PublicGithubApp> {
  if (fromEnv()) throw new GithubAppError('The GitHub app is set by the server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).', 409);
  const clientId = update.clientId.trim();
  if (!clientId) throw new GithubAppError('Enter the OAuth App\'s client ID.');
  const previous = (await load())?.value;
  let clientSecretEncrypted = previous?.clientSecretEncrypted ?? null;
  let secretHint = previous?.secretHint ?? '';
  if (update.clientSecret !== undefined) {
    const secret = update.clientSecret.trim();
    clientSecretEncrypted = secret ? encrypt(secret) : null;
    secretHint = secret ? `…${secret.slice(-4)}` : '';
  }
  const value: Stored = { clientId, clientSecretEncrypted, secretHint };
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [KEY, JSON.stringify(value), user.name ?? user.username],
  );
  return publicApp();
}

export async function removeApp(): Promise<void> {
  if (fromEnv()) throw new GithubAppError('The GitHub app is set by the server and can\'t be removed here.', 409);
  await db.query('DELETE FROM settings WHERE key = $1', [KEY]);
}
