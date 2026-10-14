import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type SearchResult } from '../api';
import { folderOf, navigate } from '../route';

const DEBOUNCE_MS = 200;
const SNIPPET_LENGTH = 160;

interface PageHit {
  path: string;
  title: string;
  headings: string;
  snippet: string;
}

// Plain-text preview of a chunk: Markdown symbols stripped, whitespace
// collapsed, and cut near the first word of the query when it appears.
function snippet(content: string, query: string): string {
  const text = content
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/[#>*_`|~[\]()!]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const word = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/u)?.[0];
  const at = word ? text.toLowerCase().indexOf(word) : -1;
  const start = at > 60 ? at - 40 : 0;
  const cut = text.slice(start, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${cut}${start + SNIPPET_LENGTH < text.length ? '…' : ''}`;
}

// One row per page, showing its best-matching passage.
function byPage(results: SearchResult[], query: string): PageHit[] {
  const pages = new Map<string, PageHit>();
  for (const r of results) {
    if (pages.has(r.path)) continue;
    pages.set(r.path, { path: r.path, title: r.title, headings: r.headings, snippet: snippet(r.content, query) });
  }
  return [...pages.values()];
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PageHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [state, setState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setState('idle');
      return;
    }
    setState('searching');
    const id = ++latest.current;
    const timer = window.setTimeout(() => {
      api.search(q).then(
        (results) => {
          if (id !== latest.current) return;
          setHits(byPage(results, q));
          setSelected(0);
          setState('done');
        },
        (err: Error) => {
          if (id !== latest.current) return;
          setMessage(err instanceof ApiError && err.status === 503 ? 'Search is still starting up. Try again in a moment.' : err.message);
          setState('error');
        },
      );
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  function open(hit: PageHit | undefined) {
    if (!hit) return;
    onClose();
    navigate({ view: 'page', path: hit.path });
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(hits[selected]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="search-dialog"
        role="dialog"
        aria-label="Search pages"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="search-input-row">
          <span className="search-icon" aria-hidden>
            ⌕
          </span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search pages by meaning or exact terms…"
            aria-label="Search"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="search-results"
          />
          {state === 'searching' && <span className="muted search-spinner">…</span>}
        </div>

        <ul className="search-results" id="search-results" role="listbox">
          {hits.map((hit, i) => (
            <li
              key={hit.path}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? 'selected' : undefined}
              onMouseEnter={() => setSelected(i)}
              onClick={() => open(hit)}
            >
              <div className="result-title">
                <span className="page-icon">▤</span>
                <strong>{hit.title}</strong>
                {folderOf(hit.path) && <span className="muted"> · {folderOf(hit.path)}</span>}
              </div>
              {hit.headings && <div className="result-heading muted">{hit.headings}</div>}
              {hit.snippet && <div className="result-snippet">{hit.snippet}</div>}
            </li>
          ))}
        </ul>

        {state === 'done' && hits.length === 0 && (
          <p className="search-empty muted">No pages match “{query.trim()}”.</p>
        )}
        {state === 'error' && <p className="search-empty down">{message}</p>}
        {state === 'idle' && (
          <p className="search-empty muted">
            Ask in plain language (“how do we define an active user?”) or search for an exact term
            (“NRR”, “SEV2”).
          </p>
        )}

        <div className="search-footer muted">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
