/**
 * Report rendering shared by the optimizer and the analyzer.
 *
 * Everything here takes already-computed values. No analysis or decision-making
 * happens in this file, which keeps the interesting logic in src/core where it can be
 * tested without a DOM.
 */
import type { Diagnosis, Finding, MediaReport, Severity, Track } from '../core/index';
import { isRec709, isUnspecifiedColor } from '../core/index';
import { el, icon, row, type Child } from './dom';
import * as fmt from './format';

const SEVERITY_ICON: Record<Severity, string> = {
  blocker: 'blocker',
  warning: 'warning',
  note: 'note',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: 'Blocker',
  warning: 'Worth fixing',
  note: 'For information',
};

const FIX_LABEL: Record<Finding['fix'], string> = {
  remux: 'Fixed by remux',
  retag: 'Fixed by colour tagging',
  master: 'Needs a re-encode',
  reexport: 'Re-export from your editor',
  none: 'No action needed',
};

export function renderFinding(finding: Finding): HTMLElement {
  return el('article', { class: `finding sev-${finding.severity}` }, [
    el('div', { class: 'finding-icon' }, [icon(SEVERITY_ICON[finding.severity])]),
    el('div', { class: 'finding-body' }, [
      el('div', { class: 'finding-head' }, [
        el('h3', { class: 'finding-title', text: finding.title }),
        el('span', { class: 'badge', text: SEVERITY_LABEL[finding.severity] }),
      ]),
      el('p', { class: 'finding-detail', text: finding.detail }),
      el('div', { class: 'finding-meta' }, [
        el('code', { class: 'evidence', text: finding.evidence }),
        el('span', { class: `fix fix-${finding.fix}`, text: FIX_LABEL[finding.fix] }),
      ]),
    ]),
  ]);
}

export function renderFindings(diagnosis: Diagnosis): HTMLElement {
  if (diagnosis.findings.length === 0) {
    return el('div', { class: 'finding sev-ok' }, [
      el('div', { class: 'finding-icon' }, [icon('check')]),
      el('div', { class: 'finding-body' }, [
        el('h3', { class: 'finding-title', text: 'Nothing to fix' }),
        el('p', {
          class: 'finding-detail',
          text:
            'The container, frame timing, colour tagging and codec are all in good ' +
            'shape. Upload it as it is.',
        }),
      ]),
    ]);
  }

  return el('div', { class: 'findings' }, diagnosis.findings.map(renderFinding));
}

/** The headline facts, the ones people actually check. */
export function renderSummary(report: MediaReport): HTMLElement {
  const video = report.video;
  const audio = report.audio;

  const items: Child[] = [
    row('File', report.fileName),
    row('Size', fmt.bytes(report.fileSize)),
    row('Duration', fmt.duration(report.durationSec)),
    row('Overall bitrate', fmt.bitrate(report.overallBitrateBps)),
  ];

  if (video) {
    const timing = video.timing;
    items.push(
      row('Video', `${video.codecLabel}${video.video?.profile ? ` · ${video.video.profile}` : ''}`),
      row('Frame size', fmt.dimensions(video.orientedWidth, video.orientedHeight)),
      row(
        'Frame rate',
        `${fmt.fps(timing.nominalFps ?? timing.avgFps)} · ${timingLabel(video)}`,
        timing.mode === 'vfr' ? 'warn' : 'good',
      ),
      row('Video bitrate', fmt.bitrate(video.bitrateBps)),
      row('Colour', colorLabel(video), colorTone(video)),
    );
    if (video.rotationDegrees !== 0) {
      items.push(row('Rotation', `${video.rotationDegrees}° · stored ${fmt.dimensions(video.codedWidth, video.codedHeight)}`));
    }
  }

  if (audio) {
    const detail = [
      audio.audio?.profile ?? audio.codecLabel,
      audio.audio?.sampleRate ? `${(audio.audio.sampleRate / 1000).toFixed(1)} kHz` : null,
      audio.audio?.channels ? `${audio.audio.channels} ch` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    items.push(row('Audio', detail));
  } else {
    items.push(row('Audio', 'none', 'warn'));
  }

  items.push(
    row('Index position', report.faststart ? 'front (faststart)' : 'end of file', report.faststart ? 'good' : 'warn'),
  );

  if (report.encoderTag) items.push(row('Encoder tag', report.encoderTag));

  return el('div', { class: 'summary' }, items);
}

function timingLabel(video: Track): string {
  switch (video.timing.mode) {
    case 'cfr':
      return 'constant';
    case 'near-cfr':
      return 'near constant';
    case 'vfr':
      return 'variable';
    default:
      return 'unknown';
  }
}

function colorLabel(video: Track): string {
  const { color } = video;
  if (color.isHdr) return `HDR · ${color.transferLabel}`;
  if (!color.present) return 'not tagged';
  if (isRec709(color)) return 'Rec.709';
  return `${color.primariesLabel} / ${color.transferLabel} / ${color.matrixLabel}`;
}

function colorTone(video: Track): 'good' | 'warn' {
  const { color } = video;
  if (color.isHdr || isUnspecifiedColor(color)) return 'warn';
  return 'good';
}

/** Full structural detail, for the analyzer view. */
export function renderTrackDetail(track: Track, index: number): HTMLElement {
  const items: Child[] = [
    row('Kind', `${track.kind} (${track.handler})`),
    row('Sample entry', `${track.format} — ${track.codecLabel}`),
    row('Language', track.language),
    row('Timescale', `${track.timescale} ticks/s`),
    row('Duration', fmt.duration(track.durationSec)),
    row('Samples', track.sampleCount.toLocaleString()),
    row('Payload', fmt.bytes(track.byteLength)),
    row('Bitrate', fmt.bitrate(track.bitrateBps)),
    row('Chunk offsets', track.chunkOffsetBox ? `${track.chunkOffsetBox} · ${track.chunkCount} chunks` : '—'),
  ];

  if (track.kind === 'video') {
    items.push(
      row('Coded size', fmt.dimensions(track.codedWidth, track.codedHeight)),
      row('Display size', fmt.dimensions(track.displayWidth, track.displayHeight)),
      row('Oriented size', fmt.dimensions(track.orientedWidth, track.orientedHeight)),
      row('Rotation', `${track.rotationDegrees}°`),
      row('Frame rate mode', timingLabel(track)),
      row('Nominal rate', fmt.fps(track.timing.nominalFps)),
      row('Average rate', fmt.fps(track.timing.avgFps)),
      row('Rate range', `${fmt.fps(track.timing.minFps)} — ${fmt.fps(track.timing.maxFps)}`),
      row('stts entries', String(track.timing.entryCount)),
      row('Distinct frame gaps', String(track.timing.distinctDeltas)),
      row('Dominant gap share', fmt.percent(track.timing.dominantShare)),
      row('Profile', track.video?.profile ?? '—'),
      row('Level', track.video?.level ?? '—'),
      row('Chroma', track.video?.chromaFormat ?? '—'),
      row('Bit depth', track.video?.bitDepth ? `${track.video.bitDepth}-bit` : '—'),
      row('colr box', track.color.present ? (track.color.type ?? 'present') : 'absent'),
      row('Primaries', track.color.primariesLabel),
      row('Transfer', track.color.transferLabel),
      row('Matrix', track.color.matrixLabel),
      row('Range', track.color.fullRange === null ? '—' : track.color.fullRange ? 'full' : 'limited'),
    );
  }

  if (track.kind === 'audio') {
    items.push(
      row('Profile', track.audio?.profile ?? '—'),
      row('Sample rate', track.audio?.sampleRate ? `${track.audio.sampleRate} Hz` : '—'),
      row('Channels', track.audio?.channels ? String(track.audio.channels) : '—'),
      row('Declared bitrate', fmt.bitrate(track.audio?.declaredBitrateBps ?? null)),
    );
  }

  items.push(
    row('Edit list', track.editList.present ? `${track.editList.entryCount} entry(ies)${track.editList.nonTrivial ? ' · non-trivial' : ''}` : 'none'),
    row('Sample descriptions', String(track.sampleEntryCount)),
  );

  return el('details', { class: 'track', attrs: { open: index === 0 } }, [
    el('summary', { class: 'track-summary' }, [
      el('span', { class: 'track-kind', text: track.kind }),
      el('span', { class: 'track-codec', text: track.codecLabel }),
      el('span', {
        class: 'track-extra',
        text:
          track.kind === 'video'
            ? `${fmt.dimensions(track.orientedWidth, track.orientedHeight)} · ${fmt.fps(track.timing.nominalFps)}`
            : fmt.duration(track.durationSec),
      }),
    ]),
    el('div', { class: 'summary' }, items),
  ]);
}

/** Top-level box layout, which is what makes faststart and fragmentation visible. */
export function renderBoxLayout(report: MediaReport): HTMLElement {
  const total = report.fileSize || 1;
  return el('div', { class: 'boxes' }, [
    el(
      'div',
      { class: 'box-bar' },
      report.topLevel.map((box) =>
        el('div', {
          class: `box-seg box-${box.type.replace(/[^a-z0-9]/gi, '')}`,
          style: { width: `${Math.max(0.4, (box.size / total) * 100)}%` },
          title: `${box.type} — ${fmt.bytes(box.size)} at offset ${box.start}`,
        }),
      ),
    ),
    el(
      'div',
      { class: 'box-legend' },
      report.topLevel.slice(0, 8).map((box) =>
        el('span', { class: 'box-tag' }, [
          el('code', { text: box.type }),
          el('span', { class: 'muted', text: fmt.bytes(box.size) }),
        ]),
      ),
    ),
  ]);
}

/** Before/after, so the claim that something improved is checkable. */
export function renderComparison(before: MediaReport, after: MediaReport): HTMLElement {
  const delta = fmt.sizeDelta(before.fileSize, after.fileSize);

  const compare = (
    label: string,
    left: string,
    right: string,
    improved?: boolean,
  ): HTMLElement =>
    el('div', { class: 'compare-row' }, [
      el('span', { class: 'compare-label', text: label }),
      el('span', { class: 'compare-before', text: left }),
      el('span', { class: 'compare-arrow', text: '→' }),
      el('span', {
        class: `compare-after${improved === undefined ? '' : improved ? ' tone-good' : ' tone-warn'}`,
        text: right,
      }),
    ]);

  const rows: Child[] = [
    compare('Size', fmt.bytes(before.fileSize), `${fmt.bytes(after.fileSize)} (${delta.text})`),
    compare(
      'Index',
      before.faststart ? 'front' : 'end of file',
      after.faststart ? 'front' : 'end of file',
      after.faststart,
    ),
  ];

  if (before.video && after.video) {
    rows.push(
      compare(
        'Frame timing',
        timingLabel(before.video),
        timingLabel(after.video),
        after.video.timing.mode === 'cfr',
      ),
      compare(
        'Frame size',
        fmt.dimensions(before.video.orientedWidth, before.video.orientedHeight),
        fmt.dimensions(after.video.orientedWidth, after.video.orientedHeight),
      ),
      compare(
        'Frame rate',
        fmt.fps(before.video.timing.nominalFps ?? before.video.timing.avgFps),
        fmt.fps(after.video.timing.nominalFps ?? after.video.timing.avgFps),
      ),
      compare('Codec', before.video.codecLabel, after.video.codecLabel),
      compare(
        'Colour',
        colorLabel(before.video),
        colorLabel(after.video),
        !isUnspecifiedColor(after.video.color) && !after.video.color.isHdr,
      ),
      compare('Video bitrate', fmt.bitrate(before.video.bitrateBps), fmt.bitrate(after.video.bitrateBps)),
    );

    // For a stream copy this should read "identical", and that is the whole promise.
    const identical = before.video.byteLength === after.video.byteLength;
    rows.push(
      compare(
        'Video payload',
        fmt.bytes(before.video.byteLength),
        identical ? 'identical, byte for byte' : fmt.bytes(after.video.byteLength),
        identical,
      ),
    );
  }

  return el('div', { class: 'compare' }, rows);
}
