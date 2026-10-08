import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import YAML from 'yaml';
import { s3 } from '../clients.js';
import { config } from '../config.js';

// The ontology: concepts and typed relationships between them, kept as one
// YAML file in the versioned bucket, next to (not inside) the knowledge pages.
// Every change goes through updateOntology(), which retries on concurrent
// writes so two approvals at once can't overwrite each other.

export const CONCEPT_TYPES = ['Metric', 'Process', 'Decision', 'Policy', 'System', 'Team', 'Term'] as const;
export type ConceptType = (typeof CONCEPT_TYPES)[number];

export const RELATION_TYPES = [
  'calculated_from',
  'depends_on',
  'part_of',
  'owned_by',
  'uses',
  'related_to',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface Source {
  path: string;
  quote: string;
}

export interface Concept {
  id: string;
  name: string;
  type: ConceptType;
  definition: string;
  aliases: string[];
  sources: Source[];
  updatedBy: string;
  updatedAt: string;
}

export interface Relation {
  id: string;
  from: string;
  type: RelationType;
  to: string;
  sources: Source[];
  updatedBy: string;
  updatedAt: string;
}

export interface Ontology {
  version: 1;
  concepts: Concept[];
  relations: Relation[];
}

const KEY = 'ontology/ontology.yaml';
const bucket = config.minio.bucket;
const EMPTY: Ontology = { version: 1, concepts: [], relations: [] };

const isNotFound = (err: unknown) => {
  const name = (err as { name?: string })?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
};

export async function readOntology(): Promise<{ ontology: Ontology; etag: string | null }> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: KEY }));
    const text = (await res.Body?.transformToString('utf-8')) ?? '';
    const parsed = (YAML.parse(text) ?? {}) as Partial<Ontology>;
    return {
      ontology: { version: 1, concepts: parsed.concepts ?? [], relations: parsed.relations ?? [] },
      etag: res.ETag ?? null,
    };
  } catch (err) {
    if (isNotFound(err)) return { ontology: structuredClone(EMPTY), etag: null };
    throw err;
  }
}

export class OntologyConflictError extends Error {}

const isPreconditionFailed = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412;
};

// Applies a change to the latest ontology and saves it with a conditional
// write (If-Match on the ETag we read). If someone else saved in between, the
// change is re-applied to their version, up to 3 times.
export async function updateOntology<T>(change: (ontology: Ontology) => T): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { ontology, etag } = await readOntology();
    const result = change(ontology);
    ontology.concepts.sort((a, b) => a.name.localeCompare(b.name));
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: KEY,
          Body: YAML.stringify(ontology, { lineWidth: 0 }),
          ContentType: 'application/yaml; charset=utf-8',
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
      );
      return result;
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
    }
  }
  throw new OntologyConflictError('The ontology changed while saving. Try again.');
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'concept'
  );
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

// Finds a concept by id, name, or alias (case-insensitive).
export function findConcept(ontology: Ontology, ref: string): Concept | undefined {
  const key = ref.trim().toLowerCase();
  return (
    ontology.concepts.find((c) => c.id === key) ??
    ontology.concepts.find((c) => c.name.toLowerCase() === key) ??
    ontology.concepts.find((c) => c.aliases.some((a) => a.toLowerCase() === key))
  );
}
