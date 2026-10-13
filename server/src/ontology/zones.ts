import { listEntries } from '../entries.js';
import { zonesWithConcepts } from './store.js';

// Zones: a logical separation of the documentation. Every top-level folder is
// a zone with its own ontology, calculated only from that folder's pages,
// with its own runs, snapshots, and review queue. The default zone ("",
// shown as General) is the organization-wide ontology: it is calculated from
// every page, at the root and in every folder. A page in a folder therefore
// feeds two ontologies: its folder's and General's.
//
// Concepts are referred to across zones by a "ref": "<zone>/<id>", or just
// "<id>" in the default zone, so links written before zones existed
// (#/concept/<id>) still point where they did.

export const DEFAULT_ZONE = '';
export const DEFAULT_ZONE_NAME = 'General';

// The folder zone a page is in ("" at the root). Not the same as which
// ontologies cover it: see covers.
export const zoneOf = (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : DEFAULT_ZONE);
// Whether a zone's ontology is calculated from (and may cite) this page:
// General covers every page, a folder zone only its own.
export const covers = (zone: string, path: string) => zone === DEFAULT_ZONE || zoneOf(path) === zone;
export const inZone = (zone: string) => (path: string) => covers(zone, path);
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

// Zones that exist: General, every top-level folder with pages, and any zone
// that still has an ontology after its pages were moved away. Page counts are
// the pages each zone's ontology covers (General: all of them).
export async function listZones(): Promise<ZoneSummary[]> {
  const entries = await listEntries();
  const pages = new Map<string, number>([[DEFAULT_ZONE, entries.length]]);
  for (const e of entries) {
    const z = zoneOf(e.path);
    if (z !== DEFAULT_ZONE) pages.set(z, (pages.get(z) ?? 0) + 1);
  }
  for (const z of await zonesWithConcepts()) if (!pages.has(z)) pages.set(z, 0);
  return [...pages.entries()]
    .map(([zone, n]) => ({ zone, name: zoneName(zone), pages: n }))
    .sort((a, b) => (a.zone === DEFAULT_ZONE ? -1 : b.zone === DEFAULT_ZONE ? 1 : a.zone.localeCompare(b.zone)));
}
