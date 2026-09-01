/**
 * Chooses how to process a file, from what the analysis actually found rather than by
 * applying a fixed recipe.
 *
 * Three modes, cheapest first:
 *
 *   remux   Rebuilds the container and moves the index to the front. The media payload
 *           is copied verbatim, so pixels and samples are bit-identical.
 *   retag   A remux that also writes the Rec.709 colour tags. Still lossless: the tags
 *           live in a container box and the bitstream is untouched.
 *   master  A real re-encode. The only mode that can change frame timing, resolution or
 *           chroma format, and the only one that costs quality. Used when the source is
 *           variable frame rate, off the delivery ladder, or not 4:2:0.
 *
 * The first two run on our own box writer, in milliseconds, with no engine download at
 * all. That matters more than it sounds: an earlier version routed every mode through a
 * WebAssembly build of ffmpeg, so moving an index to the front of a 33 MB file meant
 * fetching 31 MB of engine and loading the whole video into wasm memory. The same job
 * natively is arithmetic over a few thousand integers and takes about 20 ms. ffmpeg is
 * still there for re-encodes, and as a fallback for container layouts the native writer
 * refuses to touch.
 *
 * Nothing here writes a deliberately malformed file. Every output is a spec-valid MP4
 * that any player, uploader or validator will accept.
 */
import type { MasterPlan } from './diagnose';
import { planMaster } from './diagnose';
import type { MediaReport } from './mp4/index';
import { canApplyObserved } from './observed';
import { canRemuxNatively } from './remux';
import { AUDIO_TARGET } from './targets';

/**
 * `observed` is the odd one out: a replication of a third-party container trick that
 * deliberately writes a file outside the ISO BMFF spec. It is never recommended
 * automatically and always carries its compliance status in the UI. See ./observed.ts.
 */
export type PipelineMode = 'remux' | 'retag' | 'master' | 'observed';

/**
 * Which implementation runs the job.
 * - `native` uses our own MP4 writer: no download, no wasm, milliseconds.
 * - `ffmpeg` uses ffmpeg.wasm: needed for re-encodes, and for container layouts the
 *   native writer declines.
 */
export type PipelineEngine = 'native' | 'ffmpeg';

export interface PipelineStep {
  readonly label: string;
  readonly detail: string;
}

export interface PipelinePlan {
  readonly mode: PipelineMode;
  readonly engine: PipelineEngine;
  /**
   * Argument list for the ffmpeg path, excluding the trailing output name. `{input}` is
   * substituted at run time. Empty for native plans.
   */
  readonly args: readonly string[];
  readonly outputName: string;
  /** True when no sample is re-encoded. */
  readonly lossless: boolean;
  readonly steps: readonly PipelineStep[];
  /** Encode settings, for `master` only. */
  readonly master: MasterPlan | null;
  /** Set when a lossless mode had to fall back to ffmpeg, with the reason. */
  readonly fallbackReason: string | null;
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
  const native = canRemuxNatively(report);
  const mode: PipelineMode = retag ? 'retag' : 'remux';

  const steps: PipelineStep[] = native.supported
    ? nativeSteps(report, retag)
    : ffmpegRemuxSteps(report, retag, native.reason);

  // The ffmpeg argument list is built either way, so the UI can always show a command
  // and so the fallback needs no second code path.
  //
  // Deliberately minimal. An earlier version added `-avoid_negative_ts make_zero`
  // believing it would drop the edit list; measured against ffmpeg 9 it replaces one
  // benign delay-compensation entry with two, including an empty edit that inserts blank
  // presentation time. Plain stream copy preserves the source timeline exactly, which is
  // what a lossless remux should mean.
  const args = [
    '-i', '{input}',
    ...mapArgs(report),
    '-c', 'copy',
    ...(retag ? BT709_COPY_FLAGS : []),
    '-movflags', '+faststart',
  ];

  return {
    mode,
    engine: native.supported ? 'native' : 'ffmpeg',
    args,
    outputName: 'output.mp4',
    lossless: true,
    steps,
    master: null,
    fallbackReason: native.supported ? null : native.reason,
  };
}

function nativeSteps(report: MediaReport, retag: boolean): PipelineStep[] {
  const steps: PipelineStep[] = [
    {
      label: 'Rewrite the index',
      detail:
        'The moov index is rebuilt with every chunk offset corrected for its new ' +
        'position, then written before the media instead of after it.',
    },
  ];

  if (retag) {
    steps.push({
      label: 'Tag colour as Rec.709',
      detail:
        'Writes the colour primaries, transfer function and matrix into the video ' +
        'sample entry. Metadata only; not a single pixel changes.',
    });
  }

  steps.push({
    label: 'Reference the payload, do not copy it',
    detail:
      'The media is attached as a slice of the original file, so those bytes go straight ' +
      'to the download without passing through memory. This is why a 500 MB file costs ' +
      'no more than a small one.',
  });

  if (!report.audio) {
    steps.push({ label: 'No audio track', detail: 'The source is silent, so none is written.' });
  }

  return steps;
}

function ffmpegRemuxSteps(report: MediaReport, retag: boolean, reason: string): PipelineStep[] {
  const steps: PipelineStep[] = [
    {
      label: 'Use the transcoding engine',
      detail:
        `The direct rewriter declined this file because ${reason}. ffmpeg handles it ` +
        'instead, which means downloading the engine first.',
    },
    {
      label: 'Copy streams',
      detail: 'Video and audio are copied sample for sample. Nothing is re-encoded.',
    },
  ];

  if (retag) {
    steps.push({
      label: 'Tag colour as Rec.709',
      detail: 'Colour metadata is written into the container. No pixel changes.',
    });
  }

  steps.push({
    label: 'Move index to the front',
    detail: 'The moov index is written before the media so readers do not have to seek.',
  });

  if (!report.audio) {
    steps.push({ label: 'No audio track', detail: 'The source is silent, so none is written.' });
  }

  return steps;
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
    engine: 'ffmpeg',
    args,
    outputName: 'output.mp4',
    lossless: false,
    steps,
    master: plan,
    fallbackReason: null,
  };
}

function buildObserved(report: MediaReport): PipelinePlan {
  const support = canApplyObserved(report);

  const steps: PipelineStep[] = [
    {
      label: 'Rewrite the index and strip edit lists',
      detail:
        'The moov index moves to the front with every chunk offset corrected, and edts/elst ' +
        'boxes are removed from all tracks.',
    },
    {
      label: 'Clone the AAC track under a new track_ID',
      detail:
        'The audio track is duplicated and given the next free track_ID, with mvhd\u2019s ' +
        'next_track_ID advanced to match.',
    },
    {
      label: 'Append nine artificial samples per real sample',
      detail:
        'Each is 8 bytes of 00 00 00 04 00 00 00 00 lasting one tick. The clone\u2019s stts, ' +
        'stsc, stsz, stco and mdhd duration are all extended to stay consistent.',
    },
    {
      label: 'Place those bytes outside the mdat box',
      detail:
        'This is the step that makes the file non-compliant: the bytes sit past the declared ' +
        'end of mdat, outside any box. A strict parser reads 00 00 00 04 as a box size of 4 ' +
        'and rejects it as smaller than the mandatory 8-byte header.',
    },
    {
      label: 'Copy the video stream verbatim',
      detail:
        'No re-encode. The media payload is referenced as a slice of your file, so the video ' +
        'elementary stream is bit-identical \u2014 confirmed by SHA-256 in the test suite.',
    },
  ];

  return {
    mode: 'observed',
    engine: 'native',
    args: [],
    outputName: 'output.mp4',
    // Nothing is re-encoded, so the media is lossless even though the container is not valid.
    lossless: true,
    steps,
    master: null,
    fallbackReason: support.supported ? null : support.reason,
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
    case 'observed':
      return buildObserved(report);
  }
}

/**
 * Very rough wall-clock guess, so the UI can set expectations before a run that might
 * take minutes.
 *
 * The native path is fast enough that the only real cost is the browser writing the
 * output, so it is reported as effectively instant. An ffmpeg stream copy has to move the
 * whole file into wasm memory first, and an encode is in another league entirely.
 */
export function estimateSeconds(report: MediaReport, mode: PipelineMode): number {
  const duration = report.durationSec || 1;

  if (mode === 'observed') {
    // Same class of work as a native remux, plus building the artificial tail.
    return Math.max(0.3, (report.fileSize / 1_000_000) * 0.008);
  }

  if (mode !== 'master') {
    const plan = buildPlan(report, mode);
    if (plan.engine === 'native') {
      // Measured at about 20 ms for a 33 MB file, dominated by reading the index.
      return Math.max(0.2, (report.fileSize / 1_000_000) * 0.002);
    }
    // Dominated by shuttling the file through wasm memory, not by ffmpeg itself.
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

/**
 * Mode description, adjusted for how the job will actually run. Passing the report lets
 * the copy say "instantly, no download" when that is true instead of hedging.
 */
export function describeMode(
  mode: PipelineMode,
  report?: MediaReport,
): { title: string; summary: string } {
  const engine = report ? buildPlan(report, mode).engine : null;

  switch (mode) {
    case 'remux':
      return {
        title: 'Remux',
        summary:
          engine === 'native'
            ? 'Rewrite the index and move it to the front. Lossless, instant, no engine download.'
            : 'Rebuild the container and move the index to the front. Lossless.',
      };
    case 'retag':
      return {
        title: 'Remux + colour tags',
        summary:
          engine === 'native'
            ? 'Everything remux does, plus Rec.709 tagging. Still lossless and instant.'
            : 'Everything remux does, plus Rec.709 tagging. Still lossless.',
      };
    case 'master':
      return {
        title: 'Re-encode',
        summary:
          'Normalise frame timing, resolution and chroma at a high bitrate. The only ' +
          'mode that can fix timing, the only one that costs quality, and the only one ' +
          'that needs the 31 MB engine.',
      };
    case 'observed':
      return {
        title: 'Observed transform',
        summary:
          'Replicates a third-party container trick: clones the AAC track and appends nine ' +
          'artificial samples per real one, outside the mdat box. Your video is untouched, ' +
          'but the file is deliberately not valid MP4.',
      };
  }
}
