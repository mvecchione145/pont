import type { EntrySummary } from '../api';
import { href } from '../route';

interface Folder {
  folders: Map<string, Folder>;
  entries: { name: string; path: string }[];
}

function buildTree(entries: EntrySummary[]): Folder {
  const root: Folder = { folders: new Map(), entries: [] };
  for (const { path } of entries) {
    const parts = path.split('/');
    const name = parts.pop()!;
    let folder = root;
    for (const part of parts) {
      if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), entries: [] });
      folder = folder.folders.get(part)!;
    }
    folder.entries.push({ name, path });
  }
  return root;
}

function FolderView({ folder, selected }: { folder: Folder; selected?: string }) {
  return (
    <ul>
      {[...folder.folders].map(([name, child]) => (
        <li key={`folder:${name}`}>
          <details open>
            <summary>{name}</summary>
            <FolderView folder={child} selected={selected} />
          </details>
        </li>
      ))}
      {folder.entries.map((e) => (
        <li key={e.path}>
          <a href={href({ view: 'entry', path: e.path })} aria-current={e.path === selected}>
            {e.name}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function EntryTree({ entries, selected }: { entries: EntrySummary[]; selected?: string }) {
  if (entries.length === 0) return <p className="muted">No entries yet.</p>;
  return (
    <nav className="tree">
      <FolderView folder={buildTree(entries)} selected={selected} />
    </nav>
  );
}
