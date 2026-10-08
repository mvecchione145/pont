import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type EntrySummary, type User } from './api';
import { folderOf, navigate, useRoute } from './route';
import { Sidebar } from './components/Sidebar';
import { Page } from './components/Page';
import { Home } from './components/Home';
import { Tokens } from './components/Tokens';
import { SearchDialog } from './components/SearchDialog';
import { Trivia } from './components/Trivia';
import { Settings } from './components/Settings';
import { UploadDialog } from './components/UploadDialog';
import { OntologyPage } from './components/OntologyPage';
import { ProposalsPage } from './components/ProposalsPage';

export default function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null>(null);
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  // Pending agent proposals per page path (sidebar badge, page banners).
  const [proposalCounts, setProposalCounts] = useState<Record<string, number>>({});
  const refreshProposalCounts = useCallback(() => {
    api.proposalCounts().then(setProposalCounts, () => undefined);
  }, []);
  useEffect(() => {
    refreshProposalCounts();
    const timer = window.setInterval(refreshProposalCounts, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshProposalCounts]);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Cmd+K / Ctrl+K opens search from anywhere, like Notion.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
      <Sidebar
        user={user}
        entries={entries}
        route={route}
        onNewPage={newPage}
        onSearch={() => setSearchOpen(true)}
        onUpload={() => setUploadOpen(true)}
        pendingProposals={Object.values(proposalCounts).reduce((a, b) => a + b, 0)}
      />
      <main className="main">
        {error && (
          <div className="banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}
        {route.view === 'home' && <Home entries={entries} onNewPage={() => newPage('')} />}
        {route.view === 'trivia' && (
          <div className="page wide">
            <Trivia user={user} />
          </div>
        )}
        {route.view === 'proposals' && (
          <div className="page wide">
            <ProposalsPage
              pathFilter={route.path}
              onChanged={() => {
                refreshProposalCounts();
                refreshEntries();
              }}
            />
          </div>
        )}
        {route.view === 'ontology' && (
          <div className="page wide">
            <OntologyPage />
          </div>
        )}
        {route.view === 'settings' && (
          <div className="page">
            <Settings />
          </div>
        )}
        {route.view === 'tokens' && (
          <div className="page">
            <Tokens />
          </div>
        )}
        {route.view === 'page' && (
          <Page
            key={pageKey(route.path)}
            path={route.path}
            section={route.section}
            isNew={justCreated === route.path}
            onChanged={refreshEntries}
            onRenamed={renamed}
            pendingProposals={proposalCounts[route.path] ?? 0}
          />
        )}
      </main>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
      {uploadOpen && (
        <UploadDialog
          defaultFolder={route.view === 'page' ? folderOf(route.path) : ''}
          onClose={() => setUploadOpen(false)}
          onImported={refreshEntries}
        />
      )}
    </div>
  );
}
