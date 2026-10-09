import { useCallback, useEffect, useState } from 'react';
import { api, type DeadLink } from '../api';
import { href } from '../route';

// Dead links: internal links whose page, heading, or concept is gone, with a
// suggested new destination when pont can find one. Shown in a page's Review
// panel (that page) and on the Link check page (every page).

const PROBLEM: Record<DeadLink['problem'], string> = {
  page_moved: 'Page moved',
  page_deleted: 'Page deleted',
  page_missing: 'No such page',
  heading_missing: 'Heading gone',
  concept_missing: 'Concept gone',
  relation_missing: 'Relationship gone',
};

interface ListProps {
  path: string;
  links: DeadLink[];
  // Runs before a fix (e.g. saving the editor); false cancels it.
  beforeFix?: () => Promise<boolean>;
  // Called after the page was changed.
  onFixed: () => void;
}

export function DeadLinkList({ path, links, beforeFix, onFixed }: ListProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fix(link: DeadLink, to: string | null) {
    setBusy(link.href);
    setError(null);
    try {
      if (beforeFix && !(await beforeFix())) throw new Error('Your latest edits could not be saved, so nothing was changed.');
      await api.fixLink(path, link.href, to);
      onFixed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <p className="down">{error}</p>}
      <ul className="dead-links">
        {links.map((link) => (
          <li key={link.href} className="review-item dead">
            <div className="review-item-head">
              <span className="pill dead">{PROBLEM[link.problem]}</span>
              {link.count > 1 && <span className="muted">{link.count} links</span>}
            </div>
            <p>
              “{link.text || link.href}” — {link.message}
            </p>
            {link.suggestion && (
              <p className="muted hint">
                Suggested: <a href={link.suggestion.href}>{link.suggestion.label}</a>. {link.suggestion.reason}
              </p>
            )}
            <div className="review-item-actions">
              {link.suggestion && (
                <button className="primary" disabled={busy !== null} onClick={() => fix(link, link.suggestion!.href)}>
                  Point to {link.suggestion.label.length > 28 ? `${link.suggestion.label.slice(0, 28)}…` : link.suggestion.label}
                </button>
              )}
              <button disabled={busy !== null} onClick={() => fix(link, null)} title="Keep the text, remove the link">
                Unlink
              </button>
              {(link.problem === 'page_deleted' || link.problem === 'page_moved') && (
                <a className="button" href={href({ view: 'history', path: decodeTarget(link.href) })}>
                  History
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// The page path in a "#/p/<path>?section=..." link.
function decodeTarget(link: string): string {
  const location = link.replace(/^#\/(p|entry)\//, '').split('?')[0];
  return location
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

// The Link check page: dead links on every page.
export function LinkCheckPage() {
  const [pages, setPages] = useState<{ path: string; links: DeadLink[] }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.allDeadLinks().then(setPages, (err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const total = pages?.reduce((n, p) => n + p.links.reduce((m, l) => m + l.count, 0), 0) ?? 0;

  return (
    <div className="link-check">
      <h1 className="page-title static">Link check</h1>
      <p className="lead">
        Links to pages, headings, and concepts that no longer exist, for example after a page was moved, renamed, or
        deleted. Point each one at its new home, or unlink it.
      </p>
      <div className="actions">
        <button onClick={load}>Check again</button>
      </div>
      {error && <p className="down">{error}</p>}
      {!pages ? (
        <p className="muted">Checking every page…</p>
      ) : pages.length === 0 ? (
        <p className="up">No dead links. Every internal link points somewhere that exists.</p>
      ) : (
        <>
          <p className="muted">
            {total} dead {total === 1 ? 'link' : 'links'} on {pages.length} {pages.length === 1 ? 'page' : 'pages'}.
          </p>
          {pages.map((p) => (
            <section key={p.path}>
              <h2 className="section-heading">
                <a href={href({ view: 'page', path: p.path })}>{p.path}</a>
              </h2>
              <DeadLinkList path={p.path} links={p.links} onFixed={load} />
            </section>
          ))}
        </>
      )}
    </div>
  );
}

// Dead links on one page, for its Review panel. Loads on its own (no LLM).
export function useDeadLinks(path: string) {
  const [links, setLinks] = useState<DeadLink[] | null>(null);
  const load = useCallback(() => {
    api.deadLinks(path).then(setLinks, () => setLinks([]));
  }, [path]);
  useEffect(load, [load]);
  return { links, reload: load };
}
