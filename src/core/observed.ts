/**
 * Observed Haze 4.0 — a replication of a third-party container transformation.
 *
 * WHAT THIS IS
 *
 * A reverse-engineered copy of what the Haze Engine 4.0 does to an MP4, derived by
 * comparing a real input against its real output byte for byte, not from documentation.
 * Every constant here was measured against the observed output.
 *
 * WHAT IT DOES
 *
 *   1. Moves `moov` before `mdat`.
 *   2. Recomputes every chunk offset for the new layout.
 *   3. Strips `edts`/`elst` from all tracks.
 *   4. Copies the video elementary stream verbatim — no re-encode.
 *   5. Clones the AAC audio track under a fresh track_ID.
 *   6. Appends nine artificial samples per real sample to the clone: 8 bytes each,
 *      one tick each, contents `00 00 00 04 00 00 00 00`.
 *   7. Places those bytes after the declared end of `mdat`, outside any box.
 *
 * THIS OUTPUT IS NOT SPEC-COMPLIANT, DELIBERATELY
 *
 * Step 7 is the whole point and the whole problem. Bytes outside any box violate ISO/IEC
 * 14496-12. A strict parser reading past `mdat` sees `00 00 00 04` as a box size of 4,
 * which is smaller than the 8-byte header it must have, and errors out. The classification
 * this module reports is therefore:
 *
 *   CLASSIFICATION:      OBSERVED
 *   ISO BMFF COMPLIANT:  NO
 *   VALIDATION STATUS:   NOT APPROVED
 *
 * It is exposed as its own mode, never as a default, and the UI states the above before
 * anyone runs it. It also depends entirely on how a specific third party's analysis
 * responds to an inflated audio sample table, so it can stop working without notice.
 *
 * The spec-compliant modes in ./remux.ts remain the recommended path.
 */
import {
  type MediaReport,
  type MutableBox,
  allChunkOffsetTables,
  measure,
  mutableChild,
  mutableFindAll,
  parseBoxes,
  readBox,
  readMdhdDuration,
  Reader,
  readStsc,
  readStsz,
  readStts,
  readTkhdTrackId,
  scanTopLevel,
  serialize,
  toMutable,
  writeChunkOffsets,
  writeMdhdDuration,
  writeMvhdNextTrackId,
  writeStsc,
  writeStsz,
  writeStts,
  writeTkhdTrackId,
} from './mp4/index';

/** The 8-byte artificial sample, exactly as measured in the reference output. */
const ARTIFICIAL_SAMPLE = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);

/**
 * Artificial samples added per real sample.
 *
 * Measured: a 443-sample AAC track came out with 4430 samples and a 31896-byte tail.
 * 31896 / 8 = 3987 = 443 x 9, so the clone carries ten times the original count.
 */
const PAD_MULTIPLIER = 9;

/** Duration assigned to each artificial sample, in the track's media timescale. */
const ARTIFICIAL_SAMPLE_DURATION = 1;

/** Padding boxes that are accepted on input but dropped from the observed output. */
const DROPPABLE = new Set(['free', 'skip', 'wide']);
const KNOWN_TOP_LEVEL = new Set(['ftyp', 'moov', 'mdat', ...DROPPABLE]);

/** Layout passes before giving up. Offsets and index size depend on each other. */
const MAX_LAYOUT_PASSES = 6;
const MAX_U32 = 0xffffffff;
const MAX_TRAILER_SIZE = 2 * 1024 * 1024 * 1024;
/** Conservative peak budget for the tail, expanded stsz and temporary JS arrays. */
const MAX_OBSERVED_WORKING_SET = 256 * 1024 * 1024;
/** Approximate per-entry overhead while writeStsz builds number and Uint8Array lists. */
const STSZ_REWRITE_BYTES_PER_SAMPLE = 80;
const COPYRIGHT_TOO = '\\xa9too';
const DEFAULT_ENCODER_TAG = 'Haze Quality Method https://hazemethod.xyz';

export class ObservedTransformError extends Error {
  override readonly name = 'ObservedTransformError';
}

function estimateObservedWorkingSet(sourceSamples: number): number {
  const artificialSamples = sourceSamples * PAD_MULTIPLIER;
  const outputSamples = sourceSamples + artificialSamples;
  const trailerBytes = artificialSamples * ARTIFICIAL_SAMPLE.length;
  const expandedStszBytes = 12 + outputSamples * 4;
  // The table exists as source/clone/serialized bytes while writeStsz also holds arrays.
  return trailerBytes + expandedStszBytes * 3 + outputSamples * STSZ_REWRITE_BYTES_PER_SAMPLE;
}

export interface ObservedSupport {
  readonly supported: boolean;
  readonly reason: string;
  /** True only when one otherwise usable audio track merely needs conversion to AAC. */
  readonly needsAacPreparation: boolean;
}

/** Whether the observed transform's measured input domain applies to this file. */
export function canApplyObserved(report: MediaReport): ObservedSupport {
  const no = (reason: string, needsAacPreparation = false): ObservedSupport => ({
    supported: false,
    reason,
    needsAacPreparation,
  });

  if (report.fragmented) return no('the file is fragmented');

  const types = report.topLevel.map((box) => box.type);
  const unknown = types.filter((type) => !KNOWN_TOP_LEVEL.has(type));
  if (unknown.length > 0) {
    return no(`unexpected top-level box(es): ${[...new Set(unknown)].join(', ')}`);
  }

  for (const required of ['ftyp', 'moov', 'mdat'] as const) {
    const count = types.filter((type) => type === required).length;
    if (count !== 1) return no(`the file needs exactly one ${required} box; found ${count}`);
  }

  const lastBox = report.topLevel.at(-1);
  if (!lastBox || lastBox.end !== report.fileSize) {
    return no('the source already contains bytes outside its declared top-level boxes');
  }
  if (!report.video) return no('there is no video track');

  if (report.tracks.some((track) => track.chunkOffsetBox === 'co64')) {
    return no('every chunk-offset table must use the observed 32-bit stco form');
  }
  const maxTrackId = Math.max(0, ...report.tracks.map((track) => track.id));
  if (maxTrackId >= MAX_U32 - 1) {
    return no('there is no room for both a cloned track_ID and the next_track_ID counter');
  }

  const audioTracks = report.tracks.filter((track) => track.kind === 'audio');
  if (audioTracks.length === 0) {
    return no('there is no AAC audio track to clone', true);
  }
  if (audioTracks.length > 1) {
    return no(`the transform requires exactly one AAC audio track; found ${audioTracks.length}`);
  }

  const audio = audioTracks[0]!;
  if (audio.format !== 'mp4a') {
    return no(
      `the audio is ${audio.codecLabel}, not AAC, so the exact replication does not apply`,
      true,
    );
  }
  if (audio.sampleEntryCount !== 1) {
    return no('the AAC track must contain exactly one sample description');
  }
  if (audio.chunkOffsetBox !== 'stco') {
    return no('the AAC track must use a 32-bit stco chunk-offset table');
  }
  if (audio.sampleCount <= 0 || audio.chunkCount <= 0) {
    return no('the AAC sample or chunk table is empty');
  }
  const artificialSamples = audio.sampleCount * PAD_MULTIPLIER;
  const trailerBytes = artificialSamples * ARTIFICIAL_SAMPLE.length;
  if (
    !Number.isSafeInteger(artificialSamples) ||
    audio.sampleCount + artificialSamples > MAX_U32 ||
    trailerBytes > MAX_TRAILER_SIZE
  ) {
    return no('the artificial sample table or trailer exceeds the supported size');
  }
  if (estimateObservedWorkingSet(audio.sampleCount) > MAX_OBSERVED_WORKING_SET) {
    return no('the observed table expansion would exceed the browser memory budget');
  }

  return { supported: true, reason: '', needsAacPreparation: false };
}

export interface ObservedResult {
  readonly blob: Blob;
  /** Always the same three lines, so nobody can mistake this for a valid file. */
  readonly classification: 'OBSERVED';
  readonly isoCompliant: false;
  readonly validationStatus: 'NOT APPROVED';

  readonly moovBytes: number;
  readonly mdatBytes: number;
  /** Artificial samples appended to the clone. */
  readonly artificialSamples: number;
  /** Bytes written past the end of `mdat`. */
  readonly artificialBytes: number;
  /** track_ID given to the cloned audio track. */
  readonly clonedTrackId: number;
  /** Real samples in the source audio track. */
  readonly sourceAudioSamples: number;
  readonly dropped: readonly string[];
  readonly offsetDelta: number;
  readonly passes: number;
  /** Tracks that had an edit list removed. */
  readonly editListsRemoved: number;
}

export interface ObservedOptions {
  /**
   * Encoder tag used when the source already contains an `ilst` metadata container.
   * The measured Haze 4.0 value is the default; no metadata hierarchy is invented when
   * the source has none.
   */
  readonly encoderTag?: string;
}

export async function applyObservedTransform(
  file: File,
  options: ObservedOptions = {},
): Promise<ObservedResult> {
  const entries = await scanTopLevel(file);
  const types = entries.map((entry) => entry.type);
  const unknown = types.filter((type) => !KNOWN_TOP_LEVEL.has(type));
  if (unknown.length > 0) {
    throw new ObservedTransformError(
      `Unexpected top-level box(es): ${[...new Set(unknown)].join(', ')}.`,
    );
  }

  const exactlyOne = (type: 'ftyp' | 'moov' | 'mdat') => {
    const matches = entries.filter((entry) => entry.type === type);
    if (matches.length !== 1) {
      throw new ObservedTransformError(
        `This transform requires exactly one ${type} box; found ${matches.length}.`,
      );
    }
    return matches[0]!;
  };

  const ftypEntry = exactlyOne('ftyp');
  const moovEntry = exactlyOne('moov');
  const mdatEntry = exactlyOne('mdat');
  if (entries.at(-1)?.end !== file.size) {
    throw new ObservedTransformError(
      'The source contains trailing bytes outside its declared top-level boxes.',
    );
  }

  const ftypBytes = await readBox(file, ftypEntry);
  const moovBytes = await readBox(file, moovEntry);
  const moov = toMutable({
    type: 'moov',
    start: moovEntry.start,
    size: moovEntry.size,
    headerSize: moovEntry.headerSize,
    end: moovEntry.end,
    payload: null,
    prefix: null,
    children: parseBoxes(new Reader(moovBytes, moovEntry.start), moovEntry.headerSize, moovBytes.length, {
      strict: true,
      parentType: 'moov',
    }),
  });

  if (mutableFindAll(moov, 'co64').length > 0) {
    throw new ObservedTransformError('Observed Haze 4.0 requires stco and does not accept co64.');
  }
  for (const table of allChunkOffsetTables(moov)) {
    if (table.kind !== 'stco') {
      throw new ObservedTransformError('Observed Haze 4.0 requires 32-bit stco tables.');
    }
    requireExactTable(table.box, 4, 'stco');
  }

  const dropped = entries.filter((entry) => DROPPABLE.has(entry.type)).map((entry) => entry.type);

  // Strip edit lists from every original track before cloning the AAC track.
  const editListsRemoved = removeEditLists(moov);
  const clone = cloneAacTrack(moov);

  // Match the observed metadata behavior: edit an existing ilst, but never create one.
  writeEncoderTag(moov, options.encoderTag ?? DEFAULT_ENCODER_TAG);

  const sourceDataStart = mdatEntry.start + mdatEntry.headerSize;
  const dataLength = mdatEntry.size - mdatEntry.headerSize;
  const artificialBytes = clone.artificialSamples * ARTIFICIAL_SAMPLE.length;
  if (!Number.isSafeInteger(artificialBytes) || artificialBytes > MAX_TRAILER_SIZE) {
    throw new ObservedTransformError('The artificial trailer exceeds the 2 GiB safety limit.');
  }

  // Every real chunk offset shifts by the same delta; the clone's final chunk points past
  // the end of mdat. Both depend on the index size, so solve for a fixed point.
  const tables = allChunkOffsetTables(moov);
  const sourceOffsets = tables.map((table) => [...table.offsets]);
  const cloneTableIndex = tables.findIndex((table) => table.box === clone.stcoBox);
  if (cloneTableIndex < 0) {
    throw new ObservedTransformError('Lost track of the cloned chunk offset table.');
  }

  let delta = 0;
  let passes = 0;

  for (let pass = 1; pass <= MAX_LAYOUT_PASSES; pass++) {
    passes = pass;
    const indexSize = measure(moov);
    const newDataStart = ftypBytes.length + indexSize + mdatEntry.headerSize;
    const nextDelta = newDataStart - sourceDataStart;
    const artificialStart = newDataStart + dataLength;

    for (const [index, table] of tables.entries()) {
      const shifted = sourceOffsets[index]!.map((offset) => offset + nextDelta);
      if (index === cloneTableIndex) {
        // The final entry was appended as a placeholder by cloneAacTrack.
        shifted[shifted.length - 1] = artificialStart;
      }
      if (shifted.some((offset) => offset < 0 || offset > MAX_U32)) {
        throw new ObservedTransformError(
          'A relocated chunk offset no longer fits the observed 32-bit stco layout.',
        );
      }
      writeChunkOffsets(table, shifted);
    }

    delta = nextDelta;
    if (measure(moov) === indexSize) break;

    if (pass === MAX_LAYOUT_PASSES) {
      throw new ObservedTransformError(
        'Could not settle the file layout: the index kept changing size as offsets were written.',
      );
    }
  }

  const finalIndex = serialize(moov);
  const newDataStart = ftypBytes.length + finalIndex.length + mdatEntry.headerSize;
  const artificialStart = newDataStart + dataLength;

  verifyOffsets(moov, clone, newDataStart, dataLength, artificialStart, artificialBytes);

  const tail = new Uint8Array(artificialBytes);
  for (let at = 0; at < artificialBytes; at += ARTIFICIAL_SAMPLE.length) {
    tail.set(ARTIFICIAL_SAMPLE, at);
  }

  // Include the complete original mdat box (header and payload) without loading it into JS.
  const mdat = file.slice(mdatEntry.start, mdatEntry.end);

  return {
    blob: new Blob([ftypBytes, finalIndex, mdat, tail], { type: 'video/mp4' }),
    classification: 'OBSERVED',
    isoCompliant: false,
    validationStatus: 'NOT APPROVED',
    moovBytes: finalIndex.length,
    mdatBytes: mdatEntry.size,
    artificialSamples: clone.artificialSamples,
    artificialBytes,
    clonedTrackId: clone.trackId,
    sourceAudioSamples: clone.sourceSamples,
    dropped,
    offsetDelta: delta,
    passes,
    editListsRemoved,
  };
}

/* ------------------------------------------------------------ steps --- */

function removeEditLists(moov: MutableBox): number {
  let removed = 0;
  for (const trak of mutableFindAll(moov, 'trak')) {
    if (!trak.children) continue;
    const before = trak.children.length;
    trak.children = trak.children.filter((child) => child.type !== 'edts');
    if (trak.children.length !== before) removed++;
  }
  return removed;
}

interface CloneResult {
  readonly trackId: number;
  readonly sourceSamples: number;
  readonly artificialSamples: number;
  /** The clone's `stco`, so the layout pass can point its last chunk at the tail. */
  readonly stcoBox: MutableBox;
}

/** Deep-copies the sole AAC track, gives it max(track_ID)+1, and extends its tables. */
function cloneAacTrack(moov: MutableBox): CloneResult {
  const traks = (moov.children ?? []).filter((child) => child.type === 'trak');
  if (!traks.some((trak) => isVideoTrack(trak))) {
    throw new ObservedTransformError('Observed Haze 4.0 requires a video track.');
  }

  const audioTracks = traks.filter((trak) => isAudioTrack(trak));
  if (audioTracks.length !== 1) {
    throw new ObservedTransformError(
      `Observed Haze 4.0 requires exactly one AAC audio track; found ${audioTracks.length}.`,
    );
  }

  const source = audioTracks[0]!;
  if (!isAacTrack(source)) {
    throw new ObservedTransformError('The sole audio track is not AAC/mp4a.');
  }

  // Enforce count and resource limits before readStsz or writeStsz allocate large arrays.
  const sourceSamples = readObservedSourceSampleCount(source);
  const artificialSamples = sourceSamples * PAD_MULTIPLIER;

  // The current reference first normalises the original AAC timing and declared maximum
  // bitrate, then clones that already-normalised track.
  normalizeObservedAacTrack(source);
  const clone = deepCopy(source);

  const mvhd = mutableChild(moov, 'mvhd');
  if (!mvhd?.payload) throw new ObservedTransformError('The moov box has no mvhd.');

  const trackIds = mutableFindAll(moov, 'tkhd').map((tkhd) => {
    if (!tkhd.payload) throw new ObservedTransformError('A track has no readable tkhd payload.');
    const position = tkhd.payload[0] === 1 ? 20 : 12;
    if (tkhd.payload.length < position + 4) {
      throw new ObservedTransformError('A tkhd box is too short to contain track_ID.');
    }
    return readTkhdTrackId(tkhd.payload);
  });
  const maxTrackId = Math.max(0, ...trackIds);
  if (maxTrackId >= MAX_U32 - 1) {
    throw new ObservedTransformError(
      'No 32-bit values remain for both the cloned track_ID and mvhd.next_track_ID.',
    );
  }
  const trackId = maxTrackId + 1;

  const cloneTkhd = mutableChild(clone, 'tkhd');
  if (!cloneTkhd?.payload) throw new ObservedTransformError('The cloned track has no tkhd.');
  writeTkhdTrackId(cloneTkhd, trackId);
  writeMvhdNextTrackId(mvhd, trackId + 1);

  const stbl = mutableChild(mutableChild(mutableChild(clone, 'mdia'), 'minf'), 'stbl');
  if (!stbl) throw new ObservedTransformError('The cloned track has no sample table.');
  if (mutableFindAll(clone, 'stsz').length !== 1 || mutableFindAll(clone, 'stco').length !== 1) {
    throw new ObservedTransformError('The AAC track must contain exactly one stsz and one stco.');
  }
  if (mutableFindAll(clone, 'co64').length > 0) {
    throw new ObservedTransformError('The AAC track uses co64 instead of the observed stco form.');
  }

  const stts = readStts(stbl);
  const stsz = readStsz(stbl);
  const stsc = readStsc(stbl);
  const stco = allChunkOffsetTables(clone)[0];
  if (!stts || !stsz || !stsc || !stco || stco.kind !== 'stco') {
    throw new ObservedTransformError('The AAC track is missing part of its observed sample table.');
  }

  requireExactTable(stts.box, 8, 'stts');
  requireExactTable(stsc.box, 12, 'stsc');
  requireExactTable(stco.box, 4, 'stco');

  const stszPayload = stsz.box.payload;
  if (!stszPayload || stszPayload.length < 12) {
    throw new ObservedTransformError('The AAC stsz table is truncated.');
  }
  const uniformSize = readUint32(stszPayload, 4);
  const declaredSamples = readUint32(stszPayload, 8);
  if (uniformSize !== 0 || stsz.wasUniform) {
    throw new ObservedTransformError('The observed transform requires a variable-size AAC stsz table.');
  }
  if (stszPayload.length !== 12 + declaredSamples * 4 || stsz.sizes.length !== declaredSamples) {
    throw new ObservedTransformError('The AAC stsz table is padded or truncated.');
  }

  if (declaredSamples !== sourceSamples) {
    throw new ObservedTransformError('The AAC sample count changed during preparation.');
  }
  const chunkCount = stco.offsets.length;
  if (sourceSamples <= 0 || chunkCount <= 0) {
    throw new ObservedTransformError('The AAC sample or chunk table is empty.');
  }

  writeStts(stts.box, [
    ...stts.entries,
    { count: artificialSamples, delta: ARTIFICIAL_SAMPLE_DURATION },
  ]);
  writeStsz(stsz.box, [
    ...stsz.sizes,
    ...new Array<number>(artificialSamples).fill(ARTIFICIAL_SAMPLE.length),
  ]);
  writeStsc(stsc.box, [
    ...stsc.entries,
    {
      firstChunk: chunkCount + 1,
      samplesPerChunk: artificialSamples,
      sampleDescriptionIndex: 1,
    },
  ]);
  writeChunkOffsets(stco, [...stco.offsets, 0], { allowCountChange: true });

  const mdhd = mutableChild(mutableChild(clone, 'mdia'), 'mdhd');
  if (!mdhd?.payload) throw new ObservedTransformError('The cloned track has no mdhd.');
  const { duration } = readMdhdDuration(mdhd.payload);
  writeMdhdDuration(mdhd, duration + artificialSamples * ARTIFICIAL_SAMPLE_DURATION);

  // The observed writer appends the clone after the complete direct trak block.
  const children = moov.children!;
  let lastTrackIndex = -1;
  for (let index = 0; index < children.length; index++) {
    if (children[index]!.type === 'trak') lastTrackIndex = index;
  }
  if (lastTrackIndex < 0) throw new ObservedTransformError('The moov box contains no tracks.');
  children.splice(lastTrackIndex + 1, 0, clone);

  const attached = allChunkOffsetTables(clone)[0];
  if (!attached || attached.kind !== 'stco') {
    throw new ObservedTransformError('The clone lost its stco chunk offset table.');
  }

  return { trackId, sourceSamples, artificialSamples, stcoBox: attached.box };
}

function trackHandler(trak: MutableBox): string | null {
  const hdlr = mutableChild(mutableChild(trak, 'mdia'), 'hdlr')?.payload;
  if (!hdlr || hdlr.length < 12) return null;
  return String.fromCharCode(hdlr[8]!, hdlr[9]!, hdlr[10]!, hdlr[11]!);
}

function isVideoTrack(trak: MutableBox): boolean {
  return trackHandler(trak) === 'vide';
}

function isAudioTrack(trak: MutableBox): boolean {
  return trackHandler(trak) === 'soun';
}

function isAacTrack(trak: MutableBox): boolean {
  if (!isAudioTrack(trak)) return false;
  const stsd = mutableChild(
    mutableChild(mutableChild(mutableChild(trak, 'mdia'), 'minf'), 'stbl'),
    'stsd',
  )?.payload;
  if (!stsd || stsd.length < 16) return false;
  // version/flags(4), entry_count(4), sample-entry size(4), format(4)
  return String.fromCharCode(stsd[12]!, stsd[13]!, stsd[14]!, stsd[15]!) === 'mp4a';
}

/** Reads the raw stsz count and rejects unsafe expansion before allocating sample arrays. */
function readObservedSourceSampleCount(trak: MutableBox): number {
  const stbl = mutableChild(mutableChild(mutableChild(trak, 'mdia'), 'minf'), 'stbl');
  const stszBoxes = mutableFindAll(trak, 'stsz');
  const stsd = mutableChild(stbl, 'stsd');
  if (!stbl || stszBoxes.length !== 1 || !stszBoxes[0]?.payload || !stsd?.payload) {
    throw new ObservedTransformError('The AAC track must contain one readable stsz and stsd.');
  }

  const stsdEntryCount = stsd.payload.length >= 8 ? readUint32(stsd.payload, 4) : 0;
  if (stsdEntryCount !== 1) {
    throw new ObservedTransformError('The AAC track must contain exactly one sample description.');
  }

  const payload = stszBoxes[0].payload;
  if (payload.length < 12) throw new ObservedTransformError('The AAC stsz table is truncated.');
  const uniformSize = readUint32(payload, 4);
  const sampleCount = readUint32(payload, 8);
  if (uniformSize !== 0) {
    throw new ObservedTransformError('The observed transform requires a variable-size AAC stsz table.');
  }
  if (sampleCount <= 0 || payload.length !== 12 + sampleCount * 4) {
    throw new ObservedTransformError('The AAC stsz table is empty, padded or truncated.');
  }

  const artificialSamples = sampleCount * PAD_MULTIPLIER;
  const trailerBytes = artificialSamples * ARTIFICIAL_SAMPLE.length;
  if (
    !Number.isSafeInteger(artificialSamples) ||
    sampleCount + artificialSamples > MAX_U32 ||
    trailerBytes > MAX_TRAILER_SIZE
  ) {
    throw new ObservedTransformError('The artificial sample table or trailer exceeds the supported size.');
  }
  if (estimateObservedWorkingSet(sampleCount) > MAX_OBSERVED_WORKING_SET) {
    throw new ObservedTransformError(
      'The observed table expansion would exceed the browser memory budget.',
    );
  }
  return sampleCount;
}

/**
 * Matches the AAC normalisation present in the current real reference output.
 *
 * `mdhd.duration` is brought in line with the complete decoding timeline in `stts`.
 * The maximum bitrate fields in both `esds` and `btrt` are replaced by the encoded
 * payload bitrate calculated from the source duration. Average bitrate is preserved.
 */
function normalizeObservedAacTrack(trak: MutableBox): void {
  const mdia = mutableChild(trak, 'mdia');
  const mdhd = mutableChild(mdia, 'mdhd');
  const stbl = mutableChild(mutableChild(mdia, 'minf'), 'stbl');
  if (!mdhd?.payload || !stbl) {
    throw new ObservedTransformError('The AAC track is missing mdhd or stbl.');
  }

  const stts = readStts(stbl);
  const stsz = readStsz(stbl);
  const stsd = mutableChild(stbl, 'stsd');
  if (!stts || !stsz || !stsd?.payload) {
    throw new ObservedTransformError('The AAC track is missing stts, stsz or stsd.');
  }
  requireExactTable(stts.box, 8, 'stts');

  const stszPayload = stsz.box.payload;
  if (!stszPayload || stszPayload.length < 12) {
    throw new ObservedTransformError('The AAC stsz table is truncated.');
  }
  const uniformSize = readUint32(stszPayload, 4);
  const declaredSamples = readUint32(stszPayload, 8);
  if (uniformSize !== 0 || stsz.wasUniform) {
    throw new ObservedTransformError('The observed transform requires a variable-size AAC stsz table.');
  }
  if (stszPayload.length !== 12 + declaredSamples * 4 || stsz.sizes.length !== declaredSamples) {
    throw new ObservedTransformError('The AAC stsz table is padded or truncated.');
  }

  const timelineTicks = stts.entries.reduce(
    (sum, entry) => sum + BigInt(entry.count) * BigInt(entry.delta),
    0n,
  );
  if (timelineTicks <= 0n || timelineTicks > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ObservedTransformError('The AAC decoding timeline is empty or too large.');
  }

  const { duration, timescale } = readMdhdDuration(mdhd.payload);
  if (duration <= 0 || timescale <= 0) {
    throw new ObservedTransformError('The AAC mdhd duration or timescale is invalid.');
  }

  const payloadBits = stsz.sizes.reduce((sum, size) => sum + BigInt(size) * 8n, 0n);
  const maximumBitrate = (payloadBits * BigInt(timescale)) / BigInt(duration);
  if (maximumBitrate < 0n || maximumBitrate > BigInt(MAX_U32)) {
    throw new ObservedTransformError('The derived AAC maximum bitrate does not fit 32 bits.');
  }

  patchAacMaximumBitrate(stsd, Number(maximumBitrate));
  writeMdhdDuration(mdhd, Number(timelineTicks));
}

/** Updates maxBitrate in the first mp4a entry's esds and btrt sub-boxes. */
function patchAacMaximumBitrate(stsd: MutableBox, maximumBitrate: number): void {
  const source = stsd.payload;
  if (!source || source.length < 24) {
    throw new ObservedTransformError('The AAC stsd payload is truncated.');
  }
  const payload = new Uint8Array(source);
  const entryCount = readUint32(payload, 4);
  if (entryCount !== 1) {
    throw new ObservedTransformError('The AAC stsd must contain exactly one sample entry.');
  }

  const entryStart = 8;
  const entrySize = readUint32(payload, entryStart);
  const entryEnd = entryStart + entrySize;
  if (entrySize < 36 || entryEnd > payload.length) {
    throw new ObservedTransformError('The AAC sample entry is truncated.');
  }
  const format = String.fromCharCode(
    payload[entryStart + 4]!,
    payload[entryStart + 5]!,
    payload[entryStart + 6]!,
    payload[entryStart + 7]!,
  );
  if (format !== 'mp4a') throw new ObservedTransformError('The audio sample entry is not mp4a.');

  let at = entryStart + 16; // sample-entry header + reserved/data_reference_index
  const quickTimeVersion = readUint16(payload, at);
  at += 20; // version/revision/vendor/channels/sample size/compression/packet/rate
  if (quickTimeVersion === 1) at += 16;
  else if (quickTimeVersion === 2) at += 36;
  if (at > entryEnd) throw new ObservedTransformError('The mp4a fixed header is truncated.');

  while (at + 8 <= entryEnd) {
    const size = readUint32(payload, at);
    if (size < 8 || at + size > entryEnd) {
      throw new ObservedTransformError('A sub-box in the mp4a sample entry is malformed.');
    }
    const type = String.fromCharCode(payload[at + 4]!, payload[at + 5]!, payload[at + 6]!, payload[at + 7]!);
    const bodyStart = at + 8;
    const bodyEnd = at + size;
    if (type === 'esds') patchEsdsMaximumBitrate(payload, bodyStart, bodyEnd, maximumBitrate);
    if (type === 'btrt' && bodyEnd - bodyStart >= 12) {
      writeUint32(payload, bodyStart + 4, maximumBitrate);
    }
    at += size;
  }

  stsd.payload = payload;
}

function patchEsdsMaximumBitrate(
  payload: Uint8Array,
  start: number,
  end: number,
  maximumBitrate: number,
): void {
  let at = start;
  if (end - at < 4) return;
  at += 4; // FullBox version/flags
  if (at >= end || payload[at++] !== 0x03) return; // ES_Descriptor

  const esLength = readDescriptorLength(payload, at, end);
  if (!esLength) return;
  at = esLength.next;
  if (at + 3 > end) return;
  at += 2; // ES_ID
  const flags = payload[at++]!;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) {
    if (at >= end) return;
    at += 1 + payload[at]!;
  }
  if (flags & 0x20) at += 2;
  if (at >= end || payload[at++] !== 0x04) return; // DecoderConfigDescriptor

  const configLength = readDescriptorLength(payload, at, end);
  if (!configLength) return;
  at = configLength.next;
  // objectTypeIndication(1), streamType/upStream(1), bufferSizeDB(3), maxBitrate(4)
  if (at + 9 > end) return;
  at += 5;
  writeUint32(payload, at, maximumBitrate);
}

function readDescriptorLength(
  bytes: Uint8Array,
  start: number,
  end: number,
): { length: number; next: number } | null {
  let length = 0;
  let at = start;
  for (let index = 0; index < 4; index++) {
    if (at >= end) return null;
    const byte = bytes[at++]!;
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { length, next: at };
  }
  return null;
}

function readUint16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function writeUint32(bytes: Uint8Array, at: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32 || at < 0 || at + 4 > bytes.length) {
    throw new ObservedTransformError(`Cannot write 32-bit value ${value} at byte ${at}.`);
  }
  bytes[at] = (value >>> 24) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

function deepCopy(box: MutableBox): MutableBox {
  return {
    type: box.type,
    payload: box.payload ? new Uint8Array(box.payload) : null,
    prefix: box.prefix ? new Uint8Array(box.prefix) : null,
    children: box.children ? box.children.map(deepCopy) : null,
  };
}

/**
 * Replaces or appends `©too` in every existing ilst, preserving every sibling and all
 * metadata hierarchy. If no ilst exists, the source is left untouched, matching the
 * measured writer rather than inventing `udta/meta/ilst`.
 */
function writeEncoderTag(moov: MutableBox, tag: string): void {
  const makeTag = (): MutableBox => {
    const text = new TextEncoder().encode(tag);
    const data: MutableBox = {
      type: 'data',
      payload: concatBytes([new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), text]),
      prefix: null,
      children: null,
    };
    return { type: COPYRIGHT_TOO, payload: null, prefix: null, children: [data] };
  };

  for (const ilst of mutableFindAll(moov, 'ilst')) {
    ilst.children ??= [];
    let found = false;
    ilst.children = ilst.children.map((child) => {
      if (child.type !== COPYRIGHT_TOO) return child;
      found = true;
      return makeTag();
    });
    if (!found) ilst.children.push(makeTag());
  }
}

function requireExactTable(box: MutableBox, entryWidth: number, name: string): void {
  const payload = box.payload;
  if (!payload || payload.length < 8) {
    throw new ObservedTransformError(`The ${name} table is truncated.`);
  }
  const count = readUint32(payload, 4);
  if (payload.length !== 8 + count * entryWidth) {
    throw new ObservedTransformError(`The ${name} table is padded or truncated.`);
  }
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Checks that real chunks land inside `mdat` and the artificial chunk in the tail. */
function verifyOffsets(
  moov: MutableBox,
  clone: CloneResult,
  dataStart: number,
  dataLength: number,
  artificialStart: number,
  artificialBytes: number,
): void {
  const dataEnd = dataStart + dataLength;
  const tailEnd = artificialStart + artificialBytes;

  for (const table of allChunkOffsetTables(moov)) {
    const isClone = table.box === clone.stcoBox;
    for (const [index, offset] of table.offsets.entries()) {
      const isArtificial = isClone && index === table.offsets.length - 1;
      if (isArtificial) {
        if (offset !== artificialStart) {
          throw new ObservedTransformError(
            `The artificial chunk offset is ${offset}, expected ${artificialStart}.`,
          );
        }
        if (offset + artificialBytes !== tailEnd) {
          throw new ObservedTransformError('The artificial tail does not line up with its chunk.');
        }
        continue;
      }
      if (offset < dataStart || offset >= dataEnd) {
        throw new ObservedTransformError(
          `A chunk offset (${offset}) falls outside the media payload (${dataStart}..${dataEnd}).`,
        );
      }
    }
  }
}

/** The three lines every caller should surface alongside the output. */
export const OBSERVED_DISCLOSURE = [
  'CLASSIFICATION: OBSERVED',
  'ISO BMFF COMPLIANT: NO',
  'VALIDATION STATUS: NOT APPROVED',
] as const;
