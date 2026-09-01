/**
 * Observed Haze 4.0 — a replication of a third-party container transformation.
 *
 * WHAT THIS IS
 *
 * A reverse-engineered copy of what the Haze Engine 4.0 does to an MP4, derived by
 * comparing a real input against its real output byte for byte, not from documentation.
 * Every constant here was measured, and the tests assert the output matches the reference
 * file's structure.
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
  readMvhdNextTrackId,
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

/** Padding boxes that are dropped, matching the reference output. */
const DROPPABLE = new Set(['free', 'skip', 'wide']);
const KNOWN_TOP_LEVEL = new Set(['ftyp', 'moov', 'mdat', ...DROPPABLE]);

/** Layout passes before giving up. Offsets and index size depend on each other. */
const MAX_LAYOUT_PASSES = 6;

export class ObservedTransformError extends Error {
  override readonly name = 'ObservedTransformError';
}

export interface ObservedSupport {
  readonly supported: boolean;
  readonly reason: string;
  /**
   * True when the file is otherwise suitable but its audio is not AAC. The transformation
   * clones an AAC track, so a different codec needs converting first.
   */
  readonly needsAacPreparation: boolean;
}

/** Whether the exact replication can be applied to this file. */
export function canApplyObserved(report: MediaReport): ObservedSupport {
  const no = (reason: string, needsAacPreparation = false): ObservedSupport => ({
    supported: false,
    reason,
    needsAacPreparation,
  });

  if (report.fragmented) return no('the file is fragmented');

  const types = report.topLevel.map((b) => b.type);
  const unknown = types.filter((t) => !KNOWN_TOP_LEVEL.has(t));
  if (unknown.length > 0) {
    return no(`unexpected top-level box(es): ${[...new Set(unknown)].join(', ')}`);
  }
  if (types.filter((t) => t === 'mdat').length !== 1) {
    return no('the media is not in a single mdat box');
  }
  if (!types.includes('ftyp') || !types.includes('moov')) {
    return no('the file is missing an ftyp or moov box');
  }
  if (!report.video) return no('there is no video track');

  const audioTracks = report.tracks.filter((t) => t.kind === 'audio');
  if (audioTracks.length === 0) {
    return no('there is no audio track to clone', true);
  }
  if (!audioTracks.some((t) => t.format === 'mp4a')) {
    const found = audioTracks.map((t) => t.codecLabel).join(', ');
    return no(`the audio is ${found}, not AAC, so the exact replication does not apply`, true);
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
   * Encoder tag written into `udta/meta/ilst/©too`.
   *
   * Defaults to this project's own name. The reference output writes the originating
   * tool's name there; copying that string would misattribute the file, and nothing
   * suggests the tag affects how the transformation is received.
   */
  readonly encoderTag?: string;
}

const DEFAULT_ENCODER_TAG = 'Observed transform (spec-noncompliant)';

export async function applyObservedTransform(
  file: File,
  options: ObservedOptions = {},
): Promise<ObservedResult> {
  const entries = await scanTopLevel(file);
  const ftypEntry = entries.find((e) => e.type === 'ftyp');
  const moovEntry = entries.find((e) => e.type === 'moov');
  const mdatEntry = entries.find((e) => e.type === 'mdat');
  if (!ftypEntry || !moovEntry || !mdatEntry) {
    throw new ObservedTransformError('This file needs an ftyp, a moov and an mdat box.');
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

  const dropped = entries.filter((e) => DROPPABLE.has(e.type)).map((e) => e.type);

  // Step 3: strip edit lists from the original tracks.
  const editListsRemoved = removeEditLists(moov);

  // Steps 5 and 6: clone the AAC track and extend it.
  const clone = cloneAacTrack(moov);

  // Step 12: identify the file.
  writeEncoderTag(moov, options.encoderTag ?? DEFAULT_ENCODER_TAG);

  const sourceDataStart = mdatEntry.start + mdatEntry.headerSize;
  const dataLength = mdatEntry.size - mdatEntry.headerSize;
  const artificialBytes = clone.artificialSamples * ARTIFICIAL_SAMPLE.length;

  // Every real chunk offset shifts by the same delta; the clone's final chunk points past
  // the end of mdat, at the artificial tail. Both depend on the index size, which changes
  // as offsets are written, so solve for a fixed point.
  const tables = allChunkOffsetTables(moov);
  const sourceOffsets = tables.map((t) => [...t.offsets]);
  const cloneTableIndex = tables.findIndex((t) => t.box === clone.stcoBox);
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
    // Step 11: the artificial chunk sits immediately after the mdat box ends.
    const artificialStart = newDataStart + dataLength;

    for (const [index, table] of tables.entries()) {
      const shifted = sourceOffsets[index]!.map((offset) => offset + nextDelta);
      if (index === cloneTableIndex) {
        // The last entry was appended by the clone and is a placeholder until now.
        shifted[shifted.length - 1] = artificialStart;
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

  // The media payload is referenced as a slice of the source file, so the video and audio
  // bytes are copied verbatim without ever entering memory. That is what preserves the
  // elementary stream exactly.
  const payload = file.slice(mdatEntry.start, mdatEntry.end);

  return {
    blob: new Blob([ftypBytes, finalIndex, payload, tail], { type: 'video/mp4' }),
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

/**
 * Deep-copies the AAC track, gives it a new id, and appends the artificial samples.
 */
function cloneAacTrack(moov: MutableBox): CloneResult {
  const traks = (moov.children ?? []).filter((c) => c.type === 'trak');
  const source = traks.find((trak) => isAacTrack(trak));
  if (!source) {
    throw new ObservedTransformError('No AAC audio track to clone.');
  }

  const clone = deepCopy(source);

  // Step 6: a fresh track_ID, and mvhd's counter moves on.
  const mvhd = mutableChild(moov, 'mvhd');
  if (!mvhd?.payload) throw new ObservedTransformError('The moov box has no mvhd.');
  const trackId = readMvhdNextTrackId(mvhd.payload);
  const cloneTkhd = mutableChild(clone, 'tkhd');
  if (!cloneTkhd?.payload) throw new ObservedTransformError('The cloned track has no tkhd.');
  writeTkhdTrackId(cloneTkhd, trackId);
  writeMvhdNextTrackId(mvhd, trackId + 1);

  const stbl = mutableChild(mutableChild(mutableChild(clone, 'mdia'), 'minf'), 'stbl');
  if (!stbl) throw new ObservedTransformError('The cloned track has no sample table.');

  const stts = readStts(stbl);
  const stsz = readStsz(stbl);
  const stsc = readStsc(stbl);
  const stco = allChunkOffsetTables(clone)[0];
  if (!stts || !stsz || !stsc || !stco) {
    throw new ObservedTransformError('The AAC track is missing part of its sample table.');
  }

  const sourceSamples = stsz.sizes.length;
  if (sourceSamples === 0) {
    throw new ObservedTransformError('The AAC track declares no samples.');
  }
  const artificialSamples = sourceSamples * PAD_MULTIPLIER;

  // Step 9: every table grows consistently.
  writeStts(stts.box, [
    ...stts.entries,
    { count: artificialSamples, delta: ARTIFICIAL_SAMPLE_DURATION },
  ]);

  writeStsz(stsz.box, [
    ...stsz.sizes,
    ...new Array<number>(artificialSamples).fill(ARTIFICIAL_SAMPLE.length),
  ]);

  // Step 10: one new chunk holding all of them. Chunk indices are 1-based.
  const chunkCount = stco.offsets.length;
  writeStsc(stsc.box, [
    ...stsc.entries,
    {
      firstChunk: chunkCount + 1,
      samplesPerChunk: artificialSamples,
      sampleDescriptionIndex: 1,
    },
  ]);

  // One chunk is genuinely being added here, so the length guard is waived explicitly.
  // The offset is a placeholder; the layout pass fills it in once the tail position is
  // known, which cannot happen until the index has its final size.
  writeChunkOffsets(stco, [...stco.offsets, 0], { allowCountChange: true });

  // Step 9: the media duration grows by one tick per artificial sample.
  const mdhd = mutableChild(mutableChild(clone, 'mdia'), 'mdhd');
  if (!mdhd?.payload) throw new ObservedTransformError('The cloned track has no mdhd.');
  const { duration } = readMdhdDuration(mdhd.payload);
  writeMdhdDuration(mdhd, duration + artificialSamples * ARTIFICIAL_SAMPLE_DURATION);

  // Inserted directly after the track it was copied from, matching the reference output.
  const children = moov.children!;
  children.splice(children.indexOf(source) + 1, 0, clone);

  // Re-read so the returned handle refers to the table now attached to the tree.
  const attached = allChunkOffsetTables(clone)[0];
  if (!attached) throw new ObservedTransformError('The clone lost its chunk offset table.');

  return { trackId, sourceSamples, artificialSamples, stcoBox: attached.box };
}

function isAacTrack(trak: MutableBox): boolean {
  const mdia = mutableChild(trak, 'mdia');
  const hdlr = mutableChild(mdia, 'hdlr')?.payload;
  if (!hdlr || hdlr.length < 12) return false;
  const handler = String.fromCharCode(hdlr[8]!, hdlr[9]!, hdlr[10]!, hdlr[11]!);
  if (handler !== 'soun') return false;

  const stsd = mutableChild(mutableChild(mutableChild(mdia, 'minf'), 'stbl'), 'stsd')?.payload;
  if (!stsd || stsd.length < 16) return false;
  // version/flags(4) entry_count(4) then size(4) format(4)
  return String.fromCharCode(stsd[12]!, stsd[13]!, stsd[14]!, stsd[15]!) === 'mp4a';
}

function deepCopy(box: MutableBox): MutableBox {
  return {
    type: box.type,
    // Payloads are copied rather than shared: the clone's tables are rewritten, and a
    // shared view would edit the original track too.
    payload: box.payload ? new Uint8Array(box.payload) : null,
    prefix: box.prefix ? new Uint8Array(box.prefix) : null,
    children: box.children ? box.children.map(deepCopy) : null,
  };
}

/** Writes `udta/meta/ilst/©too`, creating the chain if absent. */
function writeEncoderTag(moov: MutableBox, tag: string): void {
  const text = new TextEncoder().encode(tag);
  // data box: version/flags(4) reserved(4) then UTF-8 text. Type 1 means text.
  const data: MutableBox = {
    type: 'data',
    payload: concatBytes([new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), text]),
    prefix: null,
    children: null,
  };
  // The tag name begins with the 0xA9 copyright byte, which the reader renders escaped.
  const tooBox: MutableBox = { type: '\\xa9too', payload: null, prefix: null, children: [data] };
  const ilst: MutableBox = { type: 'ilst', payload: null, prefix: null, children: [tooBox] };
  const hdlr: MutableBox = {
    type: 'hdlr',
    payload: concatBytes([
      new Uint8Array(4), // version/flags
      new Uint8Array(4), // pre_defined
      new TextEncoder().encode('mdir'),
      new TextEncoder().encode('appl'),
      new Uint8Array(9), // reserved + empty name
    ]),
    prefix: null,
    children: null,
  };
  const meta: MutableBox = {
    type: 'meta',
    payload: null,
    // ISO-flavoured meta is a FullBox, so the version/flags word has to be present.
    prefix: new Uint8Array(4),
    children: [hdlr, ilst],
  };

  let udta = mutableChild(moov, 'udta');
  if (!udta) {
    udta = { type: 'udta', payload: null, prefix: null, children: [] };
    moov.children!.push(udta);
  }
  udta.children ??= [];
  udta.children = udta.children.filter((c) => c.type !== 'meta');
  udta.children.push(meta);
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

/**
 * Checks that real chunks land inside `mdat` and the artificial chunk lands in the tail.
 *
 * Worth being strict about even here: this transformation is already out of spec by
 * design, and an offset error on top of that would produce a file that is broken for
 * ordinary reasons rather than deliberate ones.
 */
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
