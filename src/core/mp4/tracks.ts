/**
 * Turns a parsed `moov` subtree into the track facts the rest of the app reasons
 * about: real frame rate and whether it is constant, actual bitrate from the sample
 * table rather than a declared guess, rotation, and colour tagging.
 */
import { type Box, child, children, path } from './boxes';
import {
  AVC_FORMATS,
  HEVC_FORMATS,
  UNTAGGED_COLOR,
  codecLabel,
  parseAvcC,
  parseBtrt,
  parseColr,
  parseEsds,
  parseHvcC,
} from './codecs';
import { Reader } from './reader';
import type {
  AudioCodecInfo,
  ColorInfo,
  EditListInfo,
  FrameTiming,
  Track,
  TrackKind,
  VideoCodecInfo,
} from './types';

const EMPTY_TIMING: FrameTiming = {
  mode: 'unknown',
  avgFps: null,
  nominalFps: null,
  minFps: null,
  maxFps: null,
  entryCount: 0,
  distinctDeltas: 0,
  dominantShare: 0,
};

const NO_EDIT_LIST: EditListInfo = {
  present: false,
  entryCount: 0,
  nonTrivial: false,
  firstMediaTime: null,
};

/**
 * Share of samples that must use one delta for us to call a track constant frame
 * rate. Encoders routinely give the final frame an odd duration, and a handful of
 * outliers in a 30-minute clip is not what people mean by "variable frame rate".
 */
const CFR_THRESHOLD = 0.999;
/** Below this we stop making excuses and call it variable. */
const NEAR_CFR_THRESHOLD = 0.95;

/* ------------------------------------------------------------ sample tables --- */

interface SttsEntry {
  count: number;
  delta: number;
}

function parseStts(payload: Uint8Array): SttsEntry[] {
  const r = new Reader(payload);
  r.fullBoxHeader();
  const entryCount = r.u32();
  // Each entry is 8 bytes; refuse to trust a count the payload cannot hold.
  const max = Math.floor(r.remaining / 8);
  const entries: SttsEntry[] = [];
  for (let i = 0; i < Math.min(entryCount, max); i++) {
    entries.push({ count: r.u32(), delta: r.u32() });
  }
  return entries;
}

/** `stsz` with a uniform size, or a per-sample table. */
function parseStsz(payload: Uint8Array): { count: number; totalBytes: number } {
  const r = new Reader(payload);
  r.fullBoxHeader();
  const uniformSize = r.u32();
  const count = r.u32();

  if (uniformSize > 0) {
    return { count, totalBytes: uniformSize * count };
  }

  const max = Math.floor(r.remaining / 4);
  let totalBytes = 0;
  for (let i = 0; i < Math.min(count, max); i++) totalBytes += r.u32();
  return { count, totalBytes };
}

/** `stz2`, the compact variant, packs sizes into 4, 8 or 16 bit fields. */
function parseStz2(payload: Uint8Array): { count: number; totalBytes: number } {
  const r = new Reader(payload);
  r.fullBoxHeader();
  r.skip(3); // reserved
  const fieldSize = r.u8();
  const count = r.u32();

  let totalBytes = 0;
  if (fieldSize === 4) {
    for (let i = 0; i < count; i += 2) {
      if (r.remaining < 1) break;
      const byte = r.u8();
      totalBytes += byte >> 4;
      if (i + 1 < count) totalBytes += byte & 0x0f;
    }
  } else if (fieldSize === 8) {
    for (let i = 0; i < count && r.remaining >= 1; i++) totalBytes += r.u8();
  } else if (fieldSize === 16) {
    for (let i = 0; i < count && r.remaining >= 2; i++) totalBytes += r.u16();
  }
  return { count, totalBytes };
}

function parseChunkOffsets(stbl: Box | null): { box: 'stco' | 'co64' | null; count: number } {
  const stco = child(stbl, 'stco');
  if (stco?.payload) {
    const r = new Reader(stco.payload);
    r.fullBoxHeader();
    return { box: 'stco', count: r.u32() };
  }
  const co64 = child(stbl, 'co64');
  if (co64?.payload) {
    const r = new Reader(co64.payload);
    r.fullBoxHeader();
    return { box: 'co64', count: r.u32() };
  }
  return { box: null, count: 0 };
}

/* ------------------------------------------------------------------- timing --- */

function computeTiming(entries: SttsEntry[], timescale: number, durationSec: number): FrameTiming {
  if (entries.length === 0 || timescale <= 0) return EMPTY_TIMING;

  // Collapse to a delta histogram. A zero delta contributes samples but no time,
  // which happens in files with duplicate timestamps, so it is counted and ignored
  // for the rate maths.
  const histogram = new Map<number, number>();
  let sampleCount = 0;
  for (const { count, delta } of entries) {
    if (count <= 0) continue;
    sampleCount += count;
    histogram.set(delta, (histogram.get(delta) ?? 0) + count);
  }
  if (sampleCount === 0) return EMPTY_TIMING;

  let dominantDelta = 0;
  let dominantCount = 0;
  let minDelta = Number.POSITIVE_INFINITY;
  let maxDelta = 0;
  for (const [delta, count] of histogram) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantDelta = delta;
    }
    if (delta > 0) {
      minDelta = Math.min(minDelta, delta);
      maxDelta = Math.max(maxDelta, delta);
    }
  }

  const dominantShare = dominantCount / sampleCount;
  const mode: FrameTiming['mode'] =
    dominantShare >= CFR_THRESHOLD ? 'cfr' : dominantShare >= NEAR_CFR_THRESHOLD ? 'near-cfr' : 'vfr';

  return {
    mode,
    avgFps: durationSec > 0 ? sampleCount / durationSec : null,
    nominalFps: dominantDelta > 0 ? timescale / dominantDelta : null,
    minFps: maxDelta > 0 ? timescale / maxDelta : null,
    maxFps: Number.isFinite(minDelta) && minDelta > 0 ? timescale / minDelta : null,
    entryCount: entries.length,
    distinctDeltas: histogram.size,
    dominantShare,
  };
}

/* ------------------------------------------------------------------ headers --- */

interface Mdhd {
  timescale: number;
  duration: number;
  language: string;
}

function parseMdhd(payload: Uint8Array): Mdhd {
  const r = new Reader(payload);
  const { version } = r.fullBoxHeader();
  if (version === 1) {
    r.skip(16); // creation + modification
    const timescale = r.u32();
    const duration = r.u64();
    return { timescale, duration, language: r.packedLanguage() };
  }
  r.skip(8);
  const timescale = r.u32();
  const duration = r.u32();
  return { timescale, duration, language: r.packedLanguage() };
}

interface Tkhd {
  trackId: number;
  width: number;
  height: number;
  rotationDegrees: number;
}

/**
 * `tkhd` carries a 3x3 transform matrix. Everything ships either identity or a
 * multiple of 90 degrees, and the rotation is what a player applies before display,
 * so a "1080x1920" phone video is often stored as 1920x1080 plus a 90 degree turn.
 */
function parseTkhd(payload: Uint8Array): Tkhd {
  const r = new Reader(payload);
  const { version } = r.fullBoxHeader();
  if (version === 1) {
    r.skip(16); // creation + modification
  } else {
    r.skip(8);
  }
  const trackId = r.u32();
  r.skip(4); // reserved
  r.skip(version === 1 ? 8 : 4); // duration
  r.skip(8); // reserved
  r.skip(2); // layer
  r.skip(2); // alternate group
  r.skip(2); // volume
  r.skip(2); // reserved

  const a = r.fixed16_16();
  const b = r.fixed16_16();
  r.fixed2_30(); // u
  const c = r.fixed16_16();
  const d = r.fixed16_16();
  r.fixed2_30(); // v
  r.fixed16_16(); // x
  r.fixed16_16(); // y
  r.fixed2_30(); // w

  const width = r.fixed16_16();
  const height = r.fixed16_16();

  // The matrix maps stored coordinates to display coordinates, so the angle it
  // encodes is the inverse of the rotation a player applies to the decoded frame.
  // Negating lines this up with what ffmpeg, ffprobe and MediaInfo report, verified
  // against 0/90/180/270 degree fixtures.
  let rotationDegrees = 0;
  if (a !== 0 || b !== 0 || c !== 0 || d !== 0) {
    const degrees = -Math.round((Math.atan2(b, a) * 180) / Math.PI);
    rotationDegrees = ((degrees % 360) + 360) % 360;
  }

  return { trackId, width, height, rotationDegrees };
}

function parseElst(payload: Uint8Array): EditListInfo {
  const r = new Reader(payload);
  const { version } = r.fullBoxHeader();
  const entryCount = r.u32();
  if (entryCount === 0) return { present: true, entryCount: 0, nonTrivial: false, firstMediaTime: null };

  const entrySize = version === 1 ? 20 : 12;
  const readable = Math.min(entryCount, Math.floor(r.remaining / entrySize));

  let firstMediaTime: number | null = null;
  let nonTrivial = entryCount > 1;

  for (let i = 0; i < readable; i++) {
    if (version === 1) {
      r.u64(); // segment duration
      const mediaTime = r.i64();
      if (i === 0) firstMediaTime = mediaTime;
      if (mediaTime !== 0 && mediaTime !== -1) nonTrivial = true;
      if (mediaTime === -1) nonTrivial = true; // empty edit: inserts blank time
    } else {
      r.u32();
      const mediaTime = r.i32();
      if (i === 0) firstMediaTime = mediaTime;
      if (mediaTime !== 0) nonTrivial = true;
    }
    const rate = r.i16();
    r.i16();
    if (rate !== 1) nonTrivial = true;
  }

  return { present: true, entryCount, nonTrivial, firstMediaTime };
}

/* ------------------------------------------------------------- sample entry --- */

interface SampleEntry {
  format: string;
  entryCount: number;
  codedWidth: number | null;
  codedHeight: number | null;
  color: ColorInfo;
  video: VideoCodecInfo | null;
  audio: AudioCodecInfo | null;
}

function parseSampleEntry(stsd: Box | null, kind: TrackKind): SampleEntry {
  const empty: SampleEntry = {
    format: 'none',
    entryCount: 0,
    codedWidth: null,
    codedHeight: null,
    color: UNTAGGED_COLOR,
    video: null,
    audio: null,
  };
  if (!stsd?.payload) return empty;

  const r = new Reader(stsd.payload);
  r.fullBoxHeader();
  const entryCount = r.u32();
  if (entryCount === 0 || r.remaining < 8) return { ...empty, entryCount };

  // Only the first entry is described. A track with more than one is flagged
  // elsewhere as unsupported rather than silently averaged.
  const entryStart = r.offset;
  const entrySize = r.u32();
  const format = r.fourcc();
  r.skip(6); // reserved
  r.skip(2); // data reference index

  const entryEnd = Math.min(entryStart + Math.max(entrySize, 16), stsd.payload.length);

  let codedWidth: number | null = null;
  let codedHeight: number | null = null;
  let color: ColorInfo = UNTAGGED_COLOR;
  let video: VideoCodecInfo | null = null;
  let audio: AudioCodecInfo | null = null;
  let subBoxStart: number;

  // The sub-boxes begin wherever the fixed fields end. Tracking that with the
  // reader's own cursor rather than a hardcoded constant keeps the two in sync.
  if (kind === 'video') {
    r.skip(2); // pre_defined
    r.skip(2); // reserved
    r.skip(12); // pre_defined
    codedWidth = r.u16();
    codedHeight = r.u16();
    r.skip(4); // horizontal resolution
    r.skip(4); // vertical resolution
    r.skip(4); // reserved
    r.skip(2); // frame count
    r.skip(32); // compressor name
    r.skip(2); // depth
    r.skip(2); // pre_defined
    subBoxStart = r.offset;
  } else if (kind === 'audio') {
    const qtVersion = r.u16();
    r.skip(2); // revision
    r.skip(4); // vendor
    const channels = r.u16();
    r.skip(2); // sample size
    r.skip(2); // compression id
    r.skip(2); // packet size
    const sampleRate = r.u32() >>> 16; // 16.16 fixed point
    audio = { channels, sampleRate, profile: null, declaredBitrateBps: null };

    // QuickTime version 1 appends four 32-bit fields; version 2 replaces the whole
    // block with a larger one.
    if (qtVersion === 1) r.skip(16);
    else if (qtVersion === 2) r.skip(36);
    subBoxStart = r.offset;
  } else {
    subBoxStart = entryEnd;
  }

  // Sub-boxes (avcC, hvcC, colr, esds, btrt, pasp, ...) live inside the entry. They
  // are parsed against the enclosing reader so offsets stay absolute.
  let at = subBoxStart;
  let declaredBitrate: number | null = null;

  while (at + 8 <= entryEnd) {
    const sub = new Reader(stsd.payload.subarray(at, entryEnd));
    const size = sub.u32();
    const type = sub.fourcc();
    if (size < 8 || at + size > entryEnd) break;
    const body = stsd.payload.subarray(at + 8, at + size);

    switch (type) {
      case 'avcC':
        video = parseAvcC(body);
        break;
      case 'hvcC':
        video = parseHvcC(body);
        break;
      case 'colr':
        color = parseColr(body);
        break;
      case 'esds': {
        // `esds` is authoritative for the AAC profile and often for the sample rate
        // too, since the sample entry header cannot express rates above 65535.
        const parsed = parseEsds(body);
        const base = audio ?? { channels: null, sampleRate: null, profile: null, declaredBitrateBps: null };
        audio = {
          channels: parsed.channels ?? base.channels,
          sampleRate: parsed.sampleRate ?? base.sampleRate,
          profile: parsed.profile ?? base.profile,
          declaredBitrateBps: parsed.declaredBitrateBps ?? base.declaredBitrateBps,
        };
        break;
      }
      case 'btrt':
        declaredBitrate = parseBtrt(body);
        break;
      default:
        break;
    }
    at += size;
  }

  if (audio && declaredBitrate !== null && audio.declaredBitrateBps === null) {
    audio = { ...audio, declaredBitrateBps: declaredBitrate };
  }

  return { format, entryCount, codedWidth, codedHeight, color, video, audio };
}

/* -------------------------------------------------------------------- track --- */

function handlerToKind(handler: string): TrackKind {
  switch (handler) {
    case 'vide':
      return 'video';
    case 'soun':
      return 'audio';
    case 'sbtl':
    case 'text':
    case 'subt':
      return 'subtitle';
    default:
      return 'other';
  }
}

export function parseTrack(trak: Box): Track | null {
  const tkhdPayload = child(trak, 'tkhd')?.payload;
  const mdia = child(trak, 'mdia');
  const mdhdPayload = child(mdia, 'mdhd')?.payload;
  const hdlrPayload = child(mdia, 'hdlr')?.payload;
  if (!mdhdPayload || !hdlrPayload) return null;

  const mdhd = parseMdhd(mdhdPayload);
  const tkhd = tkhdPayload
    ? parseTkhd(tkhdPayload)
    : { trackId: 0, width: 0, height: 0, rotationDegrees: 0 };

  // hdlr: version/flags(4) pre_defined(4) handler_type(4)
  const handler = hdlrPayload.length >= 12
    ? String.fromCharCode(hdlrPayload[8]!, hdlrPayload[9]!, hdlrPayload[10]!, hdlrPayload[11]!)
    : 'none';
  const kind = handlerToKind(handler);

  const stbl = path(trak, 'mdia', 'minf', 'stbl');
  const entry = parseSampleEntry(child(stbl, 'stsd'), kind);

  const durationSec = mdhd.timescale > 0 ? mdhd.duration / mdhd.timescale : 0;

  const sttsPayload = child(stbl, 'stts')?.payload;
  const sttsEntries = sttsPayload ? parseStts(sttsPayload) : [];

  const stszPayload = child(stbl, 'stsz')?.payload;
  const stz2Payload = child(stbl, 'stz2')?.payload;
  const sizes = stszPayload
    ? parseStsz(stszPayload)
    : stz2Payload
      ? parseStz2(stz2Payload)
      : { count: 0, totalBytes: 0 };

  const chunks = parseChunkOffsets(stbl);
  const elstPayload = path(trak, 'edts', 'elst')?.payload;

  const timing = kind === 'video' ? computeTiming(sttsEntries, mdhd.timescale, durationSec) : EMPTY_TIMING;

  const quarterTurn = tkhd.rotationDegrees === 90 || tkhd.rotationDegrees === 270;
  const orientedWidth = quarterTurn ? entry.codedHeight : entry.codedWidth;
  const orientedHeight = quarterTurn ? entry.codedWidth : entry.codedHeight;

  return {
    id: tkhd.trackId,
    kind,
    handler,
    format: entry.format,
    codecLabel: codecLabel(entry.format),
    language: mdhd.language,
    timescale: mdhd.timescale,
    durationSec,
    sampleCount: sizes.count,
    byteLength: sizes.totalBytes,
    bitrateBps: durationSec > 0 && sizes.totalBytes > 0 ? (sizes.totalBytes * 8) / durationSec : null,
    displayWidth: tkhd.width > 0 ? Math.round(tkhd.width) : null,
    displayHeight: tkhd.height > 0 ? Math.round(tkhd.height) : null,
    codedWidth: entry.codedWidth,
    codedHeight: entry.codedHeight,
    rotationDegrees: tkhd.rotationDegrees,
    orientedWidth,
    orientedHeight,
    timing,
    color: entry.color,
    video: entry.video,
    audio: entry.audio,
    editList: elstPayload ? parseElst(elstPayload) : NO_EDIT_LIST,
    chunkOffsetBox: chunks.box,
    chunkCount: chunks.count,
    sampleEntryCount: entry.entryCount,
  };
}

/* ----------------------------------------------------------------- metadata --- */

/**
 * Pulls the `©too` encoder tag. It appears either as `udta/meta/ilst/©too/data` in
 * ISO files or directly as `udta/©too` in QuickTime ones.
 */
export function readEncoderTag(moov: Box): string | null {
  const udta = child(moov, 'udta');
  if (!udta) return null;

  const decode = (bytes: Uint8Array): string =>
    new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0+$/, '').trim();

  const ilst = path(udta, 'meta', 'ilst');
  if (ilst) {
    for (const tag of ilst.children ?? []) {
      // The tag name starts with the 0xA9 copyright byte, which our fourcc reader
      // escapes, so match on the readable tail instead.
      if (!tag.type.endsWith('too')) continue;
      const data = child(tag, 'data')?.payload;
      // data: version/flags(4) reserved(4) text
      if (data && data.length > 8) return decode(data.subarray(8)) || null;
    }
  }

  for (const box of children(udta, '\\xa9too')) {
    // QuickTime form: length(2) language(2) text
    if (box.payload && box.payload.length > 4) return decode(box.payload.subarray(4)) || null;
  }

  return null;
}
