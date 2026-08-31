/**
 * Terminal-style run log.
 *
 * ffmpeg is chatty and a stalled 31 MB core download looks identical to a hung app,
 * so the log is the main signal that something is happening. Lines are capped and
 * appended through a rAF batch, because an ffmpeg encode can emit hundreds of lines a
 * second and one DOM write per line will drop frames.
 */
import { el } from './dom';

export type LogTone = 'normal' | 'muted' | 'good' | 'warn' | 'bad' | 'strong';

/** Older lines are dropped past this, to keep the DOM and memory bounded. */
const MAX_LINES = 400;

export class RunLog {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly pending: { text: string; tone: LogTone }[] = [];
  private frame: number | null = null;
  private lineCount = 0;
  /** Whether the view is pinned to the bottom. */
  private following = true;

  constructor() {
    this.list = el('div', {
      class: 'log-lines',
      attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Processing log' },
    });

    this.list.addEventListener('scroll', () => {
      const distanceFromBottom =
        this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
      // Once the reader scrolls up, stop yanking them back down.
      this.following = distanceFromBottom < 24;
    });

    this.element = el('div', { class: 'log' }, [
      el('div', { class: 'log-bar' }, [
        el('span', { class: 'log-dot' }),
        el('span', { class: 'log-title', text: 'engine' }),
      ]),
      this.list,
    ]);
  }

  write(text: string, tone: LogTone = 'normal'): void {
    this.pending.push({ text, tone });
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private flush(): void {
    if (this.pending.length === 0) return;

    const fragment = document.createDocumentFragment();
    for (const { text, tone } of this.pending) {
      fragment.appendChild(el('div', { class: `log-line tone-${tone}`, text }));
    }
    this.pending.length = 0;
    this.list.appendChild(fragment);

    this.lineCount = this.list.childElementCount;
    while (this.lineCount > MAX_LINES && this.list.firstChild) {
      this.list.removeChild(this.list.firstChild);
      this.lineCount--;
    }

    if (this.following) this.list.scrollTop = this.list.scrollHeight;
  }

  clear(): void {
    this.pending.length = 0;
    this.list.replaceChildren();
    this.lineCount = 0;
    this.following = true;
  }

  /** Flushes synchronously, for when the run ends and the last lines matter. */
  finish(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.flush();
  }
}

/** Progress bar with a label, driven by ffmpeg's progress events. */
export class ProgressBar {
  readonly element: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly label: HTMLElement;

  constructor() {
    this.fill = el('div', { class: 'progress-fill' });
    this.label = el('span', { class: 'progress-label', text: 'idle' });
    this.element = el('div', { class: 'progress' }, [
      el('div', {
        class: 'progress-track',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': '0',
        },
      }, [this.fill]),
      this.label,
    ]);
  }

  set(ratio: number, text?: string): void {
    const clamped = Math.min(1, Math.max(0, ratio));
    this.fill.style.width = `${clamped * 100}%`;
    const track = this.element.firstElementChild;
    track?.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
    if (text !== undefined) this.label.textContent = text;
  }

  /** For phases with no measurable progress, like loading the core. */
  indeterminate(text: string): void {
    this.element.classList.add('is-indeterminate');
    this.label.textContent = text;
  }

  determinate(): void {
    this.element.classList.remove('is-indeterminate');
  }

  reset(): void {
    this.determinate();
    this.set(0, 'idle');
  }
}
