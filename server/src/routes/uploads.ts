import { Router, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import {
  cleanFolder,
  importFiles,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  preview,
  UploadError,
} from '../uploads/plan.js';

export const uploadsRouter = Router();

// Files are held in memory (at most 50 MB per upload) and converted directly.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 10, fieldSize: 1024 * 1024 },
});

function parseJsonArray(value: unknown, field: string): unknown[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new UploadError(`"${field}" must be a JSON array.`);
}

// POST /api/uploads/preview { folder, files: [{ name, size }] }
// "name" is the path relative to the uploaded folder, e.g. "Handbook/On-call.md".
uploadsRouter.post('/preview', async (req, res) => {
  const folder = cleanFolder(req.body?.folder);
  const files = parseJsonArray(req.body?.files, 'files').map((f) => {
    const { name, size } = (f ?? {}) as { name?: unknown; size?: unknown };
    if (typeof name !== 'string' || typeof size !== 'number') {
      throw new UploadError('Each file needs a "name" and a "size".');
    }
    return { name, size };
  });
  res.json(await preview(folder, files));
});

// POST /api/uploads (multipart): "files" (repeated), "paths" (JSON array of
// relative paths, same order as the files), "folder", and "replace" (JSON
// array of page paths the user agreed to replace).
uploadsRouter.post('/', upload.array('files', MAX_FILES), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw new UploadError('No files were uploaded.');
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new UploadError('An upload can be at most 50 MB in total.', 413);

  const paths = parseJsonArray(req.body.paths, 'paths');
  if (paths.length !== files.length || !paths.every((p) => typeof p === 'string')) {
    throw new UploadError('"paths" must list one relative path per file.');
  }
  const replace = new Set(parseJsonArray(req.body.replace ?? '[]', 'replace').filter((p) => typeof p === 'string') as string[]);
  const folder = cleanFolder(req.body.folder);

  const results = await importFiles(
    folder,
    files.map((f, i) => ({ name: paths[i] as string, data: f.buffer })),
    replace,
    req.user!,
  );
  res.json(results);
});

export const uploadErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof UploadError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Each file can be at most 10 MB.'
        : err.code === 'LIMIT_FILE_COUNT'
          ? `At most ${MAX_FILES} files per upload.`
          : `Upload rejected: ${err.message}`;
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    return;
  }
  next(err);
};
