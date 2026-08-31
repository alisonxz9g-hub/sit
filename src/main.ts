import './styles.css';
import { el, qs } from './ui/dom';
import { startRouter } from './ui/router';

/**
 * Bootstrap. Renders the shell, then hands the content area to the router.
 *
 * Failures here are shown in the page rather than only in the console, because a blank
 * dark screen is indistinguishable from a slow load.
 */
function boot(): void {
  const root = qs('#app');

  const nav = el('nav', { class: 'nav-links', attrs: { 'aria-label': 'Sections' } });
  const content = el('main', { class: 'content', id: 'main' });

  root.replaceChildren(
    el('header', { class: 'topbar' }, [
      el('a', { class: 'brand', attrs: { href: '#optimizer' } }, [
        el('span', { class: 'brand-dot', attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: 'Prepare' }),
      ]),
      nav,
      el('span', { class: 'topbar-note', text: 'runs entirely in your browser' }),
    ]),
    content,
    el('footer', { class: 'footer' }, [
      el('p', {
        text:
          'No backend, no accounts, no uploads. Video analysis and processing both happen ' +
          'in this tab.',
      }),
    ]),
  );

  const stop = startRouter(content, nav);
  window.addEventListener('beforeunload', stop);
}

try {
  boot();
} catch (error) {
  // Last resort: the shell itself failed, so build the message by hand.
  const root = document.getElementById('app');
  if (root) {
    root.textContent = '';
    const box = document.createElement('div');
    box.className = 'panel';
    const title = document.createElement('h2');
    title.textContent = 'This app failed to start';
    const detail = document.createElement('p');
    detail.textContent = error instanceof Error ? error.message : String(error);
    box.append(title, detail);
    root.appendChild(box);
  }
  throw error;
}
