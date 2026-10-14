import { GetObjectCommand, ListObjectsV2Command, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import YAML from 'yaml';
import { db, s3 } from '../clients.js';
import { config } from '../config.js';
import { readOntology, updateOntology, type Ontology } from './store.js';

// The ontology as plain YAML, the format pont used before it moved to Neo4j:
// export (so the ontology is never locked into the database) and the one-time
// import of the YAML files from the bucket.

export async function exportYaml(zone: string): Promise<string> {
  const { ontology } = await readOntology(zone);
  return YAML.stringify(ontology, { lineWidth: 0 });
}

// Before Neo4j, each zone's ontology was a YAML file in the bucket: the
// default zone's at ontology/ontology.yaml, the others' at
// ontology/zones/<zone>.yaml. They are imported into Neo4j once and left in
// the bucket untouched, as a copy of the ontology as it was then.
const LEGACY_DEFAULT = 'ontology/ontology.yaml';
const LEGACY_PREFIX = 'ontology/zones/';
const MARKER = 'ontology.yaml-imported';

async function legacyFiles(): Promise<{ zone: string; key: string }[]> {
  const files = [{ zone: '', key: LEGACY_DEFAULT }];
  let token: string | undefined;
  do {
    const page: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({ Bucket: config.minio.bucket, Prefix: LEGACY_PREFIX, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key?.endsWith('.yaml')) files.push({ zone: obj.Key.slice(LEGACY_PREFIX.length, -'.yaml'.length), key: obj.Key });
    }
    token = page.NextContinuationToken;
  } while (token);
  return files;
}

async function readLegacy(key: string): Promise<Ontology | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.minio.bucket, Key: key }));
    const parsed = (YAML.parse((await res.Body?.transformToString('utf-8')) ?? '') ?? {}) as Partial<Ontology>;
    return { version: 1, concepts: parsed.concepts ?? [], relations: parsed.relations ?? [] };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    throw err;
  }
}

// Runs on start. The marker is kept in Postgres rather than in Neo4j, so a
// lost graph volume comes back empty instead of silently reloading the
// old files.
export async function importLegacyYaml(): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM settings WHERE key = $1', [MARKER]);
  if (rows.length) return;
  const imported: Record<string, { concepts: number; relations: number }> = {};
  for (const { zone, key } of await legacyFiles()) {
    const legacy = await readLegacy(key);
    if (!legacy) continue;
    await updateOntology(zone, (o) => {
      // Merge, never overwrite: anything already in the graph wins.
      const ids = new Set(o.concepts.map((c) => c.id));
      o.concepts.push(...legacy.concepts.filter((c) => !ids.has(c.id)));
      const known = new Set(o.concepts.map((c) => c.id));
      const relationIds = new Set(o.relations.map((r) => r.id));
      o.relations.push(...legacy.relations.filter((r) => !relationIds.has(r.id) && known.has(r.from) && known.has(r.to)));
    });
    imported[zone || '(default)'] = { concepts: legacy.concepts.length, relations: legacy.relations.length };
  }
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, 'pont')
     ON CONFLICT (key) DO NOTHING`,
    [MARKER, JSON.stringify({ at: new Date().toISOString(), imported })],
  );
  console.log('ontology: imported the YAML files into Neo4j:', JSON.stringify(imported));
}
