import { apiFetch } from './auth';

export interface Author {
  id: string;
  name: string;
}

export interface EntrySummary {
  path: string;
  lastModified?: string;
  size?: number;
}

export interface Entry {
  path: string;
  content: string;
  versionId?: string;
  lastModified?: string;
  author?: Author;
}

export interface User {
  id: string;
  username: string;
  email?: string;
  name?: string;
}

export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SearchResult {
  path: string;
  title: string;
  headings: string;
  content: string;
  score: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const entryUrl = (path: string) =>
  `/api/entries/${path.split('/').map(encodeURIComponent).join('/')}`;

export const api = {
  me: () => request<User>('/api/me'),
  listEntries: () => request<EntrySummary[]>('/api/entries'),
  getEntry: (path: string) => request<Entry>(entryUrl(path)),
  saveEntry: (path: string, content: string, baseVersionId: string | null) =>
    request<Entry>(entryUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseVersionId }),
    }),
  deleteEntry: (path: string) => request<void>(entryUrl(path), { method: 'DELETE' }),
  createUntitled: (folder: string) =>
    request<Entry>('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    }),
  moveEntry: (path: string, to: string, baseVersionId: string) =>
    request<Entry>(`${entryUrl(path)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, baseVersionId }),
    }),
  search: (q: string, limit = 12) =>
    request<SearchResult[]>(`/api/search?${new URLSearchParams({ q, limit: String(limit) })}`),
  listTokens: () => request<TokenInfo[]>('/api/tokens'),
  createToken: (name: string) =>
    request<{ token: string; info: TokenInfo }>('/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  revokeToken: (id: string) => request<void>(`/api/tokens/${id}`, { method: 'DELETE' }),
};
