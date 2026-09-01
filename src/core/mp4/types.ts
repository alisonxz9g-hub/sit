import type { TopLevelEntry } from './scan';

export type TrackKind = 'video' | 'audio' | 'subtitle' | 'other';

/** How evenly spaced the frames are. */
export type FrameRateMode = 'cfr' | 'near-cfr' | 'vfr' | 'unknown';

export interface FrameTiming {
  readonly mode: FrameRateMode;
  /** Sample count divided by media duration. What a player reports as "fps". */
  readonly avgFps: number | null;
  /** Frame rate implied by the reference (median) sample delta. */
  readonly nominalFps: number | null;
  /** Instantaneous extremes, useful for showing how wide the jitter is. */
  readonly minFps: number | null;
  readonly maxFps: number | null;
  /** Number of `stts` run-length entries. One means perfectly uniform. */
  readonly entryCount: number;
  /** How many distinct frame durations appear. */
  readonly distinctDeltas: number;
  /** Fraction of samples that use the single most common delta, 0..1. */
  readonly dominantShare: number;
  /**
   * Fraction of samples whose gap is within the quantisation tolerance of the reference
   * gap, 0..1. This, not `dominantShare`, decides `mode`.
   *
   * A 60 fps track in a microsecond timescale has to alternate between gaps of 16666 and
   * 16667 ticks, because 1000000/60 is not an integer. That is two distinct deltas and a
   * dominant share near 0.67, yet the frame rate is exactly constant. Counting samples
   * close to the reference instead of samples equal to the mode is what tells those
   * apart.
   */
  readonly steadyShare: number;
  /**
   * How much the frame gaps actually vary, as a percentage of the reference gap. This is
   * the number worth showing a person: 0.01% is timescale rounding, 40% is real jitter.
   */
  readonly jitterPercent: number;
}

export interface ColorInfo {
  /** False when the file carries no `colr` box at all. */
  readonly present: boolean;
  /** `nclx`, `nclc`, `rICC`, `prof`, or null. */
  readonly type: string | null;
  readonly primaries: number | null;
  readonly transfer: number | null;
  readonly matrix: number | null;
  readonly fullRange: boolean | null;
  readonly primariesLabel: string;
  readonly transferLabel: string;
  readonly matrixLabel: string;
  /** True when the transfer function is PQ or HLG. */
  readonly isHdr: boolean;
}

export interface VideoCodecInfo {
  readonly profile: string | null;
  readonly level: string | null;
  readonly chromaFormat: string | null;
  readonly bitDepth: number | null;
}

export interface AudioCodecInfo {
  readonly channels: number | null;
  readonly sampleRate: number | null;
  /** `AAC-LC`, `HE-AAC`, `HE-AACv2`, ... when it can be read from `esds`. */
  readonly profile: string | null;
  /** Average bitrate declared in `esds` or `btrt`, in bits per second. */
  readonly declaredBitrateBps: number | null;
}

export interface EditListInfo {
  readonly present: boolean;
  readonly entryCount: number;
  /**
   * True only when the list does something beyond offsetting the start.
   *
   * A single entry with a small positive media time is the standard encoder-delay
   * compensation that every H.264 stream with B-frames carries, and treating that as a
   * problem would flag almost every file in existence.
   */
  readonly nonTrivial: boolean;
  /** Initial media time of the first entry, in media ticks. -1 means "empty edit". */
  readonly firstMediaTime: number | null;
  /** An entry with media time -1, which inserts blank presentation time. */
  readonly hasEmptyEdit: boolean;
  /** An entry playing at a rate other than 1. */
  readonly hasRateChange: boolean;
}

export interface Track {
  readonly id: number;
  readonly kind: TrackKind;
  /** `vide`, `soun`, `sbtl`, ... straight from `hdlr`. */
  readonly handler: string;
  /** Sample entry format, e.g. `avc1`, `hvc1`, `mp4a`. */
  readonly format: string;
  /** Human label, e.g. `H.264 / AVC`. */
  readonly codecLabel: string;
  readonly language: string;

  readonly timescale: number;
  /** Media duration in seconds. */
  readonly durationSec: number;
  readonly sampleCount: number;
  /** Sum of all sample sizes, in bytes. */
  readonly byteLength: number;
  /** Derived from `byteLength` and `durationSec`. */
  readonly bitrateBps: number | null;

  /** Display size from `tkhd`, after the transform matrix. */
  readonly displayWidth: number | null;
  readonly displayHeight: number | null;
  /** Coded size from the sample entry, before rotation. */
  readonly codedWidth: number | null;
  readonly codedHeight: number | null;
  readonly rotationDegrees: number;
  /**
   * Coded size with width and height swapped when the rotation is 90 or 270. This
   * is the size a viewer sees, and the only one worth comparing against a target
   * like "1080x1920 portrait". A rotated phone export is commonly stored 1920x1080
   * with a 90 degree matrix, and `tkhd` keeps the unrotated size, so neither the
   * coded nor the display fields answer that question on their own.
   */
  readonly orientedWidth: number | null;
  readonly orientedHeight: number | null;

  readonly timing: FrameTiming;
  readonly color: ColorInfo;
  readonly video: VideoCodecInfo | null;
  readonly audio: AudioCodecInfo | null;
  readonly editList: EditListInfo;

  /** `stco` for 32-bit chunk offsets, `co64` for 64-bit. */
  readonly chunkOffsetBox: 'stco' | 'co64' | null;
  readonly chunkCount: number;
  /** More than one sample description entry means mixed codecs in one track. */
  readonly sampleEntryCount: number;
}

export interface FileBrand {
  readonly major: string;
  readonly minor: number;
  readonly compatible: readonly string[];
}

export interface MediaReport {
  readonly fileName: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly brand: FileBrand | null;
  readonly topLevel: readonly TopLevelEntry[];

  /** True when `moov` precedes `mdat`, so a player can start without seeking. */
  readonly faststart: boolean;
  /** True when the file uses `moof` fragments instead of a single flat `mdat`. */
  readonly fragmented: boolean;
  /** True when any top-level box needed a 64-bit largesize. */
  readonly hasLargeBoxes: boolean;

  /** Presentation duration from `mvhd`, in seconds. */
  readonly durationSec: number;
  readonly overallBitrateBps: number | null;

  readonly tracks: readonly Track[];
  readonly video: Track | null;
  readonly audio: Track | null;

  /** Contents of the `©too` encoder tag, when present. */
  readonly encoderTag: string | null;
  /** Non-fatal notes collected while parsing. */
  readonly notes: readonly string[];
}
