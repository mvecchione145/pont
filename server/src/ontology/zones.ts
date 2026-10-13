import { ListObjectsV2Command, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { s3 } from '../clients.js';
import { config } from '../config.js';
import { listEntries } from '../entries.js';

// Zones: a logical separation of the documentation. Every top-level folder is
// a zone, and pages at the root belong to the default zone (""). Each zone
// has its own ontology, calculated only from its own pages, with its own runs,
// snapshots, and review queue. Moving a page to another top-level folder
// moves it to that zone.
//
// Concepts are referred to across zones by a "ref": "<zone>/<id>", or just
// "<id>" in the default zone, so links written before zones existed
// (#/concept/<id>) still point where they did.

export const DEFAULT_ZONE = '';
export const DEFAULT_ZONE_NAME = 'General';

export const zoneOf = (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : DEFAULT_ZONE);
export const inZone = (zone: string) => (path: string) => zoneOf(path) === zone;
export const zoneName = (zone: string) => zone || DEFAULT_ZONE_NAME;

export const toRef = (zone: string, id: string) => (zone ? `${zone}/${id}` : id);
export function fromRef(ref: string): { zone: string; id: string } {
  const at = ref.lastIndexOf('/');
  return at < 0 ? { zone: DEFAULT_ZONE, id: ref } : { zone: ref.slice(0, at), id: ref.slice(at + 1) };
}

// A ref as it appears in a link: each part URI-encoded, since zone names
// (folder names) may contain spaces.
export const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

export class ZoneError extends Error {}

// Zone names come from requests: a folder name, or "" for the default zone.
export function parseZone(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ZONE;
  if (typeof raw !== 'string' || raw.includes('/') || raw.trim() !== raw || raw.length > 200 || raw.startsWith('.')) {
    throw new ZoneError(`"${String(raw)}" is not a zone.`);
  }
  return raw;
}

export interface ZoneSummary {
  zone: string;
  name: string;
  pages: number;
}

// Zones that exist: the default zone, every top-level folder with pages, and
// any zone that still has an ontology after its pages were moved away.
export async function listZones(): Promise<ZoneSummary[]> {
  const pages = new Map<string, number>([[DEFAULT_ZONE, 0]]);
  for (const e of await listEntries()) {
    const z = zoneOf(e.path);
    pages.set(z, (pages.get(z) ?? 0) + 1);
  }
  for (const z of await zonesWithOntology()) if (!pages.has(z)) pages.set(z, 0);
  return [...pages.entries()]
    .map(([zone, n]) => ({ zone, name: zoneName(zone), pages: n }))
    .sort((a, b) => (a.zone === DEFAULT_ZONE ? -1 : b.zone === DEFAULT_ZONE ? 1 : a.zone.localeCompare(b.zone)));
}

export const ZONE_PREFIX = 'ontology/zones/';
const ZONE_SUFFIX = '.yaml';

async function zonesWithOntology(): Promise<string[]> {
  const zones: string[] = [];
  let token: string | undefined;
  do {
    const page: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({ Bucket: config.minio.bucket, Prefix: ZONE_PREFIX, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key?.endsWith(ZONE_SUFFIX)) zones.push(obj.Key.slice(ZONE_PREFIX.length, -ZONE_SUFFIX.length));
    }
    token = page.NextContinuationToken;
  } while (token);
  return zones;
}

// The default zone keeps the ontology file from before zones existed.
export const ontologyKey = (zone: string) => (zone ? `${ZONE_PREFIX}${zone}${ZONE_SUFFIX}` : 'ontology/ontology.yaml');
