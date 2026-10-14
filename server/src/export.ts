import { Router } from 'express';
import { crc32, deflateRawSync } from 'node:zlib';
import { getEntry, listEntries, parsePath } from './entries.js';
import { zonesWithConcepts } from './ontology/store.js';
import { exportYaml } from './ontology/yaml.js';
import { listZones, zoneName } from './ontology/zones.js';

// Export: every page as a Markdown file, in its folders, plus each zone's
// ontology as YAML, in one .zip people can keep or open in any editor.
// Optionally just one folder (and its zone's ontology, if it is a zone).
//
//   pont-export-2026-10-14/
//     README.md
//     deals/plan.md
//     _ontology/general.yaml
//     _ontology/deals.yaml

interface ZipFile {
  name: string;
  data: Buffer;
  modified: Date;
}

// DOS date and time, as zip headers store them (local time, 2-second steps).
function dosDateTime(d: Date): [number, number] {
  const year = Math.max(1980, d.getFullYear());
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ];
}

// A minimal zip writer: deflated files with UTF-8 names, no zip64 (fine below
// 65,535 files and 4 GB, far beyond a docs export).
export function zip(files: ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf-8');
    const packed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const [time, date] = dosDateTime(file.modified);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number, attributes: all zero.
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const today = () => new Date().toISOString().slice(0, 10);
const slug = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'export';

export async function buildExport(folder: string): Promise<{ filename: string; data: Buffer; pages: number }> {
  const scope = folder ? `${folder}/` : '';
  const entries = (await listEntries()).filter((e) => e.path.startsWith(scope));
  const root = `pont-export${folder ? `-${slug(folder)}` : ''}-${today()}`;
  const now = new Date();
  const files: ZipFile[] = [];

  for (const e of entries) {
    const entry = await getEntry(e.path);
    files.push({
      name: `${root}/${e.path}.md`,
      data: Buffer.from(entry.content, 'utf-8'),
      modified: entry.lastModified ? new Date(entry.lastModified) : now,
    });
  }

  // Ontologies that have concepts: every zone for a full export; for a
  // top-level folder, its zone.
  const withConcepts = new Set(await zonesWithConcepts());
  const zones = (await listZones()).map((z) => z.zone).filter((z) => withConcepts.has(z) && (!folder || z === folder));
  const ontologies: string[] = [];
  for (const zone of zones) {
    const yaml = await exportYaml(zone);
    const file = `${slug(zoneName(zone).toLowerCase())}.yaml`;
    ontologies.push(`- \`_ontology/${file}\`: ${zoneName(zone)}`);
    files.push({ name: `${root}/_ontology/${file}`, data: Buffer.from(yaml, 'utf-8'), modified: now });
  }

  const readme = [
    `# pont export`,
    '',
    `Exported ${now.toISOString()}${folder ? ` from the folder "${folder}"` : ''}: ${entries.length} ${entries.length === 1 ? 'page' : 'pages'}.`,
    '',
    'Each page is a Markdown file at its path in pont. Links between pages look like `#/p/<path>`, and links to the ontology like `#/concept/<zone>/<id>`; they open in pont, not here.',
    ...(ontologies.length ? ['', 'Ontologies, one per zone:', '', ...ontologies] : []),
    '',
  ].join('\n');
  files.unshift({ name: `${root}/README.md`, data: Buffer.from(readme, 'utf-8'), modified: now });

  return { filename: `${root}.zip`, data: zip(files), pages: entries.length };
}

export const exportRouter = Router();

exportRouter.get('/', async (req, res) => {
  const raw = typeof req.query.folder === 'string' ? req.query.folder.trim().replace(/\/+$/, '') : '';
  const folder = raw ? parsePath(raw) : '';
  const { filename, data } = await buildExport(folder);
  res.type('application/zip').attachment(filename).set('Cache-Control', 'no-store').send(data);
});
