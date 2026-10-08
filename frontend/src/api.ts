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

export type Provider = 'anthropic' | 'openai-compatible';

export interface LlmSettings {
  configured: boolean;
  provider: Provider;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  keyHint: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface SampleQuestion {
  question: string;
  correct_answer: string;
  wrong_answers: string[];
  explanation: string;
}

export interface TriviaQuestion {
  id: string;
  path: string;
  headings: string;
  question: string;
  options: string[];
}

export interface Scores {
  allTime: number;
  week: number;
}

export interface TriviaResult {
  correct?: boolean;
  correctIndex: number;
  explanation: string;
  path: string;
  headings: string;
  scores: Scores;
}

export interface LeaderboardRow {
  userId: string;
  name: string;
  score: number;
  answered: number;
  correct: number;
}

export type PreviewStatus = 'new' | 'exists' | 'duplicate' | 'unsupported' | 'hidden' | 'invalid' | 'too-large';

export interface PreviewItem {
  name: string;
  path?: string;
  status: PreviewStatus;
  message?: string;
}

export interface ImportItem {
  name: string;
  path?: string;
  status: 'created' | 'replaced' | 'skipped' | 'failed';
  message?: string;
  notes?: string[];
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
  getLlmSettings: () => request<LlmSettings>('/api/settings/llm'),
  saveLlmSettings: (s: { provider: Provider; model: string; baseUrl: string; apiKey?: string }) =>
    request<LlmSettings>('/api/settings/llm', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    }),
  testLlm: () => request<{ ok: true; sample: SampleQuestion }>('/api/settings/llm/test', { method: 'POST' }),
  currentQuestion: () => request<TriviaQuestion | null>('/api/trivia/current'),
  nextQuestion: () => request<TriviaQuestion>('/api/trivia/questions', { method: 'POST' }),
  answer: (id: string, choice: number) =>
    request<TriviaResult>(`/api/trivia/questions/${id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    }),
  skip: (id: string) => request<TriviaResult>(`/api/trivia/questions/${id}/skip`, { method: 'POST' }),
  leaderboard: (period: 'all' | 'week') => request<LeaderboardRow[]>(`/api/trivia/leaderboard?period=${period}`),
  previewUpload: (folder: string, files: { name: string; size: number }[]) =>
    request<PreviewItem[]>('/api/uploads/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, files }),
    }),
  upload: (folder: string, files: { file: File; name: string }[], replace: string[]) => {
    const form = new FormData();
    form.append('folder', folder);
    form.append('paths', JSON.stringify(files.map((f) => f.name)));
    form.append('replace', JSON.stringify(replace));
    for (const f of files) form.append('files', f.file);
    return request<ImportItem[]>('/api/uploads', { method: 'POST', body: form });
  },
  listTokens: () => request<TokenInfo[]>('/api/tokens'),
  createToken: (name: string) =>
    request<{ token: string; info: TokenInfo }>('/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  revokeToken: (id: string) => request<void>(`/api/tokens/${id}`, { method: 'DELETE' }),
};
