/**
 * Native container rewriting: no ffmpeg, no WebAssembly, no 31 MB download.
 *
 * Moving an MP4's index to the front is bookkeeping, not transcoding. The media payload
 * is copied verbatim; the only thing that changes is the chunk offset table that says
 * where each chunk of it starts. Handing that job to a WebAssembly build of ffmpeg means
 * downloading 31 MB and loading the entire file into wasm memory to accomplish what is
 * arithmetic over a few thousand integers.
 *
 * The payload never enters JavaScript memory here. The output is assembled as a Blob whose
 * last part is a slice of the source File, so the browser streams those bytes straight
 * from disk to the download. A 500 MB input costs about as much memory as a 5 MB one.
 */
import {
  type MediaReport,
  type MutableBox,
  allChunkOffsetTables,
  measure,
  mutableChild,
  parseBoxes,
  readBox,
  Reader,
  scanTopLevel,
  serialize,
  toMutable,
  writeChunkOffsets,
} from './mp4/index';
import type { TopLevelEntry } from './mp4/index';

/** Padding boxes, safe to drop: they exist only to reserve space. */
const DROPPABLE = new Set(['free', 'skip', 'wide']);

/** Boxes we know how to place in the output. Anything else means falling back. */
const KNOWN_TOP_LEVEL = new Set(['ftyp', 'moov', 'mdat', ...DROPPABLE]);

/**
 * Offsets are recomputed from the new layout, but promoting `stco` to `co64` grows the
 * moov, which moves the payload, which changes the offsets. Two passes normally settle
 * it; this is the point at which we stop trying and report a problem instead of shipping
 * something inconsistent.
 */
const MAX_LAYOUT_PASSES = 6;

export interface RemuxSupport {
  readonly supported: boolean;
  /** Why the native path cannot be used, for the log and for choosing a fallback. */
  readonly reason: string;
}

/**
 * Whether the file's top-level layout is simple enough to rewrite directly.
 *
 * Deliberately strict. Everything rejected here still works through ffmpeg; being wrong
 * in the other direction produces a corrupt file.
 */
export function canRemuxNatively(report: MediaReport): RemuxSupport {
  if (report.fragmented) {
    return { supported: false, reason: 'the file is fragmented, which needs a real remuxer' };
  }

  const types = report.topLevel.map((b) => b.type);
  const unknown = types.filter((t) => !KNOWN_TOP_LEVEL.has(t));
  if (unknown.length > 0) {
    return {
      supported: false,
      reason: `unexpected top-level box(es): ${[...new Set(unknown)].join(', ')}`,
    };
  }

  const mdats = types.filter((t) => t === 'mdat').length;
  if (mdats !== 1) {
    return {
      supported: false,
      reason: mdats === 0 ? 'no mdat box' : `media is split across ${mdats} mdat boxes`,
    };
  }
  if (types.filter((t) => t === 'moov').length !== 1) {
    return { supported: false, reason: 'expected exactly one moov box' };
  }
  if (!types.includes('ftyp')) {
    return { supported: false, reason: 'no ftyp box to identify the container' };
  }

  return { supported: true, reason: '' };
}

export interface RemuxResult {
  readonly blob: Blob;
  readonly moovBytes: number;
  readonly mdatBytes: number;
  /** Padding boxes that were left out. */
  readonly dropped: readonly string[];
  /** True when an offset table had to grow to 64-bit entries. */
  readonly promotedToCo64: boolean;
  /** Byte shift applied to every chunk offset. */
  readonly offsetDelta: number;
  /** How many layout passes it took to settle. */
  readonly passes: number;
}

export interface RemuxOptions {
  /**
   * Rewrites the video sample entry's colour box to Rec.709. Metadata only: no sample
   * data is touched, so the result is still bit-identical media.
   */
  readonly retagRec709?: boolean;
}

export class RemuxError extends Error {
  override readonly name = 'RemuxError';
}

/**
 * Rebuilds `file` as `[ftyp][moov][mdat]` with every chunk offset corrected.
 */
export async function remuxNatively(file: File, options: RemuxOptions = {}): Promise<RemuxResult> {
  const entries = await scanTopLevel(file);

  const ftypEntry = entries.find((e) => e.type === 'ftyp');
  const moovEntry = entries.find((e) => e.type === 'moov');
  const mdatEntry = entries.find((e) => e.type === 'mdat');
  if (!ftypEntry || !moovEntry || !mdatEntry) {
    throw new RemuxError('This file needs an ftyp, a moov and an mdat box to be rewritten directly.');
  }

  const ftypBytes = await readBox(file, ftypEntry);
  const moov = await readMoov(file, moovEntry);

  const dropped = entries.filter((e) => DROPPABLE.has(e.type)).map((e) => e.type);

  if (options.retagRec709) {
    retagToRec709(moov);
  }

  const tables = allChunkOffsetTables(moov);
  const sourceOffsets = tables.map((t) => [...t.offsets]);

  // Where the payload sits in the source, and how big it is. Chunk offsets are absolute
  // file positions pointing into this range.
  const sourceDataStart = mdatEntry.start + mdatEntry.headerSize;
  const dataLength = mdatEntry.size - mdatEntry.headerSize;

  assertOffsetsWithin(sourceOffsets, sourceDataStart, dataLength, 'source');

  // Solve for the layout. Each pass writes offsets based on the current moov size; if
  // writing changed that size, the offsets are stale and we go round again.
  let delta = 0;
  let promotedToCo64 = false;
  let passes = 0;

  for (let pass = 1; pass <= MAX_LAYOUT_PASSES; pass++) {
    passes = pass;
    const moovSize = measure(moov);
    const newDataStart = ftypBytes.length + moovSize + mdatEntry.headerSize;
    const nextDelta = newDataStart - sourceDataStart;

    for (const [index, table] of tables.entries()) {
      const shifted = sourceOffsets[index]!.map((offset) => offset + nextDelta);
      const before = table.box.type;
      writeChunkOffsets(table, shifted);
      if (table.box.type !== before) promotedToCo64 = true;
    }

    const settledSize = measure(moov);
    delta = nextDelta;
    if (settledSize === moovSize) break;

    if (pass === MAX_LAYOUT_PASSES) {
      throw new RemuxError(
        'Could not settle the new file layout: the index kept changing size as offsets ' +
          'were rewritten. Falling back to the transcoding engine.',
      );
    }
  }

  const moovBytes = serialize(moov);
  const newDataStart = ftypBytes.length + moovBytes.length + mdatEntry.headerSize;

  // Final check before anything is handed back, re-read from the boxes rather than from
  // the in-memory mirror, so it validates what was actually written. A wrong offset here
  // produces a file that opens, reports the right duration, and plays noise.
  assertOffsetsWithin(
    allChunkOffsetTables(moov).map((t) => t.offsets),
    newDataStart,
    dataLength,
    'rewritten',
  );

  // The payload is referenced, not read: this slice stays a Blob backed by the file on
  // disk, so the bytes go straight to the download without passing through JS memory.
  const payload = file.slice(mdatEntry.start, mdatEntry.end);

  return {
    blob: new Blob([ftypBytes, moovBytes, payload], { type: 'video/mp4' }),
    moovBytes: moovBytes.length,
    mdatBytes: mdatEntry.size,
    dropped,
    promotedToCo64,
    offsetDelta: delta,
    passes,
  };
}

async function readMoov(file: File, entry: TopLevelEntry): Promise<MutableBox> {
  const bytes = await readBox(file, entry);
  const reader = new Reader(bytes, entry.start);
  return toMutable({
    type: 'moov',
    start: entry.start,
    size: entry.size,
    headerSize: entry.headerSize,
    end: entry.end,
    payload: null,
    prefix: null,
    children: parseBoxes(reader, entry.headerSize, bytes.length, {
      strict: true,
      parentType: 'moov',
    }),
  });
}

function assertOffsetsWithin(
  tables: readonly (readonly number[])[],
  dataStart: number,
  dataLength: number,
  label: string,
): void {
  const dataEnd = dataStart + dataLength;
  for (const offsets of tables) {
    for (const offset of offsets) {
      if (offset < dataStart || offset >= dataEnd) {
        throw new RemuxError(
          `A ${label} chunk offset (${offset}) falls outside the media payload ` +
            `(${dataStart}..${dataEnd}). Aborting rather than writing a corrupt file.`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ retag --- */

/** `colr` payload declaring Rec.709 primaries, transfer and matrix, limited range. */
const REC709_COLR = new Uint8Array([
  0x6e, 0x63, 0x6c, 0x78, // 'nclx'
  0x00, 0x01, // colour primaries: BT.709
  0x00, 0x01, // transfer characteristics: BT.709
  0x00, 0x01, // matrix coefficients: BT.709
  0x00, // full range flag clear
]);

/**
 * Inserts or replaces the `colr` box in every video sample entry.
 *
 * `stsd` is kept as an opaque leaf by the parser, because its sample entries are boxes
 * wrapped in a fixed-size header that varies by track kind. So this edits the payload
 * bytes directly: walk to the sample entry, find any existing `colr`, and splice.
 */
function retagToRec709(moov: MutableBox): void {
  for (const trak of moov.children ?? []) {
    if (trak.type !== 'trak') continue;
    const stbl = mutableChild(mutableChild(mutableChild(trak, 'mdia'), 'minf'), 'stbl');
    const stsd = mutableChild(stbl, 'stsd');
    if (!stsd?.payload) continue;

    const handler = readHandler(trak);
    if (handler !== 'vide') continue;

    stsd.payload = spliceColr(stsd.payload);
  }
}

function readHandler(trak: MutableBox): string {
  const hdlr = mutableChild(mutableChild(trak, 'mdia'), 'hdlr')?.payload;
  if (!hdlr || hdlr.length < 12) return '';
  return String.fromCharCode(hdlr[8]!, hdlr[9]!, hdlr[10]!, hdlr[11]!);
}

/** Bytes from the start of a visual sample entry to its first sub-box. */
const VISUAL_ENTRY_PREAMBLE = 86;

function spliceColr(stsd: Uint8Array): Uint8Array {
  const readU32 = (at: number) =>
    ((stsd[at]! << 24) | (stsd[at + 1]! << 16) | (stsd[at + 2]! << 8) | stsd[at + 3]!) >>> 0;
  const fourccAt = (at: number) =>
    String.fromCharCode(stsd[at]!, stsd[at + 1]!, stsd[at + 2]!, stsd[at + 3]!);

  // version/flags(4) entry_count(4), then the entries.
  if (stsd.length < 16) return stsd;
  const entryCount = readU32(4);
  if (entryCount < 1) return stsd;

  const entryStart = 8;
  const entrySize = readU32(entryStart);
  const entryEnd = Math.min(entryStart + entrySize, stsd.length);
  if (entrySize < VISUAL_ENTRY_PREAMBLE) return stsd;

  const colr = buildBox('colr', REC709_COLR);

  // Look for an existing colr among the sub-boxes and replace it in place.
  let at = entryStart + VISUAL_ENTRY_PREAMBLE;
  while (at + 8 <= entryEnd) {
    const size = readU32(at);
    const type = fourccAt(at + 4);
    if (size < 8 || at + size > entryEnd) break;
    if (type === 'colr') {
      const grown = colr.length - size;
      return rebuild(stsd, entryStart, entrySize + grown, [
        stsd.subarray(0, at),
        colr,
        stsd.subarray(at + size),
      ]);
    }
    at += size;
  }

  // No colr present: append one at the end of the sample entry, where sub-boxes live.
  return rebuild(stsd, entryStart, entrySize + colr.length, [
    stsd.subarray(0, entryEnd),
    colr,
    stsd.subarray(entryEnd),
  ]);
}

/** Reassembles an stsd payload and patches the sample entry's own size field. */
function rebuild(
  stsd: Uint8Array,
  entryStart: number,
  newEntrySize: number,
  parts: readonly Uint8Array[],
): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  // The sample entry declares its own length, and it just changed.
  out[entryStart] = (newEntrySize >>> 24) & 0xff;
  out[entryStart + 1] = (newEntrySize >>> 16) & 0xff;
  out[entryStart + 2] = (newEntrySize >>> 8) & 0xff;
  out[entryStart + 3] = newEntrySize & 0xff;
  return out;
}

function buildBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const size = out.length;
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  out.set(payload, 8);
  return out;
}
