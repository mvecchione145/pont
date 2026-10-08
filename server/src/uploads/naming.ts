import { EntryError, parsePath } from '../entries.js';
import { SUPPORTED, type Extension } from './convert.js';

// Maps an uploaded file's relative path (from a folder upload, e.g.
// "Handbook/Eng/On-call.md") into a page path under the chosen folder
// ("docs/Handbook/Eng/On-call"). Characters pages can't use are replaced, so
// most real-world file names import without renaming by hand.

export type Destination =
  | { ok: true; path: string; extension: Extension }
  | { ok: false; reason: 'hidden' | 'unsupported' | 'invalid'; message: string };

function cleanSegment(segment: string): string {
  const cleaned = segment
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // é -> e
    .replace(/[^A-Za-z0-9 _.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[\s.-]+$/, '');
  return cleaned || 'Untitled';
}

export function destinationFor(relativePath: string, folder: string): Destination {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const file = parts.pop();
  if (!file) return { ok: false, reason: 'invalid', message: 'Empty file name.' };
  if ([...parts, file].some((p) => p.startsWith('.'))) {
    return { ok: false, reason: 'hidden', message: 'Hidden file or folder.' };
  }

  const dot = file.lastIndexOf('.');
  const extension = (dot > 0 ? file.slice(dot) : '').toLowerCase();
  if (!(SUPPORTED as readonly string[]).includes(extension)) {
    return {
      ok: false,
      reason: 'unsupported',
      message: `${extension || 'Files without an extension'} ${extension ? 'files are' : 'are'} not supported.`,
    };
  }

  const base = folder.trim() ? folder.split('/').filter(Boolean) : [];
  const segments = [...base, ...parts.map(cleanSegment), cleanSegment(file.slice(0, dot))];
  try {
    return { ok: true, path: parsePath(segments.join('/')), extension: extension as Extension };
  } catch (err) {
    if (err instanceof EntryError) {
      return { ok: false, reason: 'invalid', message: 'Too many nested folders (pages can be at most 8 levels deep).' };
    }
    throw err;
  }
}
