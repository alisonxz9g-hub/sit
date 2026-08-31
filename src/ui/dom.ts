/**
 * Minimal typed DOM helpers.
 *
 * `text` sets textContent and `html` sets innerHTML, and the split is deliberate:
 * filenames, ffmpeg log lines and codec strings all originate outside the app, so
 * everything dynamic goes through `text`. `html` exists only for the handful of
 * static fragments written in this repo.
 */

type EventMap = HTMLElementEventMap;

export interface Attrs {
  class?: string;
  /** Set as textContent. Safe for anything user- or tool-derived. */
  text?: string | number;
  /** Set as innerHTML. Only ever pass literals written in this repo. */
  html?: string;
  title?: string;
  id?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  data?: Record<string, string | number>;
  style?: Partial<CSSStyleDeclaration>;
  on?: { [E in keyof EventMap]?: (event: EventMap[E]) => void };
}

export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (attrs.class) node.className = attrs.class;
  if (attrs.id) node.id = attrs.id;
  if (attrs.title !== undefined) node.title = attrs.title;
  if (attrs.text !== undefined) node.textContent = String(attrs.text);
  if (attrs.html !== undefined) node.innerHTML = attrs.html;

  for (const [key, value] of Object.entries(attrs.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }

  for (const [key, value] of Object.entries(attrs.data ?? {})) {
    node.dataset[key] = String(value);
  }

  if (attrs.style) Object.assign(node.style, attrs.style);

  for (const [type, handler] of Object.entries(attrs.on ?? {})) {
    node.addEventListener(type, handler as EventListener);
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Element not found: ${selector}`);
  return found;
}

/** A definition-list style key/value row, used throughout the reports. */
export function row(label: string, value: string, tone?: 'good' | 'warn' | 'bad'): HTMLElement {
  return el('div', { class: 'row' }, [
    el('span', { class: 'row-label', text: label }),
    el('span', { class: `row-value${tone ? ` tone-${tone}` : ''}`, text: value }),
  ]);
}

export function section(title: string, children: Child[], extraClass = ''): HTMLElement {
  return el('section', { class: `panel ${extraClass}`.trim() }, [
    el('h2', { class: 'panel-title', text: title }),
    ...children,
  ]);
}

/** Inline SVG icons, so the app needs no icon font and no network request. */
const ICONS: Record<string, string> = {
  blocker:
    '<path d="M12 2 2 20h20L12 2Zm0 6v6m0 3v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  warning:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v6m0 3v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  note:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6m0-9v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  check:
    '<path d="M4 12.5 9.5 18 20 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  download:
    '<path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  film:
    '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 4v16M16 4v16M3 12h18" stroke="currentColor" stroke-width="2"/>',
};

export function icon(name: keyof typeof ICONS | string, className = ''): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  svg.innerHTML = ICONS[name] ?? ICONS.note!;
  return svg;
}
