import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type EntrySummary, type User } from './api';
import { navigate, useRoute } from './route';
import { Sidebar } from './components/Sidebar';
import { Page } from './components/Page';
import { Home } from './components/Home';
import { Tokens } from './components/Tokens';

export default function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null>(null);
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // React keys for pages: a unique ID per path, assigned on first view. A
  // renamed page carries its ID to the new path, so it stays mounted (and keeps
  // its editor state) while the URL changes. IDs are never reused, so a new
  // page at a freed-up path (say "Untitled") always mounts fresh.
  const pageKeys = useRef(new Map<string, string>());
  const nextKey = useRef(0);
  const pageKey = (path: string) => {
    let key = pageKeys.current.get(path);
    if (!key) {
      key = `page-${++nextKey.current}`;
      pageKeys.current.set(path, key);
    }
    return key;
  };

  const renamed = useCallback(
    (from: string, to: string) => {
      pageKeys.current.set(to, pageKey(from));
      pageKeys.current.delete(from);
      setJustCreated(null);
      refreshEntries();
      navigate({ view: 'page', path: to });
    },
    // refreshEntries is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const refreshEntries = useCallback(() => {
    api.listEntries().then(setEntries, (err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    api.me().then(setUser, (err: Error) => setError(err.message));
    refreshEntries();
  }, [refreshEntries]);

  // Like Notion: a new page exists immediately, opened with its title selected.
  const newPage = useCallback(
    async (folder: string) => {
      try {
        const entry = await api.createUntitled(folder);
        setJustCreated(entry.path);
        refreshEntries();
        navigate({ view: 'page', path: entry.path });
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshEntries],
  );

  return (
    <div className="app">
      <Sidebar user={user} entries={entries} route={route} onNewPage={newPage} />
      <main className="main">
        {error && (
          <div className="banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}
        {route.view === 'home' && <Home entries={entries} onNewPage={() => newPage('')} />}
        {route.view === 'tokens' && (
          <div className="page">
            <Tokens />
          </div>
        )}
        {route.view === 'page' && (
          <Page
            key={pageKey(route.path)}
            path={route.path}
            isNew={justCreated === route.path}
            onChanged={refreshEntries}
            onRenamed={renamed}
          />
        )}
      </main>
    </div>
  );
}
