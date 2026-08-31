/**
 * The optimizer: drop files, see what is wrong with them, fix it, download.
 *
 * Jobs run one at a time on purpose. ffmpeg.wasm is a single instance with one virtual
 * filesystem, and two encodes racing for the same memory is how a tab gets killed.
 */
import {
  Mp4ParseError,
  analyzeFile,
  buildPlan,
  describeMode,
  diagnose,
  estimateSeconds,
  type Diagnosis,
  type MediaReport,
  type PipelineMode,
} from '../../core/index';
import { FfmpegError, isFfmpegLoaded, loadFfmpeg, runFfmpeg } from '../../core/ffmpeg';
import { append, clear, el, icon } from '../dom';
import * as fmt from '../format';
import { ProgressBar, RunLog } from '../log';
import { renderComparison, renderFindings, renderSummary } from '../report';
import type { View } from '../view';

type JobState = 'analyzing' | 'ready' | 'running' | 'done' | 'failed' | 'unsupported';

interface Job {
  readonly id: number;
  readonly file: File;
  state: JobState;
  report: MediaReport | null;
  diagnosis: Diagnosis | null;
  mode: PipelineMode | null;
  result: { blob: Blob; name: string; report: MediaReport } | null;
  error: string | null;
  /** Rendered card, replaced in place as the job advances. */
  card: HTMLElement;
  /**
   * Stable container for the mode picker. Changing mode refreshes only this, so the
   * radio group keeps keyboard focus instead of being rebuilt underneath the caret.
   */
  controls: HTMLElement;
  /**
   * Created once when the job finishes and reused on every later render. Building it
   * inside the render would leak one blob URL per re-render.
   */
  downloadUrl: string | null;
}

/** More than this at once and the wait becomes unhelpful rather than useful. */
const MAX_FILES = 8;

const ACCEPTED = ['video/mp4', 'video/quicktime', 'video/x-m4v'];
const ACCEPTED_EXTENSIONS = ['.mp4', '.mov', '.m4v'];

export function createOptimizer(): View {
  let nextId = 1;
  const jobs: Job[] = [];
  let queueRunning = false;
  let abort: AbortController | null = null;

  const log = new RunLog();
  const progress = new ProgressBar();
  const jobList = el('div', { class: 'jobs' });
  const objectUrls: string[] = [];

  /* ------------------------------------------------------------- drop zone --- */

  const fileInput = el('input', {
    class: 'visually-hidden',
    attrs: {
      type: 'file',
      accept: [...ACCEPTED, ...ACCEPTED_EXTENSIONS].join(','),
      multiple: true,
    },
    on: {
      change: () => {
        const picked = fileInput.files;
        if (picked) void addFiles(Array.from(picked));
        // Reset so picking the same file twice still fires a change event.
        fileInput.value = '';
      },
    },
  });

  const dropZone = el(
    'div',
    {
      class: 'dropzone',
      attrs: { role: 'button', tabindex: '0', 'aria-label': 'Choose videos to optimize' },
      on: {
        click: () => fileInput.click(),
        keydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInput.click();
          }
        },
        dragover: (event) => {
          event.preventDefault();
          dropZone.classList.add('is-over');
        },
        dragleave: () => dropZone.classList.remove('is-over'),
        drop: (event) => {
          event.preventDefault();
          dropZone.classList.remove('is-over');
          const dropped = event.dataTransfer?.files;
          if (dropped) void addFiles(Array.from(dropped));
        },
      },
    },
    [
      el('div', { class: 'dropzone-icon' }, [icon('film')]),
      el('p', { class: 'dropzone-title', text: 'Drop videos here' }),
      el('p', {
        class: 'dropzone-hint',
        text: `MP4 or MOV, up to ${MAX_FILES} at a time. Nothing is uploaded — every step runs in this tab.`,
      }),
      fileInput,
    ],
  );

  /* ----------------------------------------------------------------- intake --- */

  function isAccepted(file: File): boolean {
    if (ACCEPTED.includes(file.type)) return true;
    const lower = file.name.toLowerCase();
    return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  async function addFiles(files: File[]): Promise<void> {
    const room = MAX_FILES - jobs.length;
    if (room <= 0) {
      log.write(`Queue is full at ${MAX_FILES} files. Clear it to add more.`, 'warn');
      return;
    }

    const accepted = files.filter(isAccepted);
    const rejected = files.length - accepted.length;
    if (rejected > 0) {
      log.write(`Ignored ${rejected} file(s) that are not MP4 or MOV.`, 'warn');
    }

    for (const file of accepted.slice(0, room)) {
      const job: Job = {
        id: nextId++,
        file,
        state: 'analyzing',
        report: null,
        diagnosis: null,
        mode: null,
        result: null,
        error: null,
        card: el('div', { class: 'job' }),
        controls: el('div', { class: 'job-controls' }),
        downloadUrl: null,
      };
      jobs.push(job);
      jobList.appendChild(job.card);
      renderJob(job);
      await analyzeJob(job);
    }

    updateControls();
  }

  async function analyzeJob(job: Job): Promise<void> {
    log.write(`Reading ${job.file.name} (${fmt.bytes(job.file.size)})...`, 'muted');
    try {
      const report = await analyzeFile(job.file);
      const diagnosis = diagnose(report);
      job.report = report;
      job.diagnosis = diagnosis;
      // Default to the cheapest mode that fixes what was found. `none` means the file
      // is already fine, so we still offer a remux but do not preselect anything.
      job.mode = diagnosis.recommended === 'none' ? 'remux' : diagnosis.recommended;
      job.state = 'ready';

      const counts = diagnosis.findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1;
        return acc;
      }, {});
      log.write(
        `${job.file.name}: ${describeCounts(counts)} · suggested ${describeMode(job.mode).title.toLowerCase()}`,
        diagnosis.clean ? 'good' : 'normal',
      );
    } catch (error) {
      job.state = 'unsupported';
      job.error =
        error instanceof Mp4ParseError
          ? error.message
          : 'This file could not be read as an MP4 or MOV.';
      log.write(`${job.file.name}: ${job.error}`, 'bad');
    }
    renderJob(job);
    updateControls();
  }

  function describeCounts(counts: Record<string, number>): string {
    const parts: string[] = [];
    if (counts.blocker) parts.push(`${counts.blocker} blocker(s)`);
    if (counts.warning) parts.push(`${counts.warning} worth fixing`);
    if (counts.note) parts.push(`${counts.note} note(s)`);
    return parts.length > 0 ? parts.join(', ') : 'nothing to fix';
  }

  /* ------------------------------------------------------------------- run --- */

  async function runQueue(): Promise<void> {
    if (queueRunning) return;
    const pending = jobs.filter((j) => j.state === 'ready' && j.mode !== null);
    if (pending.length === 0) return;

    queueRunning = true;
    abort = new AbortController();
    updateControls();

    if (!isFfmpegLoaded()) {
      progress.indeterminate('loading engine');
      log.write('Loading the transcoding engine (about 31 MB, cached after the first run)...', 'strong');
      try {
        await loadFfmpeg();
        log.write('Engine ready.', 'good');
      } catch (error) {
        log.write(error instanceof Error ? error.message : String(error), 'bad');
        progress.reset();
        queueRunning = false;
        abort = null;
        updateControls();
        return;
      }
      progress.determinate();
    }

    for (const job of pending) {
      if (abort.signal.aborted) break;
      await runJob(job, abort.signal);
    }

    progress.reset();
    log.finish();
    queueRunning = false;
    abort = null;
    updateControls();
  }

  async function runJob(job: Job, signal: AbortSignal): Promise<void> {
    if (!job.report || !job.mode) return;

    job.state = 'running';
    renderJob(job);

    const plan = buildPlan(job.report, job.mode);
    const described = describeMode(job.mode);
    log.write(`${job.file.name}: ${described.title.toLowerCase()} — ${fmt.estimate(estimateSeconds(job.report, job.mode))}`, 'strong');

    progress.set(0, `${job.file.name} — 0%`);

    try {
      const { bytes } = await runFfmpeg({
        input: job.file,
        args: plan.args,
        outputName: plan.outputName,
        signal,
        onLog: (line) => {
          // ffmpeg's per-frame status lines are noise in a log people read.
          if (/^frame=/.test(line)) return;
          log.write(line, 'muted');
        },
        onProgress: ({ ratio }) => progress.set(ratio, `${job.file.name} — ${fmt.percent(ratio)}`),
      });

      // Copy into a fresh buffer: the view over wasm memory is not stable once the
      // core continues, and this blob has to outlive the run.
      const blob = new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
      const name = fmt.outputName(job.file.name, job.mode === 'master' ? 'master' : 'optimized');

      // Re-analyse our own output rather than asserting it worked. If the result does
      // not parse, that is a bug worth surfacing, not hiding behind a download button.
      const outputFile = new File([blob], name, { type: 'video/mp4' });
      const report = await analyzeFile(outputFile);

      job.result = { blob, name, report };
      job.state = 'done';
      log.write(
        `${job.file.name}: done — ${fmt.bytes(blob.size)}, index at the front, output re-checked and valid.`,
        'good',
      );
    } catch (error) {
      if (signal.aborted) {
        job.state = 'ready';
        job.error = null;
        log.write(`${job.file.name}: cancelled.`, 'warn');
      } else {
        job.state = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        log.write(`${job.file.name}: ${job.error}`, 'bad');
        if (error instanceof FfmpegError) {
          for (const line of error.log.slice(-6)) log.write(`  ${line}`, 'muted');
        }
      }
    }

    renderJob(job);
  }

  /* ---------------------------------------------------------------- render --- */

  function renderJob(job: Job): void {
    clear(job.card);
    job.card.className = `job state-${job.state}`;

    const header = el('div', { class: 'job-head' }, [
      el('div', { class: 'job-title' }, [
        el('span', { class: 'job-name', text: job.file.name }),
        el('span', { class: 'job-size', text: fmt.bytes(job.file.size) }),
      ]),
      el('div', { class: 'job-actions' }, jobActions(job)),
    ]);
    job.card.appendChild(header);

    if (job.state === 'analyzing') {
      job.card.appendChild(el('p', { class: 'job-note', text: 'Reading structure...' }));
      return;
    }

    if (job.state === 'unsupported' || (job.state === 'failed' && !job.report)) {
      job.card.appendChild(el('p', { class: 'job-note tone-bad', text: job.error ?? 'Unreadable.' }));
      return;
    }

    if (!job.report || !job.diagnosis) return;

    if (job.state === 'failed' && job.error) {
      job.card.appendChild(el('p', { class: 'job-note tone-bad', text: job.error }));
    }

    if (job.state === 'done' && job.result) {
      job.card.appendChild(
        el('div', { class: 'job-result' }, [
          el('h3', { class: 'subhead', text: 'What changed' }),
          renderComparison(job.report, job.result.report),
        ]),
      );
    }

    job.card.appendChild(
      el('details', { class: 'job-section', attrs: { open: job.state === 'ready' } }, [
        el('summary', { text: `Findings (${job.diagnosis.findings.length})` }),
        renderFindings(job.diagnosis),
      ]),
    );

    job.card.appendChild(
      el('details', { class: 'job-section' }, [
        el('summary', { text: 'Source details' }),
        renderSummary(job.report),
      ]),
    );

    if (job.state === 'ready') {
      fillControls(job);
      job.card.appendChild(job.controls);
    }
  }

  function jobActions(job: Job): HTMLElement[] {
    const actions: HTMLElement[] = [];

    if (job.state === 'done' && job.result) {
      // Created lazily and cached on the job: renderJob can run more than once for a
      // finished job, and a fresh URL each time would pin a copy of the output in
      // memory until the page unloads.
      if (job.downloadUrl === null) {
        job.downloadUrl = URL.createObjectURL(job.result.blob);
        objectUrls.push(job.downloadUrl);
      }
      actions.push(
        el(
          'a',
          {
            class: 'btn btn-primary',
            attrs: { href: job.downloadUrl, download: job.result.name },
          },
          [icon('download'), document.createTextNode('Download')],
        ),
      );
    }

    if (job.state === 'running') {
      actions.push(el('span', { class: 'chip chip-live', text: 'running' }));
    }

    if (job.state !== 'running') {
      actions.push(
        el('button', {
          class: 'btn btn-ghost',
          attrs: { type: 'button' },
          text: 'Remove',
          on: { click: () => removeJob(job) },
        }),
      );
    }

    return actions;
  }

  /**
   * Rebuilds the mode picker inside the job's stable controls container. Focus is
   * restored to the selected radio, because the element the user just activated is
   * replaced as part of this.
   */
  function fillControls(job: Job): void {
    const hadFocus = job.controls.contains(document.activeElement);
    clear(job.controls);

    if (!job.report || !job.diagnosis) return;

    const recommended = job.diagnosis.recommended;
    const modes: PipelineMode[] = ['remux', 'retag', 'master'];

    const options = modes.map((mode) => {
      const described = describeMode(mode);
      const isRecommended = mode === recommended;
      const input = el('input', {
        attrs: {
          type: 'radio',
          name: `mode-${job.id}`,
          value: mode,
          checked: job.mode === mode,
        },
        on: {
          change: () => {
            job.mode = mode;
            fillControls(job);
            updateControls();
          },
        },
      });

      return el('label', { class: `mode${job.mode === mode ? ' is-active' : ''}` }, [
        input,
        el('span', { class: 'mode-body' }, [
          el('span', { class: 'mode-head' }, [
            el('span', { class: 'mode-title', text: described.title }),
            isRecommended && el('span', { class: 'badge badge-accent', text: 'suggested' }),
            el('span', {
              class: 'mode-cost',
              text: fmt.estimate(estimateSeconds(job.report!, mode)),
            }),
          ]),
          el('span', { class: 'mode-summary', text: described.summary }),
        ]),
      ]);
    });

    const children: HTMLElement[] = [
      el('h3', { class: 'subhead', text: 'How to process it' }),
      el('div', { class: 'modes' }, options),
    ];

    if (job.mode) {
      const plan = buildPlan(job.report, job.mode);
      children.push(
        el('details', { class: 'plan' }, [
          el('summary', { text: plan.lossless ? 'Steps (lossless)' : 'Steps (re-encode)' }),
          el(
            'ol',
            { class: 'plan-steps' },
            plan.steps.map((step) =>
              el('li', {}, [
                el('strong', { text: step.label }),
                el('span', { text: ` — ${step.detail}` }),
              ]),
            ),
          ),
          el('p', { class: 'plan-args-label', text: 'Exact command:' }),
          el('code', {
            class: 'plan-args',
            text: `ffmpeg ${plan.args.join(' ').replace('{input}', job.file.name)} ${plan.outputName}`,
          }),
        ]),
      );
    }

    if (job.diagnosis.needsReexport.length > 0) {
      children.push(
        el('p', { class: 'plan-warning' }, [
          el('strong', { text: 'Worth knowing: ' }),
          el('span', {
            text:
              'some of what was found cannot be fixed by processing. Those findings are ' +
              'marked "re-export from your editor" above, and running any mode here will ' +
              'not change them.',
          }),
        ]),
      );
    }

    append(job.controls, children);

    if (hadFocus) {
      job.controls.querySelector<HTMLInputElement>('input:checked')?.focus();
    }
  }

  /* -------------------------------------------------------------- controls --- */

  const runButton = el('button', {
    class: 'btn btn-primary btn-lg',
    attrs: { type: 'button' },
    text: 'Optimize',
    on: { click: () => void runQueue() },
  });

  const cancelButton = el('button', {
    class: 'btn btn-ghost',
    attrs: { type: 'button', hidden: true },
    text: 'Cancel',
    on: {
      click: () => {
        abort?.abort();
        log.write('Cancelling — the engine is restarting.', 'warn');
      },
    },
  });

  const clearButton = el('button', {
    class: 'btn btn-ghost',
    attrs: { type: 'button' },
    text: 'Clear all',
    on: { click: () => clearJobs() },
  });

  const queueNote = el('p', { class: 'queue-note' });

  function updateControls(): void {
    const ready = jobs.filter((j) => j.state === 'ready' && j.mode !== null).length;
    runButton.disabled = queueRunning || ready === 0;
    runButton.textContent = ready > 1 ? `Optimize ${ready} files` : 'Optimize';
    cancelButton.hidden = !queueRunning;
    clearButton.disabled = queueRunning || jobs.length === 0;

    if (jobs.length === 0) {
      queueNote.textContent = '';
    } else if (queueRunning) {
      queueNote.textContent = 'Processing one file at a time so the tab does not run out of memory.';
    } else {
      const done = jobs.filter((j) => j.state === 'done').length;
      queueNote.textContent = `${jobs.length} file(s) queued · ${done} finished · ${ready} ready to process`;
    }
  }

  function removeJob(job: Job): void {
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
    job.card.remove();
    updateControls();
  }

  function clearJobs(): void {
    for (const job of jobs) job.card.remove();
    jobs.length = 0;
    releaseUrls();
    log.clear();
    updateControls();
  }

  function releaseUrls(): void {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.length = 0;
  }

  /* ----------------------------------------------------------------- mount --- */

  const element = el('div', { class: 'view view-optimizer' }, [
    el('header', { class: 'view-head' }, [
      el('h1', { text: 'Optimizer' }),
      el('p', {
        class: 'lede',
        text:
          'Reads your file structure, tells you exactly what will cost you quality on ' +
          'upload, then fixes what can be fixed. Everything runs in this tab; no file ' +
          'is ever sent anywhere.',
      }),
    ]),
    dropZone,
    el('div', { class: 'queue-bar' }, [runButton, cancelButton, clearButton, queueNote]),
    progress.element,
    jobList,
    log.element,
  ]);

  log.write('Ready. Drop a file to begin.', 'muted');
  updateControls();

  return {
    element,
    destroy() {
      abort?.abort();
      releaseUrls();
    },
  };
}
