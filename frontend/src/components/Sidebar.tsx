import { useState } from 'react';
import type { EntrySummary, User } from '../api';
import { logout } from '../auth';
import { href, type Route } from '../route';

interface Folder {
  folders: Map<string, Folder>;
  pages: { name: string; path: string }[];
}

function buildTree(entries: EntrySummary[]): Folder {
  const root: Folder = { folders: new Map(), pages: [] };
  for (const { path } of entries) {
    const parts = path.split('/');
    const name = parts.pop()!;
    let folder = root;
    for (const part of parts) {
      if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), pages: [] });
      folder = folder.folders.get(part)!;
    }
    folder.pages.push({ name, path });
  }
  return root;
}

interface TreeProps {
  folder: Folder;
  prefix: string;
  depth: number;
  selected?: string;
  onNewPage: (folder: string) => void;
}

function FolderRow({ name, folder, prefix, depth, selected, onNewPage }: TreeProps & { name: string }) {
  const path = prefix ? `${prefix}/${name}` : name;
  const [open, setOpen] = useState(true);
  return (
    <li>
      <div className="row" style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}>
        <button
          className="row-main"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
        >
          <span className={`chevron ${open ? 'open' : ''}`}>›</span>
          <span className="row-label">{name}</span>
        </button>
        <button className="row-action" onClick={() => onNewPage(path)} title={`New page in ${name}`}>
          +
        </button>
      </div>
      {open && (
        <Tree folder={folder} prefix={path} depth={depth + 1} selected={selected} onNewPage={onNewPage} />
      )}
    </li>
  );
}

function Tree({ folder, prefix, depth, selected, onNewPage }: TreeProps) {
  return (
    <ul>
      {[...folder.folders].map(([name, child]) => (
        <FolderRow
          key={`folder:${name}`}
          name={name}
          folder={child}
          prefix={prefix}
          depth={depth}
          selected={selected}
          onNewPage={onNewPage}
        />
      ))}
      {folder.pages.map((p) => (
        <li key={p.path}>
          <a
            className="row row-main"
            href={href({ view: 'page', path: p.path })}
            aria-current={p.path === selected ? 'page' : undefined}
            style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
          >
            <span className="page-icon">▤</span>
            <span className="row-label">{p.name}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  user: User | null;
  entries: EntrySummary[];
  route: Route;
  onNewPage: (folder: string) => void;
  onSearch: () => void;
  onUpload: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Sidebar({ user, entries, route, onNewPage, onSearch, onUpload }: Props) {
  const selected = route.view === 'page' ? route.path : undefined;
  return (
    <aside className="sidebar">
      <div className="workspace">
        <span className="workspace-icon">p</span>
        <div className="workspace-text">
          <strong>pont</strong>
          {user && <span className="muted">{user.name ?? user.username}</span>}
        </div>
      </div>

      <nav className="nav">
        <button className="row row-main" onClick={onSearch}>
          <span className="page-icon">⌕</span>
          <span className="row-label">Search</span>
          <kbd className="shortcut">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <a className="row row-main" href={href({ view: 'home' })} aria-current={route.view === 'home' ? 'page' : undefined}>
          <span className="page-icon">⌂</span>
          <span className="row-label">Home</span>
        </a>
        <a
          className="row row-main"
          href={href({ view: 'ontology' })}
          aria-current={route.view === 'ontology' ? 'page' : undefined}
        >
          <span className="page-icon">◇</span>
          <span className="row-label">Ontology</span>
        </a>
        <a
          className="row row-main"
          href={href({ view: 'trivia' })}
          aria-current={route.view === 'trivia' ? 'page' : undefined}
        >
          <span className="page-icon">?</span>
          <span className="row-label">Trivia</span>
        </a>
        <a
          className="row row-main"
          href={href({ view: 'tokens' })}
          aria-current={route.view === 'tokens' ? 'page' : undefined}
        >
          <span className="page-icon">⚿</span>
          <span className="row-label">API tokens</span>
        </a>
        <a
          className="row row-main"
          href={href({ view: 'settings' })}
          aria-current={route.view === 'settings' ? 'page' : undefined}
        >
          <span className="page-icon">⚙</span>
          <span className="row-label">Settings</span>
        </a>
      </nav>

      <div className="section-label">
        <span>Pages</span>
        <button className="row-action visible" onClick={() => onNewPage('')} title="New page">
          +
        </button>
      </div>
      <nav className="tree">
        {entries.length === 0 ? (
          <p className="muted empty">No pages yet</p>
        ) : (
          <Tree folder={buildTree(entries)} prefix="" depth={0} selected={selected} onNewPage={onNewPage} />
        )}
      </nav>

      <div className="sidebar-footer">
        <button className="row row-main" onClick={() => onNewPage('')}>
          <span className="page-icon">+</span>
          <span className="row-label">New page</span>
        </button>
        <button className="row row-main" onClick={onUpload}>
          <span className="page-icon">⇪</span>
          <span className="row-label">Upload</span>
        </button>
        <button className="row row-main" onClick={() => logout()}>
          <span className="page-icon">⇥</span>
          <span className="row-label">Sign out</span>
        </button>
      </div>
    </aside>
  );
}
