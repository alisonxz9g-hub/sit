/**
 * Streaming top-level scan.
 *
 * Analysis only ever needs `ftyp` and `moov`. `mdat` is the whole point of the file
 * and can be hundreds of megabytes, so we walk the top level by reading 16-byte
 * headers through `Blob.slice` and then read just the boxes we care about. A 500 MB
 * export costs a few hundred kilobytes of memory to analyse.
 */
import { Mp4ParseError, fail } from './reader';

export interface TopLevelEntry {
  readonly type: string;
  readonly start: number;
  readonly size: number;
  readonly headerSize: number;
  readonly end: number;
  /** True when the box declared a 64-bit largesize. */
  readonly large: boolean;
}

/** A file with more top-level boxes than this is not something we want to walk. */
const MAX_TOP_LEVEL_BOXES = 4096;

async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  const clamped = Math.min(end, blob.size);
  if (start >= clamped) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(start, clamped).arrayBuffer());
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function readU64(bytes: Uint8Array, at: number): number {
  const hi = readU32(bytes, at);
  const lo = readU32(bytes, at + 4);
  const value = BigInt(hi) * 4294967296n + BigInt(lo);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`64-bit box size at offset ${at} exceeds the safe integer range.`);
  }
  return Number(value);
}

function readFourcc(bytes: Uint8Array, at: number): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    const byte = bytes[at + i]!;
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/**
 * Walks the top-level box list. Stops cleanly at the first structure it cannot make
 * sense of rather than throwing, because trailing bytes after the last real box are
 * common in the wild and do not affect what we report.
 */
export async function scanTopLevel(file: Blob): Promise<TopLevelEntry[]> {
  const entries: TopLevelEntry[] = [];
  let at = 0;

  while (at + 8 <= file.size) {
    if (entries.length >= MAX_TOP_LEVEL_BOXES) break;

    const header = await readRange(file, at, at + 16);
    if (header.length < 8) break;

    let size = readU32(header, 0);
    const type = readFourcc(header, 4);
    let headerSize = 8;
    let large = false;

    if (size === 1) {
      if (header.length < 16) break;
      size = readU64(header, 8);
      headerSize = 16;
      large = true;
    } else if (size === 0) {
      size = file.size - at;
    }

    if (!Number.isSafeInteger(size) || size < headerSize || at + size > file.size) break;

    entries.push({ type, start: at, size, headerSize, end: at + size, large });
    at += size;
  }

  if (entries.length === 0) {
    throw new Mp4ParseError(
      'This file has no readable MP4 box structure. It may be corrupt, or it may be a ' +
        'MKV/WebM file that was renamed to .mp4.',
    );
  }

  return entries;
}

/** Reads one scanned box in full, header included. */
export async function readBox(file: Blob, entry: TopLevelEntry): Promise<Uint8Array> {
  const bytes = await readRange(file, entry.start, entry.end);
  if (bytes.length !== entry.size) {
    fail(`Could not read all of '${entry.type}': expected ${entry.size} bytes, got ${bytes.length}.`);
  }
  return bytes;
}
