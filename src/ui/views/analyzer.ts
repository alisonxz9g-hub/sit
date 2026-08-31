/**
 * Analyzer: everything the parser found, with nothing summarised away.
 *
 * The optimizer answers "what should I do". This answers "what is actually in the
 * file", which is what you want when a result is surprising and you need to check the
 * tool rather than trust it.
 */
import { Mp4ParseError, analyzeFile, diagnose, type MediaReport } from '../../core/index';
import { clear, el, icon } from '../dom';
import { renderBoxLayout, renderFindings, renderSummary, renderTrackDetail } from '../report';
import type { View } from '../view';

export function createAnalyzer(): View {
  const output = el('div', { class: 'analyzer-output' });

  const fileInput = el('input', {
    class: 'visually-hidden',
    attrs: { type: 'file', accept: 'video/mp4,video/quicktime,.mp4,.mov,.m4v' },
    on: {
      change: () => {
        const file = fileInput.files?.[0];
        if (file) void inspect(file);
        fileInput.value = '';
      },
    },
  });

  const dropZone = el(
    'div',
    {
      class: 'dropzone dropzone-slim',
      attrs: { role: 'button', tabindex: '0', 'aria-label': 'Choose a video to inspect' },
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
          const file = event.dataTransfer?.files?.[0];
          if (file) void inspect(file);
        },
      },
    },
    [
      el('div', { class: 'dropzone-icon' }, [icon('film')]),
      el('p', { class: 'dropzone-title', text: 'Drop one file to inspect it' }),
      el('p', { class: 'dropzone-hint', text: 'Reads the index only, so large files are fast.' }),
      fileInput,
    ],
  );

  async function inspect(file: File): Promise<void> {
    clear(output);
    output.appendChild(el('p', { class: 'job-note', text: `Reading ${file.name}...` }));

    try {
      const started = performance.now();
      const report = await analyzeFile(file);
      const elapsed = performance.now() - started;
      render(report, elapsed);
    } catch (error) {
      clear(output);
      output.appendChild(
        el('div', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'Could not read this file' }),
          el('p', {
            class: 'tone-bad',
            text:
              error instanceof Mp4ParseError
                ? error.message
                : 'This file could not be read as an MP4 or MOV.',
          }),
        ]),
      );
    }
  }

  function render(report: MediaReport, elapsedMs: number): void {
    clear(output);
    const diagnosis = diagnose(report);

    output.appendChild(
      el('div', { class: 'panel' }, [
        el('h2', { class: 'panel-title', text: 'Overview' }),
        renderSummary(report),
        el('p', {
          class: 'muted small',
          text:
            `Parsed in ${elapsedMs.toFixed(0)} ms by reading ${report.topLevel.length} ` +
            'top-level box(es). The media payload was never loaded into memory.',
        }),
      ]),
    );

    output.appendChild(
      el('div', { class: 'panel' }, [
        el('h2', { class: 'panel-title', text: 'Findings' }),
        renderFindings(diagnosis),
      ]),
    );

    output.appendChild(
      el('div', { class: 'panel' }, [
        el('h2', { class: 'panel-title', text: 'File layout' }),
        el('p', {
          class: 'muted small',
          text:
            'Top-level boxes in order. When moov comes after mdat, anything reading the ' +
            'file has to seek to the end before it can start.',
        }),
        renderBoxLayout(report),
      ]),
    );

    output.appendChild(
      el('div', { class: 'panel' }, [
        el('h2', { class: 'panel-title', text: `Tracks (${report.tracks.length})` }),
        ...report.tracks.map((track, index) => renderTrackDetail(track, index)),
      ]),
    );

    if (report.brand) {
      output.appendChild(
        el('div', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'Container' }),
          el('div', { class: 'summary' }, [
            el('div', { class: 'row' }, [
              el('span', { class: 'row-label', text: 'Major brand' }),
              el('span', { class: 'row-value', text: report.brand.major }),
            ]),
            el('div', { class: 'row' }, [
              el('span', { class: 'row-label', text: 'Compatible brands' }),
              el('span', {
                class: 'row-value',
                text: report.brand.compatible.join(', ') || '—',
              }),
            ]),
            el('div', { class: 'row' }, [
              el('span', { class: 'row-label', text: 'Fragmented' }),
              el('span', { class: 'row-value', text: report.fragmented ? 'yes' : 'no' }),
            ]),
            el('div', { class: 'row' }, [
              el('span', { class: 'row-label', text: '64-bit boxes' }),
              el('span', { class: 'row-value', text: report.hasLargeBoxes ? 'yes' : 'no' }),
            ]),
            el('div', { class: 'row' }, [
              el('span', { class: 'row-label', text: 'MIME type' }),
              el('span', { class: 'row-value', text: report.mimeType }),
            ]),
          ]),
        ]),
      );
    }

    if (report.notes.length > 0) {
      output.appendChild(
        el('div', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'Parser notes' }),
          el('ul', { class: 'notes' }, report.notes.map((note) => el('li', { text: note }))),
        ]),
      );
    }
  }

  const element = el('div', { class: 'view view-analyzer' }, [
    el('header', { class: 'view-head' }, [
      el('h1', { text: 'Analyzer' }),
      el('p', {
        class: 'lede',
        text:
          'Every value the parser reads, unsummarised: sample tables, colour tags, ' +
          'rotation matrices, box layout. Useful when you want to check the tool rather ' +
          'than take its word for it.',
      }),
    ]),
    dropZone,
    output,
  ]);

  return {
    element,
    destroy() {
      clear(output);
    },
  };
}
