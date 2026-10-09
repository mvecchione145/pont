import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api, ApiError, type Entry, type GithubPage } from '../api';
import { folderOf, href, nameOf, navigate } from '../route';
import { ReviewPanel } from './ReviewPanel';
import { GithubBar, PublishDialog, pullLabel, readDraft, writeDraft } from './GithubPage';
// The editor (with CodeMirror for code blocks) is large, so load it on demand.
const Editor = lazy(() => import('./Editor').then((m) => ({ default: m.Editor })));
type EditorHandle = import('./Editor').EditorHandle;

const AUTOSAVE_DELAY_MS = 700;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;

type SaveState = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error';

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function validName(name: string): string | null {
  if (!name) return 'A page needs a name.';
  if (name.includes('/')) return 'Use "Move to folder" in the ⋯ menu to change the folder.';
  if (!NAME.test(name) || name.endsWith('.')) {
    return 'Names can use letters, digits, spaces, "-", "_" and ".", and must start with a letter or digit.';
  }
  return null;
}

interface Props {
  path: string;
  // The heading to scroll to (from a link to a section, or trivia's "Fact check").
  section?: string;
  // Arriving from trivia's "Fact check" (or a review conflict): ask the reader
  // to fix what's wrong.
  factCheck: boolean;
  isNew: boolean;
  onChanged: () => void;
  // Called after a rename or move. The parent keeps this same Page mounted
  // while the URL changes to the new path.
  onRenamed: (from: string, to: string) => void;
  // Agent proposals waiting for review for this page.
  pendingProposals: number;
}

export function Page({ path, section, factCheck: arrivedToCheck, isNew, onChanged, onRenamed, pendingProposals }: Props) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [title, setTitle] = useState(nameOf(path));
  const [titleError, setTitleError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [factCheck, setFactCheck] = useState(arrivedToCheck);
  const [reviewing, setReviewing] = useState(false);
  // Set for pages linked to a file on GitHub: no autosave; edits are a draft
  // until published as a pull request.
  const [github, setGithub] = useState<GithubPage | null>(null);
  const githubRef = useRef<GithubPage | null>(null);
  githubRef.current = github;
  const [draft, setDraft] = useState(false);
  // The draft started from an older version of the file than GitHub's.
  const [staleDraft, setStaleDraft] = useState(false);
  // GitHub has a newer version than the one loaded (found by polling).
  const [remoteChanged, setRemoteChanged] = useState(false);
  // A pull request status change noticed while the page was open.
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  // SHA of the GitHub version loaded into the editor, and of the version the
  // current edits started from (sent with Publish, so a newer GitHub version
  // isn't overwritten by accident).
  const loadedSha = useRef<string | null>(null);
  const editBaseSha = useRef<string | null>(null);
  // Remounts the editor with new content without reloading the page (used
  // when a review suggestion is applied to the draft).
  const [editorVersion, setEditorVersion] = useState(0);
  const [publishing, setPublishing] = useState(false);

  // Autosave bookkeeping lives in refs so the editor's change handler never
  // goes stale. pathRef is the page's current path: a rename changes it in
  // place, without remounting the editor, so nothing typed meanwhile is lost.
  const pathRef = useRef(path);
  const version = useRef<string | null>(null);
  const latest = useRef('');
  const saved = useRef('');
  const inFlight = useRef<Promise<void> | null>(null);
  const moveInFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const blocked = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorHandle>(null);

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setLoadError(null);
    const at = pathRef.current;
    Promise.all([api.getEntry(at), api.githubPage(at).catch(() => null)]).then(
      ([e, gh]) => {
        if (cancelled) return;
        version.current = e.versionId ?? null;
        blocked.current = false;
        setSaveState('saved');
        setSaveError(null);
        setGithub(gh);
        if (gh) {
          // Start from the GitHub version (or the open pull request's), plus
          // any unpublished draft kept in this browser.
          const kept = readDraft(at);
          const restored = kept !== null && kept.content !== gh.content;
          const content = restored ? kept.content : gh.content;
          saved.current = gh.content;
          latest.current = content;
          loadedSha.current = gh.sha;
          editBaseSha.current = restored ? (kept.sha ?? gh.sha) : gh.sha;
          setDraft(restored);
          setStaleDraft(Boolean(restored && kept.sha && gh.sha && kept.sha !== gh.sha));
          setRemoteChanged(false);
          setEntry({ ...e, content });
        } else {
          latest.current = saved.current = e.content;
          setDraft(false);
          setEntry(e);
        }
      },
      (err: Error) => !cancelled && setLoadError(err.message),
    );
    return () => {
      cancelled = true;
    };
  }, [reloadCount]);

  const flush = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    // GitHub-linked pages never autosave: Publish sends their changes.
    if (githubRef.current) return;
    // Saves wait for any rename, then go to the page's new path.
    while (inFlight.current || moveInFlight.current) {
      await (inFlight.current ?? moveInFlight.current);
    }
    if (blocked.current || latest.current === saved.current) return;

    const content = latest.current;
    setSaveState('saving');
    const request = api
      .saveEntry(pathRef.current, content, version.current)
      .then(
        (result) => {
          version.current = result.versionId ?? null;
          saved.current = content;
          setEntry((e) => e && { ...e, ...result, content: e.content });
          setSaveState(latest.current === content ? 'saved' : 'unsaved');
        },
        (err: Error) => {
          if (err instanceof ApiError && err.status === 409) {
            blocked.current = true;
            setSaveState('conflict');
          } else {
            setSaveState('error');
          }
          setSaveError(err.message);
        },
      )
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = request;
    await request;
    if (!blocked.current && latest.current !== saved.current) {
      timer.current = window.setTimeout(flush, AUTOSAVE_DELAY_MS);
    }
  }, []);

  const onEdit = useCallback(
    (markdown: string) => {
      latest.current = markdown;
      if (githubRef.current) {
        const dirty = markdown !== saved.current;
        setDraft(dirty);
        if (!dirty) editBaseSha.current = loadedSha.current;
        writeDraft(pathRef.current, dirty ? { content: markdown, sha: editBaseSha.current } : null);
        return;
      }
      if (blocked.current) return;
      setSaveState('unsaved');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  // Save on the way out (navigating to another page) and warn before closing
  // the tab with unsaved changes.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (latest.current !== saved.current && !blocked.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      void flush();
    };
  }, [flush]);

  useEffect(() => {
    if (arrivedToCheck) setFactCheck(true);
  }, [arrivedToCheck, section]);

  // Once the editor has rendered, scroll to the linked section (or the one a
  // trivia question came from) and highlight it briefly. The highlight is a
  // separate overlay: ProseMirror owns the editor's DOM and redraws any node
  // changed from outside, so a class added to the heading wouldn't survive.
  // Once per section: autosaves update "entry" and must not scroll back.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!section || !entry || scrolledTo.current === section) return;
    scrolledTo.current = section;
    // Up to 10s: on a cold load the editor bundle may still be downloading.
    let tries = 0;
    const timer = window.setInterval(() => {
      const headings = [...document.querySelectorAll<HTMLElement>('.editor-root .ProseMirror :is(h1, h2, h3, h4, h5, h6)')];
      const target = headings.find((h) => h.textContent?.trim() === section.trim());
      if (target || ++tries > 100) window.clearInterval(timer);
      if (!target) return;
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      const flash = document.createElement('div');
      flash.className = 'fact-check-flash';
      Object.assign(flash.style, {
        top: `${rect.top + window.scrollY - 6}px`,
        left: `${rect.left + window.scrollX - 10}px`,
        width: `${rect.width + 20}px`,
        height: `${rect.height + 12}px`,
      });
      document.body.appendChild(flash);
      window.setTimeout(() => flash.remove(), 2600);
    }, 100);
    return () => window.clearInterval(timer);
  }, [section, entry]);

  // A brand-new page opens with its title selected, once. (Later updates to
  // entry, like the rename that follows typing a title, must not steal focus.)
  const focusedNewTitle = useRef(false);
  useEffect(() => {
    if (isNew && entry && !focusedNewTitle.current) {
      focusedNewTitle.current = true;
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [isNew, entry]);

  // Renames or moves the page. Everything saved so far moves with it; edits
  // made while the move runs are saved to the new path afterwards.
  function moveTo(target: string) {
    const from = pathRef.current;
    const run = async () => {
      await flush();
      if (blocked.current || !version.current) return;
      try {
        const moved = await api.moveEntry(from, target, version.current);
        pathRef.current = moved.path;
        const kept = readDraft(from);
        if (kept) {
          writeDraft(moved.path, kept);
          writeDraft(from, null);
        }
        version.current = moved.versionId ?? null;
        setTitleError(null);
        // The move rewrote the page's links to itself (e.g. to its own
        // headings): show that version, or the next autosave would undo it.
        if (moved.content !== saved.current && latest.current === saved.current) {
          latest.current = saved.current = moved.content;
          setEntry(moved);
          setReloadCount((n) => n + 1);
        } else {
          setEntry((e) => e && { ...e, ...moved, content: e.content });
        }
        onRenamed(from, moved.path);
      } catch (err) {
        const message =
          err instanceof ApiError && err.status === 409 && !blocked.current
            ? `A page already exists at "${target}".`
            : (err as Error).message;
        setTitleError(message);
        setTitle(nameOf(from));
      }
    };
    const promise = run().finally(() => {
      moveInFlight.current = null;
      if (latest.current !== saved.current) void flush();
    });
    moveInFlight.current = promise;
  }

  function commitTitle() {
    const name = title.trim();
    if (name === nameOf(pathRef.current)) {
      setTitleError(null);
      return;
    }
    const problem = validName(name);
    if (problem) {
      setTitleError(problem);
      return;
    }
    setTitleError(null);
    const folder = folderOf(pathRef.current);
    moveTo(folder ? `${folder}/${name}` : name);
  }

  function onTitleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      editorRef.current?.focusStart();
    } else if (e.key === 'Escape') {
      setTitle(nameOf(pathRef.current));
      setTitleError(null);
      e.currentTarget.blur();
    }
  }

  function submitMove(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const folder = String(new FormData(e.currentTarget).get('folder') ?? '')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    setMoving(false);
    const name = nameOf(pathRef.current);
    if (folder !== folderOf(pathRef.current)) moveTo(folder ? `${folder}/${name}` : name);
  }

  async function remove() {
    window.clearTimeout(timer.current);
    blocked.current = true;
    try {
      await moveInFlight.current;
      await api.deleteEntry(pathRef.current);
      onChanged();
      navigate({ view: 'home' });
    } catch (err) {
      blocked.current = false;
      setSaveError((err as Error).message);
      setSaveState('error');
    }
  }

  // GitHub-linked pages: a review suggestion is applied to the unpublished
  // draft in the editor (it reaches GitHub with the next Publish). The quote
  // must appear exactly once; returns false when it doesn't.
  const applyToDraft = useCallback((quote: string, replacement: string): boolean => {
    const content = latest.current;
    const at = content.indexOf(quote);
    if (at < 0 || content.indexOf(quote, at + 1) >= 0) return false;
    const updated = content.slice(0, at) + replacement + content.slice(at + quote.length);
    latest.current = updated;
    setDraft(updated !== saved.current);
    writeDraft(pathRef.current, { content: updated, sha: editBaseSha.current });
    setEntry((e) => e && { ...e, content: updated });
    setEditorVersion((n) => n + 1);
    return true;
  }, []);

  // GitHub-linked pages: check every 30 seconds (and when the window regains
  // focus) whether GitHub has a newer version or the pull request's status
  // changed. The server keeps this fresh in the background.
  const githubPollKey = github ? pathRef.current : null;
  useEffect(() => {
    if (!githubPollKey) return;
    let stopped = false;
    const check = async () => {
      const status = await api.githubPageStatus(pathRef.current).catch(() => null);
      if (!status || stopped) return;
      const before = githubRef.current?.pr ?? null;
      if (before && !status.pr) {
        const ended = status.pulls.find((p) => p.number === before.number);
        setGithubNotice(
          ended?.state === 'merged'
            ? `Pull request #${before.number} was merged. Refresh to see the merged version.`
            : `Pull request #${before.number} was closed without merging.`,
        );
        setRemoteChanged(true);
      } else if (before && status.pr) {
        const was = pullLabel(before);
        const now = pullLabel(status.pr);
        if (was.key !== now.key) setGithubNotice(`Pull request #${status.pr.number} is now: ${now.label}.`);
      }
      if (status.sha && loadedSha.current && status.sha !== loadedSha.current && status.pr?.number === before?.number) {
        setRemoteChanged(true);
      }
      setGithub((g) => g && { ...g, pr: status.pr, pulls: status.pulls });
    };
    const timer = window.setInterval(check, 30_000);
    window.addEventListener('focus', check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [githubPollKey]);

  // Before a review reads or changes the page: save pending edits. False when
  // they can't be saved (e.g. someone else edited the page meanwhile).
  const saveNow = useCallback(async () => {
    await flush();
    return !blocked.current && latest.current === saved.current;
  }, [flush]);

  if (loadError) {
    return (
      <div className="page">
        <p className="down">{loadError}</p>
      </div>
    );
  }

  const folderParts = folderOf(path) ? folderOf(path).split('/') : [];
  const status = {
    saved: entry?.author ? `Edited by ${entry.author.name} ${timeAgo(entry.lastModified)}` : 'Saved',
    unsaved: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Not saved',
    error: 'Not saved',
  }[saveState];
  const githubStatus = github
    ? draft
      ? 'Unpublished changes'
      : github.pr
        ? `In pull request #${github.pr.number}`
        : 'Up to date with GitHub'
    : null;

  return (
    <div className={`page-shell ${reviewing ? 'with-panel' : ''}`}>
      <header className="page-bar">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          {folderParts.map((part, i) => (
            <span key={i}>
              {part}
              <span className="sep">/</span>
            </span>
          ))}
          <span className="current">{nameOf(path)}</span>
        </nav>
        <div className="page-bar-right">
          <span className={`save-status ${github ? (draft ? 'unsaved' : 'saved') : saveState}`}>{githubStatus ?? status}</span>
          {github && (
            <button
              className="primary publish-button"
              disabled={!draft || !github.canPublish}
              title={
                !github.canPublish
                  ? 'Connect GitHub in Settings to publish'
                  : !draft
                    ? 'No unpublished changes'
                    : github.pr
                      ? `Add your changes to pull request #${github.pr.number}`
                      : 'Open a pull request with your changes'
              }
              onClick={() => setPublishing(true)}
            >
              Publish
            </button>
          )}
          <button
            className={`bar-button review-button ${reviewing ? 'active' : ''}`}
            title="Suggestions to make this page clearer, conflicts with other pages, missing ontology links, and dead links"
            aria-pressed={reviewing}
            onClick={() => setReviewing(!reviewing)}
          >
            <span className="review-spark" aria-hidden>
              ✦
            </span>{' '}
            <span className="review-label">Review</span>
          </button>
          <div className="menu-anchor">
            <button
              className="icon-button"
              aria-label="Page options"
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen(!menuOpen);
                setConfirmDelete(false);
              }}
            >
              ⋯
            </button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="menu" role="menu">
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate({ view: 'history', path: pathRef.current });
                    }}
                  >
                    Page history
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setMoving(true);
                    }}
                  >
                    Move to folder…
                  </button>
                  {confirmDelete ? (
                    <button role="menuitem" className="danger-text" onClick={remove}>
                      Click again to delete
                    </button>
                  ) : (
                    <button role="menuitem" className="danger-text" onClick={() => setConfirmDelete(true)}>
                      Delete
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {github && (
        <GithubBar
          github={github}
          draft={draft}
          staleDraft={staleDraft}
          remoteChanged={remoteChanged}
          notice={githubNotice}
          onDismissNotice={() => setGithubNotice(null)}
          onDiscard={() => {
            writeDraft(pathRef.current, null);
            setReloadCount((n) => n + 1);
          }}
          onRefresh={async () => {
            await api.githubPull(pathRef.current);
            setReloadCount((n) => n + 1);
          }}
        />
      )}
      {publishing && github && (
        <PublishDialog
          path={pathRef.current}
          github={github}
          content={latest.current}
          baseSha={editBaseSha.current}
          onClose={() => setPublishing(false)}
          onPublished={(result) => {
            setPublishing(false);
            saved.current = latest.current;
            loadedSha.current = editBaseSha.current = result.sha;
            setDraft(false);
            setStaleDraft(false);
            setRemoteChanged(false);
            writeDraft(pathRef.current, null);
            setGithub({ ...github, pr: result.pr, synced: null });
            void api.githubPageStatus(pathRef.current).then((s) => s && setGithub((g) => g && { ...g, pulls: s.pulls }));
          }}
        />
      )}
      {pendingProposals > 0 && (
        <div className="banner proposals-banner">
          <span>
            Agents proposed {pendingProposals === 1 ? 'a change' : `${pendingProposals} changes`} to this page.
          </span>
          <a className="button" href={href({ view: 'proposals', path })}>
            Review
          </a>
        </div>
      )}
      {factCheck && (
        <div className="banner fact-check">
          <span>
            <strong>Fact check:</strong> is this still accurate? Fix anything that's wrong or out of date
            right here. Changes save automatically.
          </span>
          <button onClick={() => setFactCheck(false)}>Done</button>
        </div>
      )}
      {saveState === 'conflict' && (
        <div className="banner">
          <span>
            Someone else edited this page while you were working, so your latest changes weren't
            saved.
          </span>
          <button onClick={() => navigator.clipboard.writeText(latest.current)}>Copy my version</button>
          <button onClick={() => setReloadCount((n) => n + 1)}>Load latest</button>
        </div>
      )}
      {saveState === 'error' && (
        <div className="banner">
          <span>Couldn't save: {saveError}</span>
          <button onClick={() => void flush()}>Retry</button>
        </div>
      )}

      <div className="page">
        {moving && (
          <form className="move-form" onSubmit={submitMove}>
            <label>
              Move to folder
              <input name="folder" defaultValue={folderOf(path)} placeholder="Top level" autoFocus />
            </label>
            <button type="submit" className="primary">
              Move
            </button>
            <button type="button" onClick={() => setMoving(false)}>
              Cancel
            </button>
          </form>
        )}

        <input
          ref={titleRef}
          className="page-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={onTitleKey}
          placeholder="Untitled"
          aria-label="Page name"
          spellCheck={false}
        />
        {titleError && <p className="down title-error">{titleError}</p>}

        {entry ? (
          <Suspense fallback={<p className="muted">Loading editor…</p>}>
            <Editor
              ref={editorRef}
              key={`${reloadCount}.${editorVersion}`}
              path={path}
              initialMarkdown={entry.content}
              onChange={onEdit}
            />
          </Suspense>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>

      {reviewing && (
        <ReviewPanel
          path={path}
          currentVersionId={entry?.versionId ?? null}
          beforeApply={saveNow}
          onApplied={() => setReloadCount((n) => n + 1)}
          githubLinked={Boolean(github)}
          applyToDraft={github ? applyToDraft : undefined}
          onClose={() => setReviewing(false)}
        />
      )}
    </div>
  );
}
