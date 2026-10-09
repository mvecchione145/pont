import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { api, CONCEPT_TYPES, type LinkTarget, type OntologyHit } from '../api';
import { href, nameOf } from '../route';

// The autocomplete used when linking text: a floating table (Link to | Type |
// Description) of matching ontology concepts and relationships, pages, and
// headings, plus "Create concept" when nothing matches exactly. A query with
// "#" links to a heading: "#escal" on this page, "onboarding#escal" on
// another page.

export interface PickerKeys {
  // Returns true when the picker handled the key.
  key: (key: string) => boolean;
}

export interface Picked {
  // The link target, e.g. "#/concept/appy" or "#/p/processes/onboarding?section=Escalation".
  href: string;
  // Text for a new link.
  name: string;
}

interface Props {
  ref?: Ref<PickerKeys>;
  // "trigger": the query is typed in the editor after [[ (keys are forwarded
  // here). "search": the picker has its own search box.
  mode: 'trigger' | 'search';
  query: string;
  // The page being edited, for links to its own headings.
  fromPath: string;
  x: number;
  y: number;
  onPick: (picked: Picked) => void;
  onClose: () => void;
}

type Row = { hit: OntologyHit } | { target: LinkTarget } | { create: string };

const ONTOLOGY_ROWS = 6;
const PAGE_ROWS = 8;

const rowKey = (row: Row) =>
  'hit' in row ? `${row.hit.kind}:${row.hit.id}` : 'target' in row ? `${row.target.kind}:${row.target.path}#${row.target.name}` : 'create';
const rowName = (row: Row) => ('hit' in row ? row.hit.name : 'target' in row ? row.target.name : row.create);

export function LinkPicker({ ref, mode, query, fromPath, x, y, onPick, onClose }: Props) {
  const [search, setSearch] = useState(query);
  const [hits, setHits] = useState<OntologyHit[]>([]);
  const [targets, setTargets] = useState<LinkTarget[]>([]);
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
      // "#" means a heading, so the ontology isn't searched.
      const ontology = q.includes('#') ? Promise.resolve([]) : api.searchOntology(q).catch(() => []);
      const pages = api.searchLinkTargets(q, fromPath).catch(() => []);
      void Promise.all([ontology, pages]).then(([h, t]) => {
        if (cancelled) return;
        setHits(h.slice(0, ONTOLOGY_ROWS));
        setTargets(t.slice(0, PAGE_ROWS));
        setActive(0);
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, fromPath]);

  const wanted = q.trim().toLowerCase();
  const found: Row[] = [...hits.map((hit) => ({ hit })), ...targets.map((target) => ({ target }))];
  // Exact name matches first, whatever kind they are.
  const isExact = (row: Row) => rowName(row).toLowerCase() === wanted;
  const exact = found.some(isExact);
  const rows: Row[] = [
    ...found.filter(isExact),
    ...found.filter((row) => !isExact(row)),
    ...(wanted && !exact && !wanted.includes('#') ? [{ create: q.trim() }] : []),
  ];

  function choose(row: Row | undefined) {
    if (!row) return;
    if ('hit' in row) onPick({ href: href({ view: row.hit.kind, id: row.hit.id }), name: row.hit.name });
    else if ('target' in row) {
      const t = row.target;
      onPick({ href: href({ view: 'page', path: t.path, section: t.kind === 'section' ? t.name : undefined }), name: t.name });
    } else {
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
      onPick({ href: href({ view: 'concept', id: c.id }), name: c.name });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="link-picker" ref={boxRef} style={style} role="dialog" aria-label="Link to a page, heading, or concept">
      {mode === 'search' && !creating && (
        <input
          className="link-picker-search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search pages, headings (#), and concepts…"
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
                <th>Link to</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={rowKey(row)}
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
                  ) : 'target' in row ? (
                    <>
                      <td className="name">
                        {row.target.kind === 'section' && <span className="muted"># </span>}
                        {row.target.name}
                      </td>
                      <td>
                        <span className={`pill ${row.target.kind}`}>{row.target.kind === 'page' ? 'Page' : 'Heading'}</span>
                      </td>
                      <td className="muted desc">
                        {row.target.kind === 'page'
                          ? row.target.path.includes('/')
                            ? `in ${row.target.path.slice(0, row.target.path.lastIndexOf('/'))}`
                            : 'top level'
                          : [row.target.path === fromPath ? 'this page' : nameOf(row.target.path), row.target.trail]
                              .filter(Boolean)
                              .join(' › ')}
                      </td>
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
          {rows.length === 0 && (
            <p className="muted empty">{q.includes('#') ? 'No matching headings.' : 'Type to search pages, headings, and concepts.'}</p>
          )}
          <p className="muted foot">↑↓ choose · ↵ link · # for headings · esc close · ⌘-click a link to open it</p>
        </>
      )}
    </div>
  );
}
