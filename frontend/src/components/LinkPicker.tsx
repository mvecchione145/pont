import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { api, CONCEPT_TYPES, type OntologyHit } from '../api';

// The ontology autocomplete used when linking text: a floating table of
// matching concepts and relationships (Ontology | Type | Description), plus
// "Create concept" when nothing matches exactly.

export interface PickerKeys {
  // Returns true when the picker handled the key.
  key: (key: string) => boolean;
}

export interface Picked {
  kind: 'concept' | 'relation';
  id: string;
  name: string;
}

interface Props {
  ref?: Ref<PickerKeys>;
  // "trigger": the query is typed in the editor after [[ (keys are forwarded
  // here). "search": the picker has its own search box.
  mode: 'trigger' | 'search';
  query: string;
  x: number;
  y: number;
  onPick: (picked: Picked) => void;
  onClose: () => void;
}

type Row = { hit: OntologyHit } | { create: string };

export function LinkPicker({ ref, mode, query, x, y, onPick, onClose }: Props) {
  const [search, setSearch] = useState(query);
  const [hits, setHits] = useState<OntologyHit[]>([]);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState<string | null>(null);
  const [type, setType] = useState<string>('Term');
  const [definition, setDefinition] = useState('');
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const q = mode === 'trigger' ? query : search;

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.searchOntology(q).then(
        (h) => {
          if (cancelled) return;
          setHits(h);
          setActive(0);
        },
        () => !cancelled && setHits([]),
      );
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q]);

  const exact = hits.some((h) => h.name.toLowerCase() === q.trim().toLowerCase());
  const rows: Row[] = [...hits.map((hit) => ({ hit })), ...(q.trim() && !exact ? [{ create: q.trim() }] : [])];

  function choose(row: Row | undefined) {
    if (!row) return;
    if ('hit' in row) onPick({ kind: row.hit.kind, id: row.hit.id, name: row.hit.name });
    else {
      setCreating(row.create);
      setError(null);
    }
  }

  useImperativeHandle(ref, () => ({
    key(key: string) {
      if (creating) return false;
      if (key === 'ArrowDown') setActive((i) => Math.min(i + 1, rows.length - 1));
      else if (key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
      else if (key === 'Enter' || key === 'Tab') {
        if (!rows.length) return false;
        choose(rows[active]);
      } else if (key === 'Escape') onClose();
      else return false;
      return true;
    },
  }));

  // Close when clicking outside.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  // Keep the box on screen.
  const left = Math.max(8, Math.min(x, window.innerWidth - Math.min(560, window.innerWidth - 16) - 8));
  const below = y + 8 + 320 < window.innerHeight;
  const style = below ? { left, top: y + 8 } : { left, bottom: window.innerHeight - y + 28 };

  async function create() {
    if (!creating) return;
    try {
      const c = await api.createConcept({ name: creating, type, definition });
      onPick({ kind: 'concept', id: c.id, name: c.name });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="link-picker" ref={boxRef} style={style} role="dialog" aria-label="Link to the ontology">
      {mode === 'search' && !creating && (
        <input
          className="link-picker-search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search concepts and relationships…"
          onKeyDown={(e) => {
            const handled =
              e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab';
            if (!handled) return;
            e.preventDefault();
            if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, rows.length - 1));
            else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
            else if (e.key === 'Escape') onClose();
            else choose(rows[active]);
          }}
        />
      )}

      {creating ? (
        <form
          className="link-picker-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <strong>New concept: {creating}</strong>
          <div className="row-fields">
            <select value={type} onChange={(e) => setType(e.target.value)} autoFocus>
              {CONCEPT_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <input value={definition} onChange={(e) => setDefinition(e.target.value)} placeholder="Definition (optional)" />
          </div>
          {error && <p className="down">{error}</p>}
          <div className="actions">
            <button type="submit" className="primary">
              Create and link
            </button>
            <button type="button" onClick={() => setCreating(null)}>
              Back
            </button>
          </div>
        </form>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Ontology</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={'hit' in row ? `${row.hit.kind}:${row.hit.id}` : 'create'}
                  className={i === active ? 'active' : undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(row);
                  }}
                >
                  {'hit' in row ? (
                    <>
                      <td className="name">{row.hit.name}</td>
                      <td>
                        <span className={`pill ${row.hit.kind}`}>{row.hit.kind === 'concept' ? row.hit.type : 'Relationship'}</span>
                      </td>
                      <td className="muted desc">{row.hit.description}</td>
                    </>
                  ) : (
                    <td colSpan={3} className="create">
                      ＋ Create concept “{row.create}”
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="muted empty">Type to search the ontology.</p>}
          <p className="muted foot">↑↓ choose · ↵ link · esc close · ⌘-click a link to open it</p>
        </>
      )}
    </div>
  );
}
