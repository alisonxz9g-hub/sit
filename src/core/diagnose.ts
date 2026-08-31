/**
 * Turns a structural report into findings a person can act on.
 *
 * Each finding names the consequence rather than the box, says what the measurement
 * actually was, and points at the cheapest stage that fixes it. Some findings point
 * at `reexport`, meaning no amount of processing here can help and only a better
 * export from the editor will: saying so is more useful than running a re-encode that
 * produces a larger file with the same missing detail.
 */
import { AVC_FORMATS, HEVC_FORMATS, isUnspecifiedColor } from './mp4/index';
import type { MediaReport, Track } from './mp4/index';
import {
  AUDIO_TARGET,
  MAX_FPS,
  isOnTarget,
  nearestSupportedFps,
  nearestTarget,
  orientationOf,
  softBitrateBps,
  targetBitrateBps,
} from './targets';

export type Severity = 'blocker' | 'warning' | 'note';

/**
 * Cheapest stage that resolves a finding.
 * - `remux`   rewrites the container, lossless, seconds
 * - `retag`   remux plus corrected colour tags, still lossless
 * - `master`  full re-encode, slow, the only way to change frame timing or size
 * - `reexport` nothing here can fix it; the source itself is the problem
 * - `none`    informational
 */
export type FixMode = 'remux' | 'retag' | 'master' | 'reexport' | 'none';

export interface Finding {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  /** The concrete measurement behind the finding. */
  readonly evidence: string;
  readonly fix: FixMode;
}

export interface Diagnosis {
  readonly findings: readonly Finding[];
  /** Cheapest mode that addresses every fixable finding. */
  readonly recommended: Exclude<FixMode, 'reexport'>;
  /** True when the file is already in good shape. */
  readonly clean: boolean;
  /** Findings that no processing stage can resolve. */
  readonly needsReexport: readonly Finding[];
}

/* ------------------------------------------------------------------ helpers --- */

function mbps(bps: number | null): string {
  if (bps === null) return 'unknown';
  return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}

function fpsLabel(fps: number | null): string {
  if (fps === null) return 'unknown';
  return Number.isInteger(fps) ? `${fps} fps` : `${fps.toFixed(2)} fps`;
}

/** Ranked cheapest to most expensive, so `recommended` can take a maximum. */
const MODE_COST: Record<Exclude<FixMode, 'reexport'>, number> = {
  none: 0,
  remux: 1,
  retag: 2,
  master: 3,
};

/* ----------------------------------------------------------------- findings --- */

function containerFindings(report: MediaReport): Finding[] {
  const found: Finding[] = [];

  if (report.fragmented) {
    found.push({
      id: 'fragmented',
      severity: 'blocker',
      title: 'Fragmented container',
      detail:
        'The file stores its media in moof fragments instead of one flat mdat. Some ' +
        'uploaders reject this outright, and the ones that accept it often mis-read ' +
        'the duration. A lossless remux flattens it.',
      evidence: 'moof fragments present',
      fix: 'remux',
    });
  }

  if (!report.faststart && !report.fragmented) {
    found.push({
      id: 'no-faststart',
      severity: 'warning',
      title: 'Index at the end of the file',
      detail:
        'The moov index sits after the media data, so anything reading the file has to ' +
        'seek to the end before it can start. On a slow upload this is the difference ' +
        'between a file that starts processing immediately and one that stalls.',
      evidence: 'moov follows mdat',
      fix: 'remux',
    });
  }

  if (report.video && report.video.sampleEntryCount > 1) {
    found.push({
      id: 'multiple-sample-entries',
      severity: 'blocker',
      title: 'Mixed codecs in one track',
      detail:
        'The video track declares more than one sample description, meaning the codec ' +
        'or its parameters change partway through. A re-encode normalises it; a stream ' +
        'copy would carry the problem forward.',
      evidence: `${report.video.sampleEntryCount} sample descriptions`,
      fix: 'master',
    });
  }

  return found;
}

function timingFindings(video: Track): Finding[] {
  const found: Finding[] = [];
  const { timing } = video;

  if (timing.mode === 'vfr') {
    found.push({
      id: 'vfr',
      severity: 'warning',
      title: 'Variable frame rate',
      detail:
        'Frame gaps are uneven, which is normal for screen recordings and phone ' +
        'cameras but the single most common cause of judder after a platform ' +
        're-encode: its encoder assumes a constant rate and resamples your timing to ' +
        'get one. Converting to constant frame rate here means you choose where frames ' +
        'land instead of it.',
      evidence:
        `${timing.distinctDeltas} distinct frame durations, ` +
        `${(timing.dominantShare * 100).toFixed(1)}% on the most common one ` +
        `(${fpsLabel(timing.minFps)} to ${fpsLabel(timing.maxFps)})`,
      fix: 'master',
    });
  } else if (timing.mode === 'near-cfr') {
    found.push({
      id: 'near-cfr',
      severity: 'note',
      title: 'Nearly constant frame rate',
      detail:
        'A small number of frames sit off the grid. This is usually harmless and often ' +
        'just the final frame, so it is not worth a re-encode on its own.',
      evidence: `${(timing.dominantShare * 100).toFixed(1)}% of frames at ${fpsLabel(timing.nominalFps)}`,
      fix: 'none',
    });
  }

  const fps = timing.nominalFps ?? timing.avgFps;
  if (fps !== null && fps > MAX_FPS + 0.5) {
    found.push({
      id: 'fps-above-target',
      severity: 'note',
      title: 'Frame rate above what survives upload',
      detail:
        `Anything above ${MAX_FPS} fps gets decimated on the way through. Doing it here ` +
        'lets you pick a clean divisor instead of letting the platform drop whichever ' +
        'frames it likes.',
      evidence: `${fpsLabel(fps)} source, ${fpsLabel(nearestSupportedFps(fps))} recommended`,
      fix: 'master',
    });
  }

  if (video.editList.present && video.editList.nonTrivial) {
    found.push({
      id: 'edit-list',
      severity: 'note',
      title: 'Non-trivial edit list',
      detail:
        'The track carries an edit list that shifts or trims the media timeline. ' +
        'Players honour it, but re-encoders vary, and a mishandled edit list shows up ' +
        'as audio drifting out of sync. A re-encode bakes the intended timeline in.',
      evidence:
        `${video.editList.entryCount} edit(s), first media time ${video.editList.firstMediaTime}`,
      fix: 'master',
    });
  }

  return found;
}

function colorFindings(video: Track): Finding[] {
  const found: Finding[] = [];
  const { color } = video;

  if (color.isHdr) {
    found.push({
      id: 'hdr-source',
      severity: 'warning',
      title: 'HDR source',
      detail:
        'This is tagged as HDR. Delivered as-is into an SDR pipeline it usually comes ' +
        'back grey and flat, because the conversion gets done by whatever is cheapest ' +
        'rather than by a tone mapping you approved. Converting HDR to SDR well needs ' +
        'decisions this tool should not make for you, so it is flagged rather than ' +
        'silently changed.',
      evidence:
        `transfer ${color.transferLabel}, primaries ${color.primariesLabel}` +
        (video.video?.bitDepth ? `, ${video.video.bitDepth}-bit` : ''),
      fix: 'reexport',
    });
  } else if (isUnspecifiedColor(color)) {
    found.push({
      id: 'untagged-color',
      severity: 'warning',
      title: 'Colour space not tagged',
      detail:
        'Nothing in the file says which colour space the pixels are in, so every player ' +
        'and encoder downstream guesses. That guess is why the same clip can look ' +
        'washed out in one place and oversaturated in another. Tagging it as Rec.709 ' +
        'costs nothing and does not touch a single pixel.',
      evidence: color.present
        ? `primaries ${color.primariesLabel}, transfer ${color.transferLabel}, matrix ${color.matrixLabel}`
        : 'no colr box',
      fix: 'retag',
    });
  }

  return found;
}

function codecFindings(video: Track): Finding[] {
  const found: Finding[] = [];

  if (HEVC_FORMATS.has(video.format)) {
    found.push({
      id: 'hevc-source',
      severity: 'note',
      title: 'HEVC source',
      detail:
        'HEVC uploads fine but gets transcoded to H.264 for delivery regardless, so the ' +
        'extra efficiency buys nothing here and costs compatibility with some uploaders. ' +
        'Re-encoding to H.264 High makes the path predictable.',
      evidence: `${video.codecLabel} in an ${video.format} sample entry`,
      fix: 'master',
    });
  } else if (!AVC_FORMATS.has(video.format)) {
    found.push({
      id: 'unusual-codec',
      severity: 'warning',
      title: 'Unusual video codec',
      detail:
        'This is neither H.264 nor HEVC. It may well upload, but the safe move is to ' +
        're-encode to H.264 High rather than find out during a launch.',
      evidence: `${video.codecLabel} (${video.format})`,
      fix: 'master',
    });
  }

  const chroma = video.video?.chromaFormat;
  if (chroma && chroma !== '4:2:0') {
    found.push({
      id: 'chroma-subsampling',
      severity: 'warning',
      title: `${chroma} chroma`,
      detail:
        'Anything other than 4:2:0 is rejected or silently converted by most consumer ' +
        'pipelines. Converting deliberately keeps the result predictable.',
      evidence: `${chroma}, ${video.video?.bitDepth ?? '?'}-bit`,
      fix: 'master',
    });
  }

  const depth = video.video?.bitDepth;
  if (depth !== null && depth !== undefined && depth > 8 && !video.color.isHdr) {
    found.push({
      id: 'high-bit-depth',
      severity: 'note',
      title: `${depth}-bit SDR source`,
      detail:
        'More than 8 bits per component with no HDR tagging. It will be reduced to ' +
        '8-bit somewhere; doing it here with dithering is kinder than a hard truncation.',
      evidence: `${depth}-bit, ${video.video?.profile ?? 'unknown profile'}`,
      fix: 'master',
    });
  }

  return found;
}

function resolutionFindings(video: Track): Finding[] {
  const found: Finding[] = [];
  const width = video.orientedWidth;
  const height = video.orientedHeight;
  if (width === null || height === null) return found;

  if (!isOnTarget(width, height)) {
    const suggestion = nearestTarget(width, height);
    found.push({
      id: 'resolution-off-target',
      severity: 'note',
      title: 'Resolution off the delivery ladder',
      detail:
        'The frame size does not match a rung the platform delivers, so it will be ' +
        'rescaled on the way through. Scaling it yourself with a good filter beats ' +
        'whatever the pipeline does in a hurry.',
      evidence: suggestion
        ? `${width}x${height} ${orientationOf(width, height)}, nearest rung ${suggestion.label}`
        : `${width}x${height} ${orientationOf(width, height)}`,
      fix: 'master',
    });
  }

  if (width % 2 !== 0 || height % 2 !== 0) {
    found.push({
      id: 'odd-dimensions',
      severity: 'blocker',
      title: 'Odd frame dimensions',
      detail:
        '4:2:0 chroma needs both dimensions even. Encoders either refuse this outright ' +
        'or pad it, and padding shows up as a one-pixel seam.',
      evidence: `${width}x${height}`,
      fix: 'master',
    });
  }

  return found;
}

function bitrateFindings(video: Track): Finding[] {
  const found: Finding[] = [];
  const width = video.orientedWidth;
  const height = video.orientedHeight;
  const fps = video.timing.nominalFps ?? video.timing.avgFps;
  if (width === null || height === null || fps === null || video.bitrateBps === null) return found;

  const soft = softBitrateBps(width, height, fps);
  if (video.bitrateBps < soft) {
    found.push({
      id: 'low-source-bitrate',
      severity: 'warning',
      title: 'Source bitrate is already low',
      detail:
        'There is less data here than this resolution and frame rate need, so the ' +
        'source is soft before anything else touches it. Worth being blunt: ' +
        're-encoding cannot add detail that was never recorded, and a higher bitrate ' +
        'would only make a bigger file with the same softness. Re-export from your ' +
        'editor at a higher bitrate instead.',
      evidence: `${mbps(video.bitrateBps)} measured, at least ${mbps(soft)} expected for ${width}x${height} at ${fpsLabel(fps)}`,
      fix: 'reexport',
    });
  }

  return found;
}

function audioFindings(report: MediaReport): Finding[] {
  const found: Finding[] = [];
  const audio = report.audio;

  if (!audio) {
    found.push({
      id: 'no-audio',
      severity: 'note',
      title: 'No audio track',
      detail:
        'Silent uploads are accepted, but some uploaders behave oddly with a missing ' +
        'audio track. Adding a silent stereo track avoids the question entirely.',
      evidence: 'video only',
      fix: 'none',
    });
    return found;
  }

  const problems: string[] = [];
  if (audio.format !== 'mp4a') problems.push(`codec ${audio.codecLabel}`);
  else if (audio.audio?.profile && audio.audio.profile !== 'AAC-LC') {
    problems.push(`profile ${audio.audio.profile}`);
  }
  if (audio.audio?.sampleRate && audio.audio.sampleRate !== AUDIO_TARGET.sampleRate) {
    problems.push(`${(audio.audio.sampleRate / 1000).toFixed(1)} kHz`);
  }
  if (audio.audio?.channels && audio.audio.channels !== AUDIO_TARGET.channels) {
    problems.push(`${audio.audio.channels} channel${audio.audio.channels === 1 ? '' : 's'}`);
  }

  if (problems.length > 0) {
    found.push({
      id: 'audio-off-target',
      severity: 'note',
      title: 'Audio off the expected format',
      detail:
        `The target everything downstream assumes is ${AUDIO_TARGET.codec} at ` +
        `${AUDIO_TARGET.sampleRate / 1000} kHz stereo. Off that, it gets resampled or ` +
        'upmixed by whatever handles it first, which is usually fine and occasionally ' +
        'is not.',
      evidence: problems.join(', '),
      fix: 'master',
    });
  }

  return found;
}

/* -------------------------------------------------------------- entry point --- */

export function diagnose(report: MediaReport): Diagnosis {
  const findings: Finding[] = [...containerFindings(report), ...audioFindings(report)];

  if (report.video) {
    findings.push(
      ...timingFindings(report.video),
      ...colorFindings(report.video),
      ...codecFindings(report.video),
      ...resolutionFindings(report.video),
      ...bitrateFindings(report.video),
    );
  }

  // Blockers first, then warnings, then notes, stable within each band.
  const order: Record<Severity, number> = { blocker: 0, warning: 1, note: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const fixable = findings.filter((f) => f.fix !== 'reexport' && f.fix !== 'none');
  const recommended = fixable.reduce<Exclude<FixMode, 'reexport'>>((worst, f) => {
    const mode = f.fix as Exclude<FixMode, 'reexport'>;
    return MODE_COST[mode] > MODE_COST[worst] ? mode : worst;
  }, 'none');

  return {
    findings,
    recommended,
    clean: findings.every((f) => f.severity === 'note') && recommended === 'none',
    needsReexport: findings.filter((f) => f.fix === 'reexport'),
  };
}

/** Suggested encode settings for `master` mode, derived from the source. */
export interface MasterPlan {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrateBps: number;
  readonly scaled: boolean;
  readonly rateChanged: boolean;
}

export function planMaster(video: Track): MasterPlan {
  const sourceWidth = video.orientedWidth ?? 1080;
  const sourceHeight = video.orientedHeight ?? 1920;
  const sourceFps = video.timing.nominalFps ?? video.timing.avgFps ?? 30;

  const target = nearestTarget(sourceWidth, sourceHeight);
  // Never upscale: it adds bytes and no detail. Only snap down to a rung.
  const useTarget = target !== null && target.width * target.height < sourceWidth * sourceHeight;
  const width = useTarget ? target.width : sourceWidth;
  const height = useTarget ? target.height : sourceHeight;

  const fps = nearestSupportedFps(sourceFps);

  return {
    width,
    height,
    fps,
    bitrateBps: targetBitrateBps(width, height, fps),
    scaled: width !== sourceWidth || height !== sourceHeight,
    rateChanged: Math.abs(fps - sourceFps) > 0.01,
  };
}
