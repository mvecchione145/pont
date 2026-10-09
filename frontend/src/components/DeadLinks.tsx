import { useCallback, useEffect, useState } from 'react';
import { api, type DeadLink } from '../api';
import { href } from '../route';

// Dead links: internal links whose page, heading, or concept is gone, with a
// suggested new destination when pont can find one. Part of a page's Review
// panel; found without the LLM, so they show as soon as the panel opens.

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

// Dead links on one page, for its Review panel. Loads on its own (no LLM).
export function useDeadLinks(path: string) {
  const [links, setLinks] = useState<DeadLink[] | null>(null);
  const load = useCallback(() => {
    api.deadLinks(path).then(setLinks, () => setLinks([]));
  }, [path]);
  useEffect(load, [load]);
  return { links, reload: load };
}
