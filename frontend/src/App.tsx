import { useCallback, useEffect, useState } from 'react';
import { api, type EntrySummary, type User } from './api';
import { logout } from './auth';
import { href, useRoute } from './route';
import { EntryTree } from './components/EntryTree';
import { EntryView } from './components/EntryView';
import { EntryEditor } from './components/EntryEditor';
import { Home } from './components/Home';
import { Tokens } from './components/Tokens';

export default function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null>(null);
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshEntries = useCallback(() => {
    api.listEntries().then(setEntries, (err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    api.me().then(setUser, (err: Error) => setError(err.message));
    refreshEntries();
  }, [refreshEntries]);

  const selected = route.view === 'entry' || route.view === 'edit' ? route.path : undefined;
  const folder = selected?.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '';

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href({ view: 'home' })}>
          pont
        </a>
        {user && (
          <div className="account">
            <a href={href({ view: 'tokens' })}>API tokens</a>
            <span>{user.name ?? user.username}</span>
            <button onClick={() => logout()}>Sign out</button>
          </div>
        )}
      </header>

      <div className="layout">
        <aside className="sidebar">
          <a className="button primary new-entry" href={href({ view: 'new', folder })}>
            New entry
          </a>
          <EntryTree entries={entries} selected={selected} />
        </aside>

        <main className="content">
          {error && <p className="down">{error}</p>}
          {route.view === 'home' && <Home entryCount={entries.length} />}
          {route.view === 'tokens' && <Tokens />}
          {route.view === 'entry' && <EntryView path={route.path} onDeleted={refreshEntries} />}
          {route.view === 'edit' && (
            <EntryEditor key={route.path} mode="edit" path={route.path} onSaved={refreshEntries} />
          )}
          {route.view === 'new' && (
            <EntryEditor key={`new:${route.folder}`} mode="new" folder={route.folder} onSaved={refreshEntries} />
          )}
        </main>
      </div>
    </div>
  );
}
