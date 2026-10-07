import { useEffect, useState } from 'react';
import { api, type Entry } from '../api';
import { href, navigate } from '../route';
import { Markdown } from './Markdown';

interface Props {
  path: string;
  onDeleted: () => void;
}

export function EntryView({ path, onDeleted }: Props) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setEntry(null);
    setError(null);
    setConfirming(false);
    api.getEntry(path).then(setEntry, (err: Error) => setError(err.message));
  }, [path]);

  async function remove() {
    try {
      await api.deleteEntry(path);
      onDeleted();
      navigate({ view: 'home' });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error) return <p className="down">{error}</p>;
  if (!entry) return <p className="muted">Loading…</p>;

  return (
    <article>
      <div className="entry-header">
        <div>
          <p className="entry-path">{entry.path}</p>
          <p className="muted">
            Last edited
            {entry.author && <> by {entry.author.name}</>}
            {entry.lastModified && <> on {new Date(entry.lastModified).toLocaleString()}</>}
          </p>
        </div>
        <div className="actions">
          <a className="button" href={href({ view: 'edit', path })}>
            Edit
          </a>
          {confirming ? (
            <>
              <button className="danger" onClick={remove}>
                Confirm delete
              </button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirming(true)}>Delete</button>
          )}
        </div>
      </div>
      {entry.content.trim() ? (
        <Markdown>{entry.content}</Markdown>
      ) : (
        <p className="muted">This entry is empty.</p>
      )}
    </article>
  );
}
