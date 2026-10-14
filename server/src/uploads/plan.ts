import { EntryError, getEntry, listEntries, parsePath, saveEntry } from '../entries.js';
import type { User } from '../auth.js';
import { convert, ConversionError } from './convert.js';
import { destinationFor } from './naming.js';

// Upload in two steps. preview() takes only names and sizes and says where
// each file would go and whether it would replace a page; nothing is written.
// importFiles() then converts and saves, replacing existing pages only when
// the user ticked them in the preview.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 500;

export type PreviewStatus = 'new' | 'exists' | 'duplicate' | 'unsupported' | 'hidden' | 'invalid' | 'too-large';

export interface PreviewItem {
  name: string;
  path?: string;
  status: PreviewStatus;
  message?: string;
}

export type ImportStatus = 'created' | 'replaced' | 'skipped' | 'failed';

export interface ImportItem {
  name: string;
  path?: string;
  status: ImportStatus;
  message?: string;
  notes?: string[];
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

export function cleanFolder(folder: unknown): string {
  if (folder === undefined || folder === null || folder === '') return '';
  if (typeof folder !== 'string') throw new UploadError('"folder" must be a string.');
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  try {
    return parsePath(trimmed);
  } catch {
    throw new UploadError(`"${folder}" is not a valid folder name.`);
  }
}

export async function preview(folder: string, files: { name: string; size: number }[]): Promise<PreviewItem[]> {
  if (files.length > MAX_FILES) throw new UploadError(`At most ${MAX_FILES} files per upload.`);
  const existing = new Set((await listEntries()).map((e) => e.path));
  const claimed = new Set<string>();

  return files.map(({ name, size }) => {
    const dest = destinationFor(name, folder);
    if (!dest.ok) return { name, status: dest.reason, message: dest.message };
    if (size > MAX_FILE_BYTES) {
      return { name, path: dest.path, status: 'too-large', message: 'Larger than 10 MB.' };
    }
    if (claimed.has(dest.path)) {
      return { name, path: dest.path, status: 'duplicate', message: 'Another file in this upload has the same page name.' };
    }
    claimed.add(dest.path);
    return existing.has(dest.path)
      ? { name, path: dest.path, status: 'exists', message: 'A page with this name already exists.' }
      : { name, path: dest.path, status: 'new' };
  });
}

export async function importFiles(
  folder: string,
  files: { name: string; data: Buffer }[],
  replace: Set<string>,
  user: User,
): Promise<ImportItem[]> {
  const plan = await preview(
    folder,
    files.map((f) => ({ name: f.name, size: f.data.length })),
  );
  const results: ImportItem[] = [];

  for (const [i, item] of plan.entries()) {
    const { name, path } = item;
    if (item.status !== 'new' && item.status !== 'exists') {
      results.push({ name, path, status: 'skipped', message: item.message });
      continue;
    }
    if (item.status === 'exists' && !replace.has(path!)) {
      results.push({ name, path, status: 'skipped', message: 'Kept the existing page.' });
      continue;
    }

    let converted;
    try {
      converted = await convert(destinationExtension(name, folder), files[i].data);
    } catch (err) {
      if (!(err instanceof ConversionError)) throw err;
      results.push({ name, path, status: 'failed', message: err.message });
      continue;
    }

    try {
      if (item.status === 'exists') {
        const current = await getEntry(path!);
        await saveEntry(path!, converted.markdown, current.versionId ?? null, user);
        results.push({ name, path, status: 'replaced', notes: converted.notes });
      } else {
        await saveEntry(path!, converted.markdown, null, user);
        results.push({ name, path, status: 'created', notes: converted.notes });
      }
    } catch (err) {
      if (!(err instanceof EntryError)) throw err;
      results.push({ name, path, status: 'failed', message: err.message });
    }
  }
  return results;
}

function destinationExtension(name: string, folder: string) {
  const dest = destinationFor(name, folder);
  if (!dest.ok) throw new Error('unreachable: planned file has no destination');
  return dest.extension;
}
