import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { href, navigate } from '../route';
import { Markdown } from './Markdown';

type Props =
  | { mode: 'new'; folder: string; onSaved: () => void }
  | { mode: 'edit'; path: string; onSaved: () => void };

export function EntryEditor(props: Props) {
  const isNew = props.mode === 'new';
  const [path, setPath] = useState(isNew ? (props.folder ? `${props.folder}/` : '') : props.path);
  const [content, setContent] = useState('');
  // The version this edit started from; null for a new entry.
  const [baseVersionId, setBaseVersionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editPath = isNew ? null : props.path;
  useEffect(() => {
    if (editPath === null) return;
    api.getEntry(editPath).then(
      (entry) => {
        setContent(entry.content);
        setBaseVersionId(entry.versionId ?? null);
        setLoading(false);
      },
      (err: Error) => setError(err.message),
    );
  }, [editPath]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveEntry(path.trim().replace(/\/+$/, ''), content, baseVersionId);
      props.onSaved();
      navigate({ view: 'entry', path: saved.path });
    } catch (err) {
      const message = (err as Error).message;
      setError(
        err instanceof ApiError && err.status === 409 && !isNew
          ? `${message}. Copy your changes, then reload the entry to see the latest version.`
          : message,
      );
      setSaving(false);
    }
  }

  if (loading) return error ? <p className="down">{error}</p> : <p className="muted">Loading…</p>;

  const cancel = isNew ? href({ view: 'home' }) : href({ view: 'entry', path: props.path });

  return (
    <form className="editor" onSubmit={save}>
      <label>
        Path
        {isNew ? (
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="processes/onboarding"
            required
            autoFocus
          />
        ) : (
          <span className="entry-path">{path}</span>
        )}
      </label>
      {isNew && <p className="muted hint">Use "/" to put the entry in a folder.</p>}

      <div className="editor-panes">
        <label>
          Markdown
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={'# Title\n\nWrite what you know…'}
            autoFocus={!isNew}
          />
        </label>
        <div>
          <span className="pane-label">Preview</span>
          <div className="preview">
            {content.trim() ? <Markdown>{content}</Markdown> : <p className="muted">Nothing to preview yet.</p>}
          </div>
        </div>
      </div>

      {error && <p className="down">{error}</p>}

      <div className="actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <a className="button" href={cancel}>
          Cancel
        </a>
      </div>
    </form>
  );
}
