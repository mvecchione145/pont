import { useEffect, useState } from 'react';

// A tiny hash router: #/p/<path>[?section=<heading>] for a page (scrolled to
// that heading; "&check=1" adds trivia's fact-check prompt), plus #/trivia,
// #/settings, #/tokens, or home. Links between pages are stored in Markdown
// in this same form.
export type Route =
  | { view: 'home' }
  | { view: 'tokens' }
  | { view: 'trivia' }
  | { view: 'settings' }
  | { view: 'ontology' }
  | { view: 'links' }
  | { view: 'proposals'; path?: string }
  | { view: 'history'; path: string }
  | { view: 'concept'; id: string }
  | { view: 'relation'; id: string }
  | { view: 'page'; path: string; section?: string; check?: boolean };

function parse(hash: string): Route {
  const [location, query = ''] = hash.replace(/^#/, '').split('?');
  const [, view = '', ...rest] = location.split('/');
  const path = rest.map(decodeURIComponent).join('/');
  // "entry" is the pre-redesign name, kept so old links still open.
  if ((view === 'p' || view === 'entry') && path) {
    const params = new URLSearchParams(query);
    const section = params.get('section') ?? undefined;
    return { view: 'page', path, section, check: params.get('check') === '1' || undefined };
  }
  if (view === 'tokens' || view === 'trivia' || view === 'settings' || view === 'ontology' || view === 'links') return { view };
  if (view === 'history' && path) return { view, path };
  if ((view === 'concept' || view === 'relation') && path) return { view, id: path };
  if (view === 'proposals') return { view, path: new URLSearchParams(query).get('path') ?? undefined };
  return { view: 'home' };
}

export function href(route: Route): string {
  switch (route.view) {
    case 'home':
      return '#/';
    case 'tokens':
    case 'trivia':
    case 'settings':
    case 'ontology':
    case 'links':
      return `#/${route.view}`;
    case 'concept':
    case 'relation':
      return `#/${route.view}/${encodeURIComponent(route.id)}`;
    case 'history':
      return `#/history/${route.path.split('/').map(encodeURIComponent).join('/')}`;
    case 'proposals':
      return route.path ? `#/proposals?${new URLSearchParams({ path: route.path })}` : '#/proposals';
    case 'page': {
      const base = `#/p/${route.path.split('/').map(encodeURIComponent).join('/')}`;
      const params = new URLSearchParams();
      if (route.section) params.set('section', route.section);
      if (route.check) params.set('check', '1');
      return params.size ? `${base}?${params}` : base;
    }
  }
}

export function navigate(route: Route) {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
