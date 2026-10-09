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

export interface OntologySource {
  path: string;
  quote: string;
}

export interface Concept {
  id: string;
  name: string;
  type: string;
  definition: string;
  aliases: string[];
  sources: OntologySource[];
  updatedBy: string;
  updatedAt: string;
}

export interface Relation {
  id: string;
  from: string;
  type: string;
  to: string;
  name?: string;
  description?: string;
  sources: OntologySource[];
  updatedBy?: string;
  updatedAt?: string;
}

export interface ConceptDetail extends Concept {
  relations: (Relation & { label: string; fromName: string; toName: string })[];
  linkedFrom: string[];
}

export interface RelationDetail extends Relation {
  label: string;
  fromConcept: Concept | null;
  toConcept: Concept | null;
  linkedFrom: string[];
}

export interface OntologyHit {
  kind: 'concept' | 'relation';
  id: string;
  name: string;
  type: string;
  description: string;
}

export const CONCEPT_TYPES = ['Metric', 'Process', 'Decision', 'Policy', 'System', 'Team', 'Term'] as const;
export const RELATION_TYPES = ['calculated_from', 'depends_on', 'part_of', 'owned_by', 'uses', 'related_to'] as const;

export interface Ontology {
  concepts: Concept[];
  relations: Relation[];
}

export interface ChangePreview {
  added: string[];
  modified: string[];
  deleted: string[];
  total: number;
  estimate: {
    provider: string;
    model: string;
    batches: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: { low: number; high: number } | null;
  } | null;
}

export interface OntologyRun {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedBy: string;
  provider: string;
  model: string;
  changes: { added: string[]; modified: string[]; deleted: string[] };
  progress: { workflow?: string; batch?: number; batches?: number; recommendations?: number };
  usage: { inputTokens?: number; outputTokens?: number; modelCalls?: number; costUsd?: number | null };
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  recommendations: number;
}

export interface OntologyRecommendation {
  id: string;
  runId: string;
  workflow: 'maintain' | 'create' | 'agent';
  proposedBy: string | null;
  action: 'create_concept' | 'update_concept' | 'delete_concept' | 'add_alias' | 'create_relation' | 'delete_relation';
  payload: Record<string, unknown>;
  rationale: string;
  evidence: OntologySource[];
  confidence: number;
  status: string;
  error: string | null;
}

export interface Proposal {
  id: string;
  kind: 'edit' | 'new';
  path: string;
  baseVersionId: string | null;
  reason: string;
  proposedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface ProposalDetail extends Proposal {
  patch: string;
  stale: boolean;
  proposedContent: string | null;
  currentContent: string | null;
  currentVersionId: string | null;
  problem: string | null;
}

export interface PageVersion {
  versionId: string;
  deleted: boolean;
  current: boolean;
  modifiedAt: string;
  size: number;
  author?: Author;
  proposalId?: string;
  proposedBy?: string;
  restoredFrom?: string;
  movedFrom?: string;
  reviewId?: string;
}

export type ReviewItemState = 'open' | 'applied' | 'dismissed';

export interface ReviewSuggestion {
  id: string;
  category: string;
  quote: string;
  replacement: string;
  reason: string;
  applicable: boolean;
  state: ReviewItemState;
}

export interface ReviewConflict {
  id: string;
  quote: string;
  found: boolean;
  otherPath: string;
  otherSection: string;
  otherQuote: string;
  explanation: string;
  likelyCorrect: 'this_page' | 'other_page' | 'unclear';
  replacement: string;
  applicable: boolean;
  state: ReviewItemState;
}

export interface ReviewLink {
  id: string;
  kind: 'concept' | 'relation';
  targetId: string;
  targetName: string;
  targetType: string;
  term: string;
  context: string;
  reason: string;
  applicable: boolean;
  state: ReviewItemState;
}

export interface PageReview {
  id: string;
  path: string;
  versionId: string | null;
  status: 'running' | 'succeeded' | 'failed';
  startedBy: string;
  provider: string;
  model: string;
  compared: string[];
  result: {
    summary: string;
    suggestions: ReviewSuggestion[];
    conflicts: ReviewConflict[];
    // Absent on reviews made before link suggestions existed.
    links?: ReviewLink[];
  } | null;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number | null };
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ReviewEstimate {
  provider: string;
  model: string;
  compared: string[];
  passages: number;
  linkCandidates: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: { low: number; high: number } | null;
}

export interface PageVersionDetail extends PageVersion {
  content: string;
  previousVersionId: string | null;
  patch: string;
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

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const entryUrl = (path: string) => `/api/entries/${encodePath(path)}`;

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
  latestReview: (path: string) => request<PageReview | null>(`/api/reviews?path=${encodeURIComponent(path)}`),
  reviewEstimate: (path: string) =>
    request<ReviewEstimate | null>(`/api/reviews/estimate?path=${encodeURIComponent(path)}`),
  startReview: (path: string) => request<PageReview>('/api/reviews', json('POST', { path })),
  review: (id: string) => request<PageReview>(`/api/reviews/${id}`),
  decideReviewItem: (id: string, item: string, action: 'apply' | 'dismiss') =>
    request<PageReview>(`/api/reviews/${id}/items/${item}`, json('POST', { action })),
  ontology: () => request<Ontology>('/api/ontology'),
  ontologyChanges: () => request<ChangePreview>('/api/ontology/changes'),
  ontologyRuns: () => request<OntologyRun[]>('/api/ontology/runs'),
  ontologyRun: (id: string) => request<OntologyRun>(`/api/ontology/runs/${id}`),
  startOntologyRun: () => request<OntologyRun>('/api/ontology/runs', { method: 'POST' }),
  cancelOntologyRun: (id: string) => request<OntologyRun>(`/api/ontology/runs/${id}/cancel`, { method: 'POST' }),
  ontologyRecommendations: () => request<OntologyRecommendation[]>('/api/ontology/recommendations'),
  approveRecommendation: (id: string) =>
    request<{ status: 'approved' | 'failed'; message: string }>(`/api/ontology/recommendations/${id}/approve`, {
      method: 'POST',
    }),
  rejectRecommendation: (id: string) => request<void>(`/api/ontology/recommendations/${id}/reject`, { method: 'POST' }),
  decideRecommendations: (action: 'approve' | 'reject', ids: string[]) =>
    request<{ id: string; status: 'approved' | 'rejected' | 'failed' | 'pending'; message: string }[]>(
      '/api/ontology/recommendations/bulk',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ids }) },
    ),
  proposals: (status: 'pending' | 'decided' = 'pending') => request<Proposal[]>(`/api/proposals?status=${status}`),
  proposalCounts: () => request<Record<string, number>>('/api/proposals/counts'),
  proposal: (id: string) => request<ProposalDetail>(`/api/proposals/${id}`),
  approveProposal: (id: string, edited?: { content: string; baseVersionId: string | null }) =>
    request<{ path: string; versionId: string | null }>(`/api/proposals/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edited ?? {}),
    }),
  rejectProposal: (id: string, note: string) =>
    request<void>(`/api/proposals/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    }),
  history: (path: string) => request<PageVersion[]>(`/api/history/${encodePath(path)}`),
  version: (path: string, versionId: string) =>
    request<PageVersionDetail>(`/api/history/${encodePath(path)}?version=${encodeURIComponent(versionId)}`),
  restoreVersion: (path: string, versionId: string) =>
    request<Entry>(`/api/history/${encodePath(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restore: versionId }),
    }),
  searchOntology: (q: string) => request<OntologyHit[]>(`/api/ontology/search?${new URLSearchParams({ q })}`),
  concept: (id: string) => request<ConceptDetail>(`/api/ontology/concepts/${encodeURIComponent(id)}`),
  createConcept: (body: { name: string; type: string; definition?: string; aliases?: string[] }) =>
    request<Concept>('/api/ontology/concepts', json('POST', body)),
  updateConcept: (id: string, body: Record<string, unknown>) =>
    request<Concept>(`/api/ontology/concepts/${encodeURIComponent(id)}`, json('PUT', body)),
  deleteConcept: (id: string) =>
    request<{ relationsRemoved: number; linkedFrom: string[] }>(`/api/ontology/concepts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  relation: (id: string) => request<RelationDetail>(`/api/ontology/relations/${encodeURIComponent(id)}`),
  createRelation: (body: { from: string; type: string; to: string; name?: string; description?: string }) =>
    request<Relation>('/api/ontology/relations', json('POST', body)),
  updateRelation: (id: string, body: Record<string, unknown>) =>
    request<Relation>(`/api/ontology/relations/${encodeURIComponent(id)}`, json('PUT', body)),
  deleteRelation: (id: string) =>
    request<{ linkedFrom: string[] }>(`/api/ontology/relations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listTokens: () => request<TokenInfo[]>('/api/tokens'),
  createToken: (name: string) =>
    request<{ token: string; info: TokenInfo }>('/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  revokeToken: (id: string) => request<void>(`/api/tokens/${id}`, { method: 'DELETE' }),
};
