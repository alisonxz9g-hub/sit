/**
 * ISO base media box tree.
 *
 * A box is `size(4) type(4) [largesize(8)] payload`. `size == 1` means the real
 * size is in the 64-bit largesize field; `size == 0` means "runs to the end of the
 * enclosing box", which is legal only for the last one.
 */
import { Reader, fail } from './reader';

export interface Box {
  readonly type: string;
  /** Absolute offset of the box header inside the file. */
  readonly start: number;
  /** Total box size including the header. */
  readonly size: number;
  /** 8, or 16 when the box uses a 64-bit largesize. */
  readonly headerSize: number;
  /** Absolute offset one past the last byte of the box. */
  readonly end: number;
  /**
   * Payload bytes, excluding the header. Present for leaf boxes only; container
   * boxes expose `children` instead so we never hold two views of the same range.
   */
  readonly payload: Uint8Array | null;
  /**
   * Bytes that sit between the header and the first child, for containers that have
   * any. Only ISO-flavoured `meta` does: it is a FullBox, so a version and flags word
   * precedes its children, while the QuickTime flavour has nothing there.
   *
   * Without this the tree could not be serialised back losslessly, and dropping four
   * bytes in the middle of a `meta` box corrupts every offset after it.
   */
  readonly prefix: Uint8Array | null;
  readonly children: Box[] | null;
}

/**
 * Boxes whose payload is just more boxes.
 *
 * `meta` is deliberately absent: it needs a version/flags word in ISO BMFF but not
 * in QuickTime, so it is detected separately below.
 */
const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'edts',
  'dinf',
  'udta',
  'mvex',
  'moof',
  'traf',
  'mfra',
  'ilst',
]);

/**
 * `stsd` is a hybrid: a version/flags word and an entry count, then sample entries
 * that are themselves boxes with an extra fixed header before their sub-boxes.
 * The track reader handles it, so it stays a leaf here.
 */
const HYBRID = new Set(['stsd']);

/** Depth cap. Real files nest about six deep; anything past this is hostile. */
const MAX_DEPTH = 32;

function isContainer(type: string, parentType: string | null): boolean {
  if (HYBRID.has(type)) return false;
  if (CONTAINERS.has(type)) return true;
  // Every child of `ilst` is a wrapper whose only content is a `data` box, keyed by
  // a tag name we cannot enumerate ahead of time (`©too`, `©nam`, freeform, ...).
  if (parentType === 'ilst') return true;
  return false;
}

/**
 * QuickTime writes `meta` as a plain container; ISO BMFF writes it as a FullBox.
 * If the four bytes after the header spell a plausible box type, there is no
 * version/flags word in front of it.
 */
function metaPayloadStart(payload: Uint8Array): number {
  if (payload.length >= 12) {
    const maybeType = String.fromCharCode(payload[4]!, payload[5]!, payload[6]!, payload[7]!);
    if (maybeType === 'hdlr' || maybeType === 'ilst' || maybeType === 'keys') return 0;
  }
  return 4;
}

/**
 * Parses the boxes in `[start, end)`, where both are offsets into `reader`'s own
 * buffer, not into the file. `Box.start` and `Box.end` are converted back to file
 * offsets via `reader.base` so callers can correlate them with a top-level scan.
 *
 * `strict` controls what happens at the first malformed box. The moov subtree is
 * parsed strictly, because a bad index means nothing we report can be trusted. The
 * top level is parsed leniently, because trailing bytes after `mdat` are common and
 * do not affect analysis.
 */
export function parseBoxes(
  reader: Reader,
  start: number,
  end: number,
  options: { strict: boolean; parentType?: string | null; depth?: number } = { strict: true },
): Box[] {
  const { strict } = options;
  const parentType = options.parentType ?? null;
  const depth = options.depth ?? 0;

  if (depth > MAX_DEPTH) {
    if (strict) fail(`Box nesting deeper than ${MAX_DEPTH} levels.`);
    return [];
  }

  const boxes: Box[] = [];
  let at = start;

  while (at + 8 <= end) {
    reader.seek(at);
    let size = reader.u32();
    const type = reader.fourcc();
    let headerSize = 8;

    if (size === 1) {
      if (at + 16 > end) {
        if (strict) fail(`Truncated 64-bit header for '${type}' at offset ${reader.base + at}.`);
        break;
      }
      size = reader.u64();
      headerSize = 16;
    } else if (size === 0) {
      // Legal only as the final box. Treat it as filling the remaining space.
      size = end - at;
    }

    if (!Number.isSafeInteger(size) || size < headerSize || at + size > end) {
      if (strict) {
        fail(
          `Malformed '${type}' box at offset ${reader.base + at}: declared size ${size}, ` +
            `${end - at} byte(s) available.`,
        );
      }
      break;
    }

    const payloadStart = at + headerSize;
    const payloadEnd = at + size;
    const common = {
      type,
      start: reader.base + at,
      size,
      headerSize,
      end: reader.base + payloadEnd,
    };

    if (isContainer(type, parentType)) {
      boxes.push({
        ...common,
        payload: null,
        prefix: null,
        children: parseBoxes(reader, payloadStart, payloadEnd, {
          strict,
          parentType: type,
          depth: depth + 1,
        }),
      });
    } else if (type === 'meta') {
      const skip = metaPayloadStart(reader.subarray(payloadStart, payloadEnd));
      const inner = Math.min(payloadStart + skip, payloadEnd);
      boxes.push({
        ...common,
        payload: null,
        prefix: skip > 0 ? reader.subarray(payloadStart, inner) : null,
        children: parseBoxes(reader, inner, payloadEnd, {
          strict,
          parentType: 'meta',
          depth: depth + 1,
        }),
      });
    } else {
      boxes.push({
        ...common,
        // `mdat` payloads are never materialised: at the top level we parse headers
        // only, and inside moov there is no mdat to begin with.
        payload: type === 'mdat' ? null : reader.subarray(payloadStart, payloadEnd),
        prefix: null,
        children: null,
      });
    }

    at += size;
  }

  return boxes;
}

/** First direct child with the given type. */
export function child(box: Box | null | undefined, type: string): Box | null {
  if (!box?.children) return null;
  return box.children.find((c) => c.type === type) ?? null;
}

/** All direct children with the given type. */
export function children(box: Box | null | undefined, type: string): Box[] {
  if (!box?.children) return [];
  return box.children.filter((c) => c.type === type);
}

/** Walks a chain of child types, e.g. `path(trak, 'mdia', 'minf', 'stbl')`. */
export function path(box: Box | null | undefined, ...types: string[]): Box | null {
  let current: Box | null = box ?? null;
  for (const type of types) {
    current = child(current, type);
    if (!current) return null;
  }
  return current;
}

/** Payload of a leaf box reached by `path`, or null. */
export function payloadAt(box: Box | null | undefined, ...types: string[]): Uint8Array | null {
  return path(box, ...types)?.payload ?? null;
}

/** Depth-first list of `type` anywhere beneath `box`. */
export function findAll(box: Box, type: string, into: Box[] = []): Box[] {
  if (box.type === type) into.push(box);
  for (const c of box.children ?? []) findAll(c, type, into);
  return into;
}
