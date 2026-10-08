import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, type ImportItem, type PreviewItem, type PreviewStatus } from '../api';
import { href } from '../route';

const ACCEPT = '.md,.markdown,.txt,.docx,.html,.htm,.pdf';

interface Picked {
  file: File;
  // Path relative to what was picked or dropped, e.g. "Handbook/On-call.md".
  name: string;
}

const STATUS_LABEL: Record<PreviewStatus, string> = {
  new: 'New page',
  exists: 'Already exists',
  duplicate: 'Duplicate',
  unsupported: 'Not supported',
  hidden: 'Hidden file',
  invalid: 'Can’t import',
  'too-large': 'Too large',
};

// Reads every file inside a dropped folder, keeping relative paths.
async function walk(entry: FileSystemEntry, prefix = ''): Promise<Picked[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ file, name: `${prefix}${entry.name}` }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // readEntries returns results in batches until it returns an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const nested = await Promise.all(children.map((c) => walk(c, `${prefix}${entry.name}/`)));
  return nested.flat();
}

interface Props {
  defaultFolder: string;
  onClose: () => void;
  onImported: () => void;
}

export function UploadDialog({ defaultFolder, onClose, onImported }: Props) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [folder, setFolder] = useState(defaultFolder);
  const [plan, setPlan] = useState<PreviewItem[] | null>(null);
  const [replace, setReplace] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<'pick' | 'importing' | 'done'>('pick');
  const [results, setResults] = useState<ImportItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // React doesn't know the non-standard folder-picker attribute.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && phase !== 'importing' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  // Re-plan whenever the files or the destination folder change.
  useEffect(() => {
    if (picked.length === 0) {
      setPlan(null);
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .previewUpload(
          folder,
          picked.map((p) => ({ name: p.name, size: p.file.size })),
        )
        .then(
          (items) => {
            setPlan(items);
            setError(null);
          },
          (err: Error) => setError(err.message),
        );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [picked, folder]);

  const add = (more: Picked[]) => {
    setResults(null);
    setPhase('pick');
    setPicked((current) => {
      const seen = new Set(current.map((p) => p.name));
      return [...current, ...more.filter((p) => !seen.has(p.name))];
    });
  };

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const entries = [...e.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => Boolean(entry));
    if (entries.length) {
      add((await Promise.all(entries.map((entry) => walk(entry)))).flat());
    } else {
      add([...e.dataTransfer.files].map((file) => ({ file, name: file.name })));
    }
  }

  function fromInput(files: FileList | null) {
    if (!files) return;
    add([...files].map((file) => ({ file, name: file.webkitRelativePath || file.name })));
  }

  function toggleReplace(path: string) {
    setReplace((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const importable =
    plan?.filter((p) => p.status === 'new' || (p.status === 'exists' && replace.has(p.path!))) ?? [];
  const counts = {
    created: plan?.filter((p) => p.status === 'new').length ?? 0,
    replaced: plan?.filter((p) => p.status === 'exists' && replace.has(p.path!)).length ?? 0,
  };
  const skipped = (plan?.length ?? 0) - counts.created - counts.replaced;

  async function startImport() {
    if (!plan) return;
    setPhase('importing');
    setError(null);
    const wanted = new Set(importable.map((p) => p.name));
    try {
      const done = await api.upload(
        folder,
        picked.filter((p) => wanted.has(p.name)),
        [...replace],
      );
      setResults(done);
      setPhase('done');
      onImported();
    } catch (err) {
      setError((err as Error).message);
      setPhase('pick');
    }
  }

  const imported = results?.filter((r) => r.status === 'created' || r.status === 'replaced') ?? [];
  const problems = results?.filter((r) => r.status === 'failed') ?? [];

  return (
    <div className="dialog-backdrop" onMouseDown={() => phase !== 'importing' && onClose()}>
      <div className="upload-dialog" role="dialog" aria-label="Upload files" onMouseDown={(e) => e.stopPropagation()}>
        <header className="upload-head">
          <h2>Upload</h2>
          <button className="icon-button" onClick={onClose} disabled={phase === 'importing'} aria-label="Close">
            ✕
          </button>
        </header>

        {phase !== 'done' && (
          <>
            <div
              className={`drop-zone ${dragging ? 'dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <p>
                <strong>Drop files or folders here</strong>
              </p>
              <p className="muted">Markdown, text, Word (.docx), HTML, and PDF. Folders keep their structure.</p>
              <div className="actions">
                <button onClick={() => fileInput.current?.click()}>Choose files</button>
                <button onClick={() => folderInput.current?.click()}>Choose folder</button>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  fromInput(e.target.files);
                  e.target.value = '';
                }}
              />
              <input
                ref={folderInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  fromInput(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            <label className="upload-folder">
              Put pages in folder
              <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Top level" />
            </label>

            {plan && (
              <div className="upload-plan">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Page</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.map((item) => (
                      <tr key={item.name} className={item.status === 'new' || item.status === 'exists' ? '' : 'skip'}>
                        <td className="file-name" title={item.name}>
                          {item.name}
                        </td>
                        <td className="page-path" title={item.path}>
                          {item.path ?? '—'}
                        </td>
                        <td>
                          {item.status === 'exists' ? (
                            <label className="replace">
                              <input
                                type="checkbox"
                                checked={replace.has(item.path!)}
                                onChange={() => toggleReplace(item.path!)}
                              />
                              Replace existing
                            </label>
                          ) : (
                            <span className={`pill ${item.status}`} title={item.message}>
                              {STATUS_LABEL[item.status]}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {error && <p className="down">{error}</p>}

            <footer className="upload-foot">
              <span className="muted">
                {plan
                  ? `${counts.created} new, ${counts.replaced} to replace, ${skipped} skipped`
                  : 'Nothing selected yet.'}
              </span>
              {picked.length > 0 && phase === 'pick' && (
                <button
                  onClick={() => {
                    setPicked([]);
                    setReplace(new Set());
                  }}
                >
                  Clear
                </button>
              )}
              <button
                className="primary"
                onClick={startImport}
                disabled={phase === 'importing' || importable.length === 0}
              >
                {phase === 'importing'
                  ? 'Importing…'
                  : `Import ${importable.length} ${importable.length === 1 ? 'page' : 'pages'}`}
              </button>
            </footer>
          </>
        )}

        {phase === 'done' && results && (
          <div className="upload-results">
            <p>
              <strong className="up">
                Imported {imported.length} {imported.length === 1 ? 'page' : 'pages'}.
              </strong>{' '}
              {problems.length > 0 && <span className="down">{problems.length} failed.</span>}
            </p>
            <ul>
              {results
                .filter((r) => r.status !== 'skipped')
                .map((r) => (
                  <li key={r.name}>
                    {r.path && r.status !== 'failed' ? (
                      <a href={href({ view: 'page', path: r.path })} onClick={onClose}>
                        {r.path}
                      </a>
                    ) : (
                      <span>{r.name}</span>
                    )}{' '}
                    <span className={r.status === 'failed' ? 'down' : 'muted'}>
                      {r.status === 'replaced' ? 'replaced' : r.status === 'failed' ? r.message : ''}
                      {r.notes?.length ? ` · ${r.notes.join(' ')}` : ''}
                    </span>
                  </li>
                ))}
            </ul>
            <footer className="upload-foot">
              <button
                onClick={() => {
                  setPicked([]);
                  setReplace(new Set());
                  setResults(null);
                  setPhase('pick');
                }}
              >
                Upload more
              </button>
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
