/**
 * Bounds-checked big-endian reader for ISO base media files.
 *
 * Everything in an MP4 is big-endian, and a malformed file is the normal case
 * rather than the exception here: we are handed arbitrary user exports from a
 * dozen different mobile editors. So every read is bounds-checked and throws a
 * typed error instead of returning a silently wrong number, which is how binary
 * parsers usually end up producing confident nonsense.
 */

export class Mp4ParseError extends Error {
  override readonly name = 'Mp4ParseError';

  constructor(message: string) {
    super(message);
  }
}

export function fail(message: string): never {
  throw new Mp4ParseError(message);
}

/** Largest integer a fixed-point 16.16 field can hold, used for sanity checks. */
const MAX_SAFE_BOX = Number.MAX_SAFE_INTEGER;

export class Reader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  /** Absolute offset of `bytes[0]` inside the original file. */
  readonly base: number;
  private cursor: number;

  constructor(bytes: Uint8Array, base = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.base = base;
    this.cursor = 0;
  }

  get offset(): number {
    return this.cursor;
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.cursor;
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.length) {
      fail(`Seek out of range: ${offset} (length ${this.bytes.length}).`);
    }
    this.cursor = offset;
  }

  skip(count: number): void {
    this.seek(this.cursor + count);
  }

  private need(count: number): number {
    const at = this.cursor;
    if (count < 0 || at + count > this.bytes.length) {
      fail(`Truncated box: needed ${count} byte(s) at offset ${this.base + at}.`);
    }
    this.cursor = at + count;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }

  u16(): number {
    return this.view.getUint16(this.need(2), false);
  }

  i16(): number {
    return this.view.getInt16(this.need(2), false);
  }

  u24(): number {
    const at = this.need(3);
    return (
      (this.view.getUint8(at) << 16) | (this.view.getUint8(at + 1) << 8) | this.view.getUint8(at + 2)
    );
  }

  u32(): number {
    return this.view.getUint32(this.need(4), false);
  }

  i32(): number {
    return this.view.getInt32(this.need(4), false);
  }

  /**
   * 64-bit unsigned as a JS number. MP4 durations and offsets are `u64` in their
   * version-1 forms, but a real file never exceeds 2^53 bytes or ticks, so
   * collapsing to `number` is safe as long as we verify it.
   */
  u64(): number {
    const at = this.need(8);
    const value = this.view.getBigUint64(at, false);
    if (value > BigInt(MAX_SAFE_BOX)) {
      fail(`64-bit field at offset ${this.base + at} exceeds the safe integer range.`);
    }
    return Number(value);
  }

  i64(): number {
    const at = this.need(8);
    const value = this.view.getBigInt64(at, false);
    if (value > BigInt(MAX_SAFE_BOX) || value < BigInt(-MAX_SAFE_BOX)) {
      fail(`64-bit field at offset ${this.base + at} exceeds the safe integer range.`);
    }
    return Number(value);
  }

  /** 16.16 fixed point, as used by tkhd width/height and the transform matrix. */
  fixed16_16(): number {
    return this.i32() / 65536;
  }

  /** 2.30 fixed point, as used by the u/v/w column of the transform matrix. */
  fixed2_30(): number {
    return this.i32() / 1073741824;
  }

  /** 8.8 fixed point, as used by tkhd volume. */
  fixed8_8(): number {
    return this.i16() / 256;
  }

  /** A four-character box type or brand. Non-printable bytes are escaped. */
  fourcc(): string {
    const at = this.need(4);
    let out = '';
    for (let i = 0; i < 4; i++) {
      const byte = this.bytes[at + i] as number;
      out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
    }
    return out;
  }

  /** Version + flags word that opens every FullBox. */
  fullBoxHeader(): { version: number; flags: number } {
    return { version: this.u8(), flags: this.u24() };
  }

  /** A slice of the underlying buffer. No copy; callers must not mutate it. */
  subarray(start: number, end: number): Uint8Array {
    if (start < 0 || end > this.bytes.length || start > end) {
      fail(`Invalid slice ${start}..${end} (length ${this.bytes.length}).`);
    }
    return this.bytes.subarray(start, end);
  }

  /** ISO 639-2/T packed into 15 bits, as used by mdhd. `und` when unset. */
  packedLanguage(): string {
    const packed = this.u16();
    const chars = [(packed >> 10) & 0x1f, (packed >> 5) & 0x1f, packed & 0x1f];
    if (chars.some((c) => c === 0)) return 'und';
    return chars.map((c) => String.fromCharCode(c + 0x60)).join('');
  }
}
