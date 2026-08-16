/**
 * A very small path router.
 *
 * There is no routing library here on purpose: the whole site is three routes,
 * and react-router would be a larger dependency than the thing it routes. This
 * uses the same History API the search page already uses to keep filters in the
 * URL, so both mechanisms agree about what the address bar means.
 *
 * pushState does not emit an event of its own, so `navigate` dispatches one --
 * without it, a link click would change the URL and nothing would re-render.
 */

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'search' }
  | { name: 'tables' }
  | { name: 'table'; table: string };

const ROUTE_EVENT = 'allcarsdb:navigate';

export function parseRoute(pathname: string): Route {
  // Trailing slashes are tolerated so /tables and /tables/ are the same page.
  const path = pathname.replace(/\/+$/, '');
  if (path === '/tables') return { name: 'tables' };
  const m = /^\/tables\/([^/]+)$/.exec(path);
  if (m) return { name: 'table', table: decodeURIComponent(m[1]!) };
  return { name: 'search' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname));
    // popstate covers Back/Forward; the custom event covers our own navigate().
    window.addEventListener('popstate', sync);
    window.addEventListener(ROUTE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(ROUTE_EVENT, sync);
    };
  }, []);

  return route;
}

export function navigate(path: string) {
  if (window.location.pathname + window.location.search === path) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(ROUTE_EVENT));
  window.scrollTo(0, 0);
}

/**
 * Props for an internal link. Left as a real href so middle-click, ctrl-click
 * and "copy link address" behave the way they do anywhere else on the web --
 * only a plain left-click is intercepted.
 */
export function linkProps(path: string) {
  return {
    href: path,
    onClick: (e: React.MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      navigate(path);
    },
  };
}
