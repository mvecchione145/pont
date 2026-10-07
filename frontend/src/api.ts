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
};
