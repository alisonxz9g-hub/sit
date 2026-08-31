/**
 * Codec configuration record decoders and the enum tables that turn raw numbers
 * into labels a person can act on.
 */
import { Reader } from './reader';
import type { AudioCodecInfo, ColorInfo, VideoCodecInfo } from './types';

/* ------------------------------------------------------------------ colour --- */

/** ISO/IEC 23091-2 colour primaries. */
const PRIMARIES: Record<number, string> = {
  1: 'BT.709',
  2: 'unspecified',
  4: 'BT.470M',
  5: 'BT.601 625',
  6: 'BT.601 525',
  7: 'SMPTE 240M',
  8: 'Film',
  9: 'BT.2020',
  10: 'SMPTE 428',
  11: 'SMPTE 431',
  12: 'SMPTE 432',
  22: 'EBU 3213',
};

/** ISO/IEC 23091-2 transfer characteristics. */
const TRANSFER: Record<number, string> = {
  1: 'BT.709',
  2: 'unspecified',
  4: 'Gamma 2.2',
  5: 'Gamma 2.8',
  6: 'BT.601',
  7: 'SMPTE 240M',
  8: 'Linear',
  11: 'IEC 61966-2-4',
  12: 'BT.1361',
  13: 'sRGB',
  14: 'BT.2020 10-bit',
  15: 'BT.2020 12-bit',
  16: 'PQ (HDR10)',
  17: 'SMPTE 428',
  18: 'HLG',
};

/** ISO/IEC 23091-2 matrix coefficients. */
const MATRIX: Record<number, string> = {
  0: 'Identity',
  1: 'BT.709',
  2: 'unspecified',
  4: 'FCC',
  5: 'BT.470BG',
  6: 'BT.601',
  7: 'SMPTE 240M',
  9: 'BT.2020 non-constant',
  10: 'BT.2020 constant',
};

/** Transfer characteristics that mean the source is HDR. */
const HDR_TRANSFERS = new Set([16, 18]);

export const UNTAGGED_COLOR: ColorInfo = {
  present: false,
  type: null,
  primaries: null,
  transfer: null,
  matrix: null,
  fullRange: null,
  primariesLabel: 'not tagged',
  transferLabel: 'not tagged',
  matrixLabel: 'not tagged',
  isHdr: false,
};

function label(table: Record<number, string>, value: number | null): string {
  if (value === null) return 'not tagged';
  return table[value] ?? `unknown (${value})`;
}

export function parseColr(payload: Uint8Array): ColorInfo {
  const r = new Reader(payload);
  if (payload.length < 4) return UNTAGGED_COLOR;
  const type = r.fourcc();

  // `nclx` is the ISO form and carries a range flag; `nclc` is the older
  // QuickTime form and does not. ICC profile forms carry no enums at all.
  if ((type === 'nclx' || type === 'nclc') && payload.length >= 10) {
    const primaries = r.u16();
    const transfer = r.u16();
    const matrix = r.u16();
    const fullRange = type === 'nclx' && payload.length >= 11 ? (r.u8() & 0x80) !== 0 : null;
    return {
      present: true,
      type,
      primaries,
      transfer,
      matrix,
      fullRange,
      primariesLabel: label(PRIMARIES, primaries),
      transferLabel: label(TRANSFER, transfer),
      matrixLabel: label(MATRIX, matrix),
      isHdr: HDR_TRANSFERS.has(transfer),
    };
  }

  return {
    ...UNTAGGED_COLOR,
    present: true,
    type,
    primariesLabel: `${type} profile`,
    transferLabel: `${type} profile`,
    matrixLabel: `${type} profile`,
  };
}

/**
 * True when the tags describe plain SDR Rec.709, which is what a phone screen and
 * every social video pipeline assume when nothing says otherwise.
 */
export function isRec709(color: ColorInfo): boolean {
  return color.primaries === 1 && color.transfer === 1 && color.matrix === 1;
}

/**
 * True when the tags are present but say "unspecified", which is as good as absent
 * for a downstream encoder.
 */
export function isUnspecifiedColor(color: ColorInfo): boolean {
  if (!color.present) return true;
  return color.primaries === 2 || color.transfer === 2 || color.matrix === 2;
}

/* -------------------------------------------------------------------- H.264 --- */

const AVC_PROFILES: Record<number, string> = {
  66: 'Baseline',
  77: 'Main',
  88: 'Extended',
  100: 'High',
  110: 'High 10',
  122: 'High 4:2:2',
  244: 'High 4:4:4 Predictive',
};

const CHROMA_FORMATS: Record<number, string> = {
  0: 'monochrome',
  1: '4:2:0',
  2: '4:2:2',
  3: '4:4:4',
};

/** Profiles whose avcC carries the chroma/bit-depth extension. */
const AVC_EXTENDED_PROFILES = new Set([100, 110, 122, 144, 244]);

function formatAvcLevel(level: number): string {
  // Levels are the real level times ten. 4.2 is stored as 42.
  const major = Math.floor(level / 10);
  const minor = level % 10;
  return `${major}.${minor}`;
}

export function parseAvcC(payload: Uint8Array): VideoCodecInfo {
  if (payload.length < 4) {
    return { profile: null, level: null, chromaFormat: null, bitDepth: null };
  }

  const profileIdc = payload[1]!;
  const levelIdc = payload[3]!;
  const profile = AVC_PROFILES[profileIdc] ?? `profile ${profileIdc}`;
  const level = formatAvcLevel(levelIdc);

  let chromaFormat: string | null = null;
  let bitDepth: number | null = null;

  // The chroma and bit-depth fields sit after the SPS and PPS arrays, and only
  // exist for the High family. Walk past the parameter sets to reach them.
  if (AVC_EXTENDED_PROFILES.has(profileIdc)) {
    try {
      const r = new Reader(payload);
      r.skip(5); // configurationVersion, profile, compat, level, lengthSizeMinusOne
      const spsCount = r.u8() & 0x1f;
      for (let i = 0; i < spsCount; i++) r.skip(r.u16());
      const ppsCount = r.u8();
      for (let i = 0; i < ppsCount; i++) r.skip(r.u16());

      if (r.remaining >= 4) {
        chromaFormat = CHROMA_FORMATS[r.u8() & 0x03] ?? null;
        bitDepth = (r.u8() & 0x07) + 8;
      }
    } catch {
      // A truncated extension is not worth failing the whole analysis over.
    }
  } else if (profileIdc === 66 || profileIdc === 77 || profileIdc === 88) {
    // These profiles are 4:2:0 8-bit by definition.
    chromaFormat = '4:2:0';
    bitDepth = 8;
  }

  return { profile, level, chromaFormat, bitDepth };
}

/* -------------------------------------------------------------------- HEVC --- */

const HEVC_PROFILES: Record<number, string> = {
  1: 'Main',
  2: 'Main 10',
  3: 'Main Still Picture',
  4: 'Format Range Extensions',
  5: 'High Throughput',
  9: 'Screen Content Coding',
};

/** HEVC stores general_level_idc as the level times thirty: 4.1 becomes 123. */
function formatHevcLevel(levelIdc: number): string {
  const major = Math.floor(levelIdc / 30);
  const minor = Math.round((levelIdc % 30) / 3);
  return `${major}.${minor}`;
}

export function parseHvcC(payload: Uint8Array): VideoCodecInfo {
  if (payload.length < 13) {
    return { profile: null, level: null, chromaFormat: null, bitDepth: null };
  }

  const profileIdc = payload[1]! & 0x1f;
  const tier = (payload[1]! & 0x20) !== 0 ? 'High' : 'Main';
  const base = HEVC_PROFILES[profileIdc] ?? `profile ${profileIdc}`;

  let chromaFormat: string | null = null;
  let bitDepth: number | null = null;
  if (payload.length >= 19) {
    chromaFormat = CHROMA_FORMATS[payload[16]! & 0x03] ?? null;
    bitDepth = (payload[17]! & 0x07) + 8;
  }

  return {
    profile: `${base} (${tier} tier)`,
    level: formatHevcLevel(payload[12]!),
    chromaFormat,
    bitDepth,
  };
}

/* --------------------------------------------------------------------- AAC --- */

/** MPEG-4 audio object types we care about naming. */
const AAC_OBJECT_TYPES: Record<number, string> = {
  1: 'AAC Main',
  2: 'AAC-LC',
  3: 'AAC-SSR',
  4: 'AAC-LTP',
  5: 'HE-AAC (SBR)',
  23: 'AAC-LD',
  29: 'HE-AACv2 (SBR+PS)',
  39: 'AAC-ELD',
};

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

const AAC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

/** Reads one MPEG-4 descriptor tag/length pair. Lengths are base-128 varints. */
function readDescriptorLength(r: Reader): number {
  let length = 0;
  for (let i = 0; i < 4; i++) {
    const byte = r.u8();
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return length;
}

/**
 * Walks `esds` down to the AudioSpecificConfig to recover the AAC profile, which is
 * the difference between a clean 48 kHz stereo LC track and an HE-AAC track that
 * some encoders handle badly.
 */
export function parseEsds(payload: Uint8Array): Partial<AudioCodecInfo> {
  try {
    const r = new Reader(payload);
    r.fullBoxHeader();

    if (r.u8() !== 0x03) return {}; // ES_Descriptor
    readDescriptorLength(r);
    r.skip(2); // ES_ID
    const flags = r.u8();
    if (flags & 0x80) r.skip(2); // dependsOn
    if (flags & 0x40) r.skip(1 + r.u8()); // URL
    if (flags & 0x20) r.skip(2); // OCR

    if (r.u8() !== 0x04) return {}; // DecoderConfigDescriptor
    readDescriptorLength(r);
    r.skip(1); // objectTypeIndication
    r.skip(1); // streamType + upStream
    r.skip(3); // bufferSizeDB
    r.skip(4); // maxBitrate
    const avgBitrate = r.u32();

    const result: Partial<AudioCodecInfo> = {
      declaredBitrateBps: avgBitrate > 0 ? avgBitrate : null,
    };

    if (r.remaining < 2 || r.u8() !== 0x05) return result; // DecoderSpecificInfo
    const ascLength = readDescriptorLength(r);
    if (ascLength < 2 || r.remaining < 2) return result;

    // AudioSpecificConfig is a bitstream: 5 bits object type, 4 bits sample rate
    // index, 4 bits channel config.
    const b0 = r.u8();
    const b1 = r.u8();
    let objectType = b0 >> 3;
    let bitCursor = 5;
    let word = (b0 << 8) | b1;

    if (objectType === 31) {
      // Escape value: the real type is the next 6 bits plus 32.
      objectType = 32 + ((word >> (16 - 5 - 6)) & 0x3f);
      bitCursor = 11;
    }

    const rateIndex = (word >> (16 - bitCursor - 4)) & 0x0f;
    const channelIndex = (word >> (16 - bitCursor - 8)) & 0x0f;

    return {
      ...result,
      profile: AAC_OBJECT_TYPES[objectType] ?? `object type ${objectType}`,
      sampleRate: rateIndex === 0x0f ? null : (AAC_SAMPLE_RATES[rateIndex] ?? null),
      channels: AAC_CHANNELS[channelIndex] ?? null,
    };
  } catch {
    return {};
  }
}

/** `btrt` carries a plain declared bitrate, handy when `esds` is absent. */
export function parseBtrt(payload: Uint8Array): number | null {
  if (payload.length < 12) return null;
  const r = new Reader(payload);
  r.skip(4); // bufferSizeDB
  r.skip(4); // maxBitrate
  const avg = r.u32();
  return avg > 0 ? avg : null;
}

/* ------------------------------------------------------------------- labels --- */

const CODEC_LABELS: Record<string, string> = {
  avc1: 'H.264 / AVC',
  avc3: 'H.264 / AVC (in-band params)',
  hvc1: 'HEVC / H.265',
  hev1: 'HEVC / H.265 (in-band params)',
  hvc2: 'HEVC / H.265',
  hev2: 'HEVC / H.265 (in-band params)',
  av01: 'AV1',
  vp09: 'VP9',
  mp4v: 'MPEG-4 Visual',
  jpeg: 'Motion JPEG',
  'ap4h': 'Apple ProRes 4444',
  apch: 'Apple ProRes 422 HQ',
  apcn: 'Apple ProRes 422',
  mp4a: 'AAC',
  'ac-3': 'Dolby Digital',
  'ec-3': 'Dolby Digital Plus',
  alac: 'Apple Lossless',
  opus: 'Opus',
  'twos': 'PCM (big-endian)',
  sowt: 'PCM (little-endian)',
  lpcm: 'PCM',
  tx3g: 'Timed text',
  c608: 'CEA-608 captions',
};

export function codecLabel(format: string): string {
  return CODEC_LABELS[format] ?? format;
}

export const AVC_FORMATS = new Set(['avc1', 'avc3']);
export const HEVC_FORMATS = new Set(['hvc1', 'hev1', 'hvc2', 'hev2']);
