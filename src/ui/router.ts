/**
 * Hash router.
 *
 * Views are created on navigation and destroyed on the way out, which matters because
 * the optimizer holds object URLs and a possibly running ffmpeg job. Leaving those
 * behind would leak a blob per processed file.
 */
import { clear, el } from './dom';
import type { View } from './view';
import { createAnalyzer } from './views/analyzer';
import { createGuide } from './views/guide';
import { createOptimizer } from './views/optimizer';

export interface Route {
  readonly id: string;
  readonly label: string;
  readonly create: () => View;
}

export const ROUTES: readonly Route[] = [
  { id: 'optimizer', label: 'Optimizer', create: createOptimizer },
  { id: 'analyzer', label: 'Analyzer', create: createAnalyzer },
  { id: 'guide', label: 'Guide', create: createGuide },
];

const DEFAULT_ROUTE = 'optimizer';

function routeFromHash(hash: string): Route {
  const id = hash.replace(/^#\/?/, '').split(/[?&]/, 1)[0]?.toLowerCase() ?? '';
  return ROUTES.find((r) => r.id === id) ?? ROUTES.find((r) => r.id === DEFAULT_ROUTE)!;
}

export function startRouter(container: HTMLElement, nav: HTMLElement): () => void {
  let current: View | null = null;
  let currentId: string | null = null;

  const links = ROUTES.map((route) =>
    el('a', {
      class: 'nav-link',
      attrs: { href: `#${route.id}` },
      data: { view: route.id },
      text: route.label,
    }),
  );
  nav.replaceChildren(...links);

  function navigate(): void {
    const route = routeFromHash(window.location.hash);
    if (route.id === currentId) return;

    current?.destroy();
    current = null;
    clear(container);

    // A fresh view every time. These are cheap to build and the alternative is
    // reasoning about stale state in three places.
    try {
      current = route.create();
      container.appendChild(current.element);
    } catch (error) {
      container.appendChild(
        el('div', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'This section failed to load' }),
          el('p', { class: 'tone-bad', text: error instanceof Error ? error.message : String(error) }),
        ]),
      );
    }

    currentId = route.id;
    for (const link of links) {
      const active = link.dataset.view === route.id;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  window.addEventListener('hashchange', navigate);
  if (!window.location.hash) window.history.replaceState(null, '', `#${DEFAULT_ROUTE}`);
  navigate();

  return () => {
    window.removeEventListener('hashchange', navigate);
    current?.destroy();
  };
}
