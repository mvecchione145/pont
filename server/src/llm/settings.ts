import { db } from '../clients.js';
import { decrypt, encrypt } from '../secrets.js';
import type { User } from '../auth.js';

// The LLM used for trivia, configured once for the whole pont install. The
// API key is stored encrypted and never leaves the server; clients only see
// whether one is set and its last four characters.

export type Provider = 'anthropic' | 'openai-compatible';

export interface LlmSettings {
  provider: Provider;
  model: string;
  // Optional: a proxy for Anthropic, or the OpenAI-compatible endpoint
  // (OpenAI, Ollama, vLLM, LiteLLM, ...).
  baseUrl: string;
  apiKey: string;
}

export interface PublicLlmSettings {
  configured: boolean;
  provider: Provider;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  keyHint: string;
  updatedBy?: string;
  updatedAt?: string;
}

interface Stored {
  provider: Provider;
  model: string;
  baseUrl: string;
  apiKeyEncrypted: string | null;
  keyHint: string;
}

const KEY = 'llm';
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-opus-5-5',
  'openai-compatible': '',
};

async function load(): Promise<{ value: Stored; updatedBy: string; updatedAt: Date } | null> {
  const { rows } = await db.query<{ value: Stored; updated_by: string; updated_at: Date }>(
    'SELECT value, updated_by, updated_at FROM settings WHERE key = $1',
    [KEY],
  );
  return rows[0] ? { value: rows[0].value, updatedBy: rows[0].updated_by, updatedAt: rows[0].updated_at } : null;
}

export async function getPublicSettings(): Promise<PublicLlmSettings> {
  const row = await load();
  if (!row) {
    return { configured: false, provider: 'anthropic', model: DEFAULT_MODELS.anthropic, baseUrl: '', hasKey: false, keyHint: '' };
  }
  const { value } = row;
  return {
    configured: Boolean(value.model) && (value.provider === 'openai-compatible' || Boolean(value.apiKeyEncrypted)),
    provider: value.provider,
    model: value.model,
    baseUrl: value.baseUrl,
    hasKey: Boolean(value.apiKeyEncrypted),
    keyHint: value.keyHint,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Returns the settings with the decrypted key, or null if not configured.
export async function getSettings(): Promise<LlmSettings | null> {
  const row = await load();
  if (!row) return null;
  const { value } = row;
  let apiKey = '';
  if (value.apiKeyEncrypted) {
    try {
      apiKey = decrypt(value.apiKeyEncrypted);
    } catch {
      throw new Error('The stored API key could not be decrypted (PONT_SECRET_KEY changed?). Enter it again in Settings.');
    }
  }
  if (!value.model || (value.provider === 'anthropic' && !apiKey)) return null;
  return { provider: value.provider, model: value.model, baseUrl: value.baseUrl, apiKey };
}

export interface SettingsUpdate {
  provider: Provider;
  model: string;
  baseUrl: string;
  // undefined keeps the stored key; '' removes it.
  apiKey?: string;
}

export async function saveSettings(update: SettingsUpdate, user: User): Promise<PublicLlmSettings> {
  const previous = (await load())?.value;
  let apiKeyEncrypted = previous?.apiKeyEncrypted ?? null;
  let keyHint = previous?.keyHint ?? '';
  if (update.apiKey !== undefined) {
    apiKeyEncrypted = update.apiKey ? encrypt(update.apiKey) : null;
    keyHint = update.apiKey ? `…${update.apiKey.slice(-4)}` : '';
  }
  const value: Stored = {
    provider: update.provider,
    model: update.model,
    baseUrl: update.baseUrl,
    apiKeyEncrypted,
    keyHint,
  };
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [KEY, JSON.stringify(value), user.name ?? user.username],
  );
  return getPublicSettings();
}
