// Zones (see server/src/ontology/zones.ts): every top-level folder is a zone
// with its own ontology, and pages at the root are in the default zone ("").
// A concept or relationship is referred to by its "ref": "<zone>/<id>", or
// just "<id>" in the default zone, as in #/concept/<ref> links.

export const DEFAULT_ZONE = '';

export const zoneOf = (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : DEFAULT_ZONE);
export const zoneName = (zone: string) => zone || 'General';
export const toRef = (zone: string, id: string) => (zone ? `${zone}/${id}` : id);
export function fromRef(ref: string): { zone: string; id: string } {
  const at = ref.lastIndexOf('/');
  return at < 0 ? { zone: DEFAULT_ZONE, id: ref } : { zone: ref.slice(0, at), id: ref.slice(at + 1) };
}

export interface ZoneSummary {
  zone: string;
  name: string;
  pages: number;
  concepts: number;
  relations: number;
  pending: number;
}
