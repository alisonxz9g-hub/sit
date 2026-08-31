/**
 * Delivery targets and bitrate guidance.
 *
 * A caveat worth stating plainly, because the whole app rests on it: the numbers
 * here are heuristics, not published specification. No social platform documents its
 * internal encoding ladder, and any tool claiming to know it exactly is guessing too.
 * What these values encode is the uncontroversial part: give the platform's encoder a
 * clean, correctly tagged, constant-frame-rate source at a resolution it does not have
 * to resample, with enough bitrate headroom that its own quantiser is the only thing
 * degrading the image.
 */

export type Orientation = 'portrait' | 'landscape' | 'square';

export interface TargetProfile {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly orientation: Orientation;
}

/**
 * Resolutions worth landing exactly on. Anything else forces the platform to rescale,
 * and a rescale it chooses is always worse than one you control.
 */
export const TARGETS: readonly TargetProfile[] = [
  { id: 'portrait-1080', label: '1080 x 1920 (9:16)', width: 1080, height: 1920, orientation: 'portrait' },
  { id: 'portrait-720', label: '720 x 1280 (9:16)', width: 720, height: 1280, orientation: 'portrait' },
  { id: 'landscape-1080', label: '1920 x 1080 (16:9)', width: 1920, height: 1080, orientation: 'landscape' },
  { id: 'landscape-720', label: '1280 x 720 (16:9)', width: 1280, height: 720, orientation: 'landscape' },
  { id: 'square-1080', label: '1080 x 1080 (1:1)', width: 1080, height: 1080, orientation: 'square' },
];

/** Frame rates that survive the trip unchanged. */
export const SUPPORTED_FPS = [24, 25, 30, 50, 60] as const;

/**
 * Highest frame rate worth keeping. Above this the platform decimates, and a
 * decimation you did not choose can land on the wrong frames.
 */
export const MAX_FPS = 60;

/**
 * Bits per pixel per frame.
 *
 * `SOFT` is the point below which a source is visibly starved before anyone
 * re-encodes it; re-encoding cannot put back what was never recorded. `TARGET` is
 * what we aim for when re-encoding, chosen high enough that the export is
 * effectively transparent and the platform's encoder is the only lossy step left.
 */
const BPP_SOFT = 0.06;
const BPP_TARGET = 0.2;

/** Ceiling so a short 4K clip cannot ask for an absurd bitrate. */
const MAX_TARGET_BPS = 40_000_000;
const MIN_TARGET_BPS = 2_000_000;

export function orientationOf(width: number, height: number): Orientation {
  if (width === height) return 'square';
  return height > width ? 'portrait' : 'landscape';
}

/** Bitrate below which the source is starved regardless of what we do to it. */
export function softBitrateBps(width: number, height: number, fps: number): number {
  return Math.round(width * height * fps * BPP_SOFT);
}

/** Bitrate to aim for when re-encoding, clamped to something sane. */
export function targetBitrateBps(width: number, height: number, fps: number): number {
  const raw = width * height * fps * BPP_TARGET;
  return Math.round(Math.min(MAX_TARGET_BPS, Math.max(MIN_TARGET_BPS, raw)));
}

/**
 * Nearest target with the same orientation, by pixel count. Returns null when the
 * source already sits on a target exactly.
 */
export function nearestTarget(width: number, height: number): TargetProfile | null {
  const orientation = orientationOf(width, height);
  const candidates = TARGETS.filter((t) => t.orientation === orientation);
  if (candidates.length === 0) return null;

  const exact = candidates.find((t) => t.width === width && t.height === height);
  if (exact) return null;

  const pixels = width * height;
  return candidates.reduce((best, t) =>
    Math.abs(t.width * t.height - pixels) < Math.abs(best.width * best.height - pixels) ? t : best,
  );
}

export function isOnTarget(width: number, height: number): boolean {
  return TARGETS.some((t) => t.width === width && t.height === height);
}

/** Closest supported frame rate at or below the source rate, capped at MAX_FPS. */
export function nearestSupportedFps(fps: number): number {
  const capped = Math.min(fps, MAX_FPS);
  let best = SUPPORTED_FPS[0] as number;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of SUPPORTED_FPS) {
    const delta = Math.abs(candidate - capped);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  return best;
}

/**
 * Audio target. 48 kHz stereo AAC-LC is what every mobile pipeline expects; anything
 * else gets resampled or upmixed somewhere along the way.
 */
export const AUDIO_TARGET = {
  codec: 'AAC-LC',
  sampleRate: 48_000,
  channels: 2,
  bitrateBps: 256_000,
} as const;

/**
 * H.264 settings the widest range of decoders accept. High profile is universally
 * supported on the web upload path and compresses better than Main; 4:2:0 8-bit is
 * the only chroma format that is safe everywhere.
 */
export const VIDEO_TARGET = {
  codec: 'H.264 / AVC',
  profile: 'high',
  chromaFormat: '4:2:0',
  bitDepth: 8,
} as const;
