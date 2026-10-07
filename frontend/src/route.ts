import { useEffect, useState } from 'react';

// A tiny hash router: #/p/<path> for a page, #/tokens, or home.
export type Route = { view: 'home' } | { view: 'tokens' } | { view: 'page'; path: string };

function parse(hash: string): Route {
  const [, view = '', ...rest] = hash.replace(/^#/, '').split('/');
  const path = rest.map(decodeURIComponent).join('/');
  // "entry" is the pre-redesign name, kept so old links still open.
  if ((view === 'p' || view === 'entry') && path) return { view: 'page', path };
  if (view === 'tokens') return { view: 'tokens' };
  return { view: 'home' };
}

export function href(route: Route): string {
  switch (route.view) {
    case 'home':
      return '#/';
    case 'tokens':
      return '#/tokens';
    case 'page':
      return `#/p/${route.path.split('/').map(encodeURIComponent).join('/')}`;
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
