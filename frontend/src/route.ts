import { useEffect, useState } from 'react';

// A tiny hash router: #/p/<path>[?section=<heading>] for a page, plus
// #/trivia, #/settings, #/tokens, or home.
export type Route =
  | { view: 'home' }
  | { view: 'tokens' }
  | { view: 'trivia' }
  | { view: 'settings' }
  | { view: 'ontology' }
  | { view: 'proposals'; path?: string }
  | { view: 'page'; path: string; section?: string };

function parse(hash: string): Route {
  const [location, query = ''] = hash.replace(/^#/, '').split('?');
  const [, view = '', ...rest] = location.split('/');
  const path = rest.map(decodeURIComponent).join('/');
  // "entry" is the pre-redesign name, kept so old links still open.
  if ((view === 'p' || view === 'entry') && path) {
    const section = new URLSearchParams(query).get('section') ?? undefined;
    return { view: 'page', path, section };
  }
  if (view === 'tokens' || view === 'trivia' || view === 'settings' || view === 'ontology') return { view };
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
      return `#/${route.view}`;
    case 'proposals':
      return route.path ? `#/proposals?${new URLSearchParams({ path: route.path })}` : '#/proposals';
    case 'page': {
      const base = `#/p/${route.path.split('/').map(encodeURIComponent).join('/')}`;
      return route.section ? `${base}?${new URLSearchParams({ section: route.section })}` : base;
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
