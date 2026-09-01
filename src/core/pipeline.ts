/**
 * Builds the ffmpeg invocation for each mode from what the analysis actually found,
 * rather than applying a fixed recipe to every file.
 *
 * Three modes, cheapest first:
 *
 *   remux   Rebuilds the container and moves the index to the front. Stream copy, so
 *           the pixels and samples are bit-identical. Seconds, whatever the length.
 *   retag   A remux that also writes the Rec.709 colour tags. Still a stream copy:
 *           the tags live in a container box, the bitstream is untouched. Verified
 *           against ffmpeg 9 that `-c copy` does carry the colour options through to
 *           the muxer, which is not true when encoding.
 *   master  A real re-encode. The only mode that can change frame timing, resolution
 *           or chroma format, and the only one that costs quality. Used when the
 *           source is variable frame rate, off the delivery ladder, or not 4:2:0.
 *
 * Nothing here writes a deliberately malformed file. Every output is a spec-valid MP4
 * that any player, uploader or validator will accept.
 */
import type { MasterPlan } from './diagnose';
import { planMaster } from './diagnose';
import type { MediaReport } from './mp4/index';
import { AUDIO_TARGET } from './targets';

export type PipelineMode = 'remux' | 'retag' | 'master';

export interface PipelineStep {
  readonly label: string;
  readonly detail: string;
}

export interface PipelinePlan {
  readonly mode: PipelineMode;
  /** Argument list, excluding the trailing output name. `{input}` is substituted. */
  readonly args: readonly string[];
  readonly outputName: string;
  /** True when no sample is re-encoded. */
  readonly lossless: boolean;
  readonly steps: readonly PipelineStep[];
  /** Encode settings, for `master` only. */
  readonly master: MasterPlan | null;
}

/**
 * x264 preset. Deliberately fast rather than slow: this runs in WebAssembly at a
 * fraction of native speed, and at the bitrates we target a slower preset buys a
 * difference nobody can see for several times the wait.
 */
const X264_PRESET = 'veryfast';

/**
 * Constant rate factor. 18 is visually transparent for delivery material, and the
 * bitrate cap below is what actually binds on complex footage.
 */
const X264_CRF = 18;

const BT709_COPY_FLAGS = [
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-colorspace', 'bt709',
];

const BT709_FILTER = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';

function mbps(bps: number): string {
  return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}

/** Stream selection shared by every mode. */
function mapArgs(report: MediaReport): string[] {
  const args = ['-map', '0:v:0'];
  if (report.audio) args.push('-map', '0:a:0');
  return args;
}

function buildRemux(report: MediaReport, retag: boolean): PipelinePlan {
  // Deliberately minimal. An earlier version added `-avoid_negative_ts make_zero`
  // believing it would drop the edit list; measured against ffmpeg 9 it replaces one
  // benign delay-compensation entry with two, including an empty edit that inserts
  // blank presentation time. Plain stream copy preserves the source timeline exactly,
  // which is what a lossless remux should mean.
  const args = [
    '-i', '{input}',
    ...mapArgs(report),
    '-c', 'copy',
    ...(retag ? BT709_COPY_FLAGS : []),
    '-movflags', '+faststart',
  ];

  const steps: PipelineStep[] = [
    {
      label: 'Copy streams',
      detail: 'Video and audio are copied sample for sample. Nothing is re-encoded.',
    },
    {
      label: 'Move index to the front',
      detail: 'The moov index is written before the media so readers do not have to seek.',
    },
  ];

  if (retag) {
    steps.splice(1, 0, {
      label: 'Tag colour as Rec.709',
      detail:
        'Writes the colour primaries, transfer function and matrix into the container. ' +
        'This is metadata only; not a single pixel changes.',
    });
  }

  if (!report.audio) {
    steps.push({
      label: 'No audio track',
      detail: 'The source is silent, so none is written.',
    });
  }

  return {
    mode: retag ? 'retag' : 'remux',
    args,
    outputName: 'output.mp4',
    lossless: true,
    steps,
    master: null,
  };
}

function buildMaster(report: MediaReport): PipelinePlan {
  const video = report.video;
  if (!video) {
    throw new Error('A re-encode needs a video track, and this file has none.');
  }

  const plan = planMaster(video);
  const filters: string[] = [];
  const steps: PipelineStep[] = [];

  if (plan.scaled) {
    // Lanczos costs little at these sizes and holds edges better than the default
    // bicubic, which matters because this frame gets scaled again downstream.
    filters.push(`scale=${plan.width}:${plan.height}:flags=lanczos`);
    steps.push({
      label: `Scale to ${plan.width}x${plan.height}`,
      detail:
        'Lands the frame exactly on a delivery resolution so nothing downstream has to ' +
        'resample it. Scaled with Lanczos rather than the default filter.',
    });
  } else {
    // 4:2:0 needs both dimensions even. This is a no-op when they already are.
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }

  // Re-tagging on a re-encode has to go through the filter graph: the encoder
  // overwrites the stream-level colour options, so `-color_primaries` alone would be
  // silently dropped. Only claim Rec.709 when the source is not HDR.
  if (!video.color.isHdr) {
    filters.push(BT709_FILTER);
    steps.push({
      label: 'Tag colour as Rec.709',
      detail: 'Removes the guesswork for every player and encoder downstream.',
    });
  }

  filters.push('format=yuv420p');

  const args = [
    '-i', '{input}',
    ...mapArgs(report),
    '-vf', filters.join(','),
    // Forces an even frame grid. Duplicates or drops frames as needed, which is the
    // entire point when the source timing is uneven.
    '-fps_mode', 'cfr',
    '-r', String(plan.fps),
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', X264_PRESET,
    '-crf', String(X264_CRF),
    '-maxrate', String(plan.bitrateBps),
    '-bufsize', String(plan.bitrateBps * 2),
    '-pix_fmt', 'yuv420p',
    // Two-second keyframe interval, which is what adaptive players expect and what
    // keeps a re-encode downstream from having to insert its own.
    '-x264-params', `keyint=${plan.fps * 2}:min-keyint=${plan.fps}:scenecut=40`,
  ];

  steps.push({
    label: `Encode H.264 High at ${plan.fps} fps`,
    detail:
      `Constant frame rate, capped at ${mbps(plan.bitrateBps)}, CRF ${X264_CRF}. ` +
      'High bitrate on purpose: this file is an intermediate, and the platform re-encode ' +
      'is the step that has to look good.',
  });

  if (report.audio) {
    args.push(
      '-c:a', 'aac',
      '-b:a', String(AUDIO_TARGET.bitrateBps),
      '-ar', String(AUDIO_TARGET.sampleRate),
      '-ac', String(AUDIO_TARGET.channels),
    );
    steps.push({
      label: 'Encode AAC-LC 48 kHz stereo',
      detail: `At ${AUDIO_TARGET.bitrateBps / 1000} kbps, well past the point of audible loss.`,
    });
  }

  args.push('-movflags', '+faststart');
  steps.push({
    label: 'Move index to the front',
    detail: 'The moov index is written before the media data.',
  });

  return {
    mode: 'master',
    args,
    outputName: 'output.mp4',
    lossless: false,
    steps,
    master: plan,
  };
}

export function buildPlan(report: MediaReport, mode: PipelineMode): PipelinePlan {
  switch (mode) {
    case 'remux':
      return buildRemux(report, false);
    case 'retag':
      return buildRemux(report, true);
    case 'master':
      return buildMaster(report);
  }
}

/**
 * Very rough wall-clock guess, so the UI can set expectations before a run that might
 * take minutes. Stream copies are IO-bound and quick; encodes are not.
 */
export function estimateSeconds(report: MediaReport, mode: PipelineMode): number {
  const duration = report.durationSec || 1;
  if (mode !== 'master') {
    // Dominated by reading and writing the file, not by ffmpeg.
    return Math.max(2, Math.round((report.fileSize / 1_000_000) * 0.08));
  }

  const video = report.video;
  const pixels = (video?.orientedWidth ?? 1080) * (video?.orientedHeight ?? 1920);
  const fps = video?.timing.nominalFps ?? 30;
  // Calibrated loosely against the single-threaded wasm build: roughly two million
  // pixels per second of throughput at this preset.
  const framesToEncode = duration * Math.min(fps, 60);
  return Math.max(5, Math.round((pixels * framesToEncode) / 2_000_000));
}

export function describeMode(mode: PipelineMode): { title: string; summary: string } {
  switch (mode) {
    case 'remux':
      return {
        title: 'Remux',
        summary: 'Rebuild the container and move the index to the front. Lossless, seconds.',
      };
    case 'retag':
      return {
        title: 'Remux + colour tags',
        summary: 'Everything remux does, plus Rec.709 tagging. Still lossless.',
      };
    case 'master':
      return {
        title: 'Re-encode',
        summary:
          'Normalise frame timing, resolution and chroma at a high bitrate. The only ' +
          'mode that can fix timing, and the only one that costs quality.',
      };
  }
}
