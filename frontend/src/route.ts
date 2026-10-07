import { useEffect, useState } from 'react';

// A tiny hash router: #/entry/<path>, #/edit/<path>, #/new, #/tokens, or home.
export type Route =
  | { view: 'home' }
  | { view: 'tokens' }
  | { view: 'new'; folder: string }
  | { view: 'entry'; path: string }
  | { view: 'edit'; path: string };

function parse(hash: string): Route {
  const [, view = '', ...rest] = hash.replace(/^#/, '').split('/');
  const path = rest.map(decodeURIComponent).join('/');
  if (view === 'entry' && path) return { view: 'entry', path };
  if (view === 'edit' && path) return { view: 'edit', path };
  if (view === 'new') return { view: 'new', folder: path };
  if (view === 'tokens') return { view: 'tokens' };
  return { view: 'home' };
}

export function href(route: Route): string {
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  switch (route.view) {
    case 'home':
      return '#/';
    case 'tokens':
      return '#/tokens';
    case 'new':
      return route.folder ? `#/new/${enc(route.folder)}` : '#/new';
    default:
      return `#/${route.view}/${enc(route.path)}`;
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
