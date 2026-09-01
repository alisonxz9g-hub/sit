/**
 * Box serialisation and chunk-offset rewriting.
 *
 * This is what lets the app do container work itself instead of handing a 33 MB file to
 * a 31 MB WebAssembly build of ffmpeg. Moving the index to the front of a file is pure
 * bookkeeping: the media payload does not change at all, only the numbers that say where
 * it starts. Doing that natively takes milliseconds.
 *
 * The one thing that must be exactly right is `stco`/`co64`. Every entry is an absolute
 * file offset, so shifting the payload without updating them produces a file that opens,
 * reports the correct duration, and plays garbage. Every function here is written to fail
 * loudly rather than emit a plausible-looking wrong number.
 */
import type { Box } from './boxes';
import { fail } from './reader';

/**
 * A box tree that can be edited before being written back.
 *
 * Separate from the read-only `Box` because the reader's tree carries file offsets that
 * stop being meaningful the moment anything moves. Payloads are shared with the source
 * buffer rather than copied: they are only ever replaced wholesale, never mutated in
 * place, so sharing is safe and keeps a large moov cheap to work with.
 */
export interface MutableBox {
  type: string;
  payload: Uint8Array | null;
  /** Bytes between the header and the first child. See `Box.prefix`. */
  prefix: Uint8Array | null;
  children: MutableBox[] | null;
}

const MAX_U32 = 0xffffffff;

/* --------------------------------------------------------------- primitives --- */

/**
 * These return `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array` on purpose. A
 * plain `Uint8Array` is generic over `ArrayBufferLike`, which includes `SharedArrayBuffer`
 * and therefore does not satisfy `BlobPart`. Being precise here means the assembled output
 * can go straight into a `Blob` without a cast.
 */
export function u32(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    fail(`Cannot write ${value} as a 32-bit unsigned integer.`);
  }
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

export function u64(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`Cannot write ${value} as a 64-bit unsigned integer.`);
  }
  const out = new Uint8Array(8);
  const big = BigInt(value);
  for (let i = 0; i < 8; i++) {
    out[7 - i] = Number((big >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

export function fourcc(type: string): Uint8Array<ArrayBuffer> {
  // Box types are four bytes. `©too` style tags contain a byte above ASCII, which the
  // reader renders as an escape, so those round-trip through the escaped form.
  const unescaped = type.replace(/\\x([0-9a-f]{2})/gi, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  if (unescaped.length !== 4) {
    fail(`Box type "${type}" is not four bytes.`);
  }
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = unescaped.charCodeAt(i) & 0xff;
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
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

/* ------------------------------------------------------------------- tree --- */

/** Deep-copies the structure of a parsed box, sharing payload views. */
export function toMutable(box: Box): MutableBox {
  return {
    type: box.type,
    payload: box.payload,
    prefix: box.prefix,
    children: box.children ? box.children.map(toMutable) : null,
  };
}

export function mutableChild(box: MutableBox | null | undefined, type: string): MutableBox | null {
  if (!box?.children) return null;
  return box.children.find((c) => c.type === type) ?? null;
}

export function mutablePath(box: MutableBox | null | undefined, ...types: string[]): MutableBox | null {
  let current: MutableBox | null = box ?? null;
  for (const type of types) {
    current = mutableChild(current, type);
    if (!current) return null;
  }
  return current;
}

export function mutableFindAll(box: MutableBox, type: string, into: MutableBox[] = []): MutableBox[] {
  if (box.type === type) into.push(box);
  for (const child of box.children ?? []) mutableFindAll(child, type, into);
  return into;
}

/** Byte length a box will occupy once written, header included. */
export function measure(box: MutableBox): number {
  const body = box.children
    ? (box.prefix?.length ?? 0) + box.children.reduce((sum, c) => sum + measure(c), 0)
    : (box.payload?.length ?? 0);
  // A box needing more than 4 GiB switches to the 64-bit form, which costs 8 more bytes.
  return body + 8 > MAX_U32 ? body + 16 : body + 8;
}

/**
 * Writes a box and everything under it.
 *
 * Unmodified boxes come out byte-identical to the source, which the tests assert by
 * round-tripping every fixture. That property is what makes it safe to rebuild a moov
 * after touching only its offset tables.
 */
export function serialize(box: MutableBox): Uint8Array<ArrayBuffer> {
  const body = box.children
    ? concat([
        ...(box.prefix ? [box.prefix] : []),
        ...box.children.map((child) => serialize(child)),
      ])
    : (box.payload ?? new Uint8Array(0));

  if (body.length + 8 > MAX_U32) {
    // 64-bit form: size field is 1 and the real size follows the type.
    return concat([u32(1), fourcc(box.type), u64(body.length + 16), body]);
  }
  return concat([u32(body.length + 8), fourcc(box.type), body]);
}

/* --------------------------------------------------------- chunk offsets --- */

export interface ChunkOffsetTable {
  /** The `stco` or `co64` box itself, so it can be rewritten in place. */
  readonly box: MutableBox;
  kind: 'stco' | 'co64';
  /**
   * Absolute file offsets, one per chunk.
   *
   * Kept in sync by `writeChunkOffsets`. Callers that need to verify what was actually
   * written should still re-read from the box, since this is a mirror and mirrors go
   * stale.
   */
  offsets: number[];
}

/** Reads the chunk offset table out of an `stbl`. */
export function readChunkOffsets(stbl: MutableBox): ChunkOffsetTable | null {
  for (const kind of ['stco', 'co64'] as const) {
    const box = mutableChild(stbl, kind);
    if (!box?.payload) continue;

    const payload = box.payload;
    const wide = kind === 'co64';
    const stride = wide ? 8 : 4;
    if (payload.length < 8) fail(`'${kind}' is too short to hold an entry count.`);

    const count = readU32(payload, 4);
    const available = Math.floor((payload.length - 8) / stride);
    if (count > available) {
      fail(`'${kind}' declares ${count} chunk(s) but only ${available} fit in the box.`);
    }

    const offsets = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride;
      offsets[i] = wide ? readU64(payload, at) : readU32(payload, at);
    }
    return { box, kind, offsets };
  }
  return null;
}

/**
 * Writes offsets back, switching `stco` to `co64` when any value no longer fits in 32
 * bits. That switch changes the box size, which changes the size of the moov, which
 * changes where the payload starts, which changes the offsets. Callers must iterate to a
 * fixed point rather than assuming one pass is enough.
 */
export function writeChunkOffsets(table: ChunkOffsetTable, offsets: readonly number[]): void {
  if (offsets.length !== table.offsets.length) {
    fail(`Refusing to write ${offsets.length} chunk offset(s) over a table of ${table.offsets.length}.`);
  }

  let needsWide = false;
  for (const offset of offsets) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      fail(`Chunk offset ${offset} is not a valid file position.`);
    }
    if (offset > MAX_U32) needsWide = true;
  }

  const version = table.box.payload ? table.box.payload[0]! : 0;
  const flags = table.box.payload ? table.box.payload.subarray(1, 4) : new Uint8Array(3);

  if (needsWide) {
    table.box.type = 'co64';
    table.box.payload = concat([
      new Uint8Array([version]),
      flags,
      u32(offsets.length),
      ...offsets.map((offset) => u64(offset)),
    ]);
  } else {
    table.box.type = 'stco';
    table.box.payload = concat([
      new Uint8Array([version]),
      flags,
      u32(offsets.length),
      ...offsets.map((offset) => u32(offset)),
    ]);
  }

  // Keep the mirror honest. Leaving it stale made an earlier version of the layout check
  // validate the old offsets against the new file, which reported a corrupt file that was
  // in fact fine.
  table.kind = table.box.type as 'stco' | 'co64';
  table.offsets = [...offsets];
}

/** Every `stbl` in a moov that carries a chunk offset table. */
export function allChunkOffsetTables(moov: MutableBox): ChunkOffsetTable[] {
  const tables: ChunkOffsetTable[] = [];
  for (const trak of mutableFindAll(moov, 'trak')) {
    const stbl = mutablePath(trak, 'mdia', 'minf', 'stbl');
    if (!stbl) continue;
    const table = readChunkOffsets(stbl);
    if (table) tables.push(table);
  }
  return tables;
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function readU64(bytes: Uint8Array, at: number): number {
  const value = BigInt(readU32(bytes, at)) * 4294967296n + BigInt(readU32(bytes, at + 4));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`Chunk offset at byte ${at} exceeds the safe integer range.`);
  }
  return Number(value);
}
