/**
 * Entry point for structural analysis. Reads only `ftyp` and `moov` off the file, so
 * a half-gigabyte export costs a few hundred kilobytes of memory here.
 */
import { type Box, parseBoxes } from './boxes';
import { Mp4ParseError, Reader } from './reader';
import { type TopLevelEntry, readBox, scanTopLevel } from './scan';
import { parseTrack, readEncoderTag } from './tracks';
import type { FileBrand, MediaReport, Track } from './types';

export { Mp4ParseError } from './reader';

/** Brands that indicate a fragmented file even before we see a `moof`. */
const FRAGMENTED_BRANDS = new Set(['dash', 'msdh', 'msix', 'iso5', 'cmfc']);

function parseFtyp(payload: Uint8Array): FileBrand | null {
  if (payload.length < 8) return null;
  const r = new Reader(payload);
  const major = r.fourcc();
  const minor = r.u32();
  const compatible: string[] = [];
  while (r.remaining >= 4) compatible.push(r.fourcc());
  return { major, minor, compatible };
}

function parseMvhdDuration(payload: Uint8Array): number {
  const r = new Reader(payload);
  const { version } = r.fullBoxHeader();
  if (version === 1) {
    r.skip(16);
    const timescale = r.u32();
    const duration = r.u64();
    return timescale > 0 ? duration / timescale : 0;
  }
  r.skip(8);
  const timescale = r.u32();
  const duration = r.u32();
  return timescale > 0 ? duration / timescale : 0;
}

/** Picks the track a viewer would actually see or hear. */
function pickPrimary(tracks: readonly Track[], kind: 'video' | 'audio'): Track | null {
  const candidates = tracks.filter((t) => t.kind === kind);
  if (candidates.length === 0) return null;
  // Longest track wins: some exports carry a stub second track (a thumbnail video
  // track, or a near-silent alternate language) that is not the main one.
  return candidates.reduce((best, t) => (t.durationSec > best.durationSec ? t : best));
}

export async function analyzeFile(file: File): Promise<MediaReport> {
  const notes: string[] = [];
  const topLevel = await scanTopLevel(file);

  const ftypEntry = topLevel.find((b) => b.type === 'ftyp');
  const moovEntry = topLevel.find((b) => b.type === 'moov');
  const mdatEntries = topLevel.filter((b) => b.type === 'mdat');
  const moofEntries = topLevel.filter((b) => b.type === 'moof');

  if (!moovEntry) {
    throw new Mp4ParseError(
      'This file has no moov box, which is the index every MP4 needs. It is either ' +
        'corrupt, still being written, or not really an MP4.',
    );
  }

  let brand: FileBrand | null = null;
  if (ftypEntry) {
    const bytes = await readBox(file, ftypEntry);
    brand = parseFtyp(bytes.subarray(ftypEntry.headerSize));
  } else {
    notes.push('No ftyp box: the file does not declare which MP4 flavour it is.');
  }

  // The moov subtree is parsed strictly. If the index is malformed there is nothing
  // trustworthy to report, and guessing would be worse than saying so.
  const moovBytes = await readBox(file, moovEntry);
  const moovReader = new Reader(moovBytes, moovEntry.start);
  const moov: Box = {
    type: 'moov',
    start: moovEntry.start,
    size: moovEntry.size,
    headerSize: moovEntry.headerSize,
    end: moovEntry.end,
    payload: null,
    // Offsets here are local to `moovBytes`; the parser adds `base` back when it
    // records each box, so Box.start stays a file offset.
    children: parseBoxes(moovReader, moovEntry.headerSize, moovBytes.length, {
      strict: true,
      parentType: 'moov',
    }),
  };

  const mvhd = moov.children?.find((b) => b.type === 'mvhd');
  if (!mvhd?.payload) {
    throw new Mp4ParseError('This file has a moov box but no mvhd header inside it.');
  }
  const durationSec = parseMvhdDuration(mvhd.payload);

  const traks = moov.children?.filter((b) => b.type === 'trak') ?? [];
  const tracks: Track[] = [];
  for (const trak of traks) {
    const track = parseTrack(trak);
    if (track) tracks.push(track);
    else notes.push('Skipped a track that was missing its mdhd or hdlr header.');
  }

  if (tracks.length === 0) {
    throw new Mp4ParseError('This file declares no readable tracks.');
  }

  const fragmented = moofEntries.length > 0 || (moov.children?.some((b) => b.type === 'mvex') ?? false);
  const brandSuggestsFragments = brand
    ? [brand.major, ...brand.compatible].some((b) => FRAGMENTED_BRANDS.has(b))
    : false;
  if (!fragmented && brandSuggestsFragments) {
    notes.push('The file brand hints at a streaming layout even though no fragments were found.');
  }

  // Faststart means the index comes before the payload, so a player can begin
  // without seeking to the end first.
  const moovIndex = topLevel.indexOf(moovEntry);
  const firstMediaIndex = topLevel.findIndex((b) => b.type === 'mdat' || b.type === 'moof');
  const faststart = firstMediaIndex === -1 || moovIndex < firstMediaIndex;

  if (mdatEntries.length > 1) {
    notes.push(`Media data is split across ${mdatEntries.length} mdat boxes.`);
  }

  const video = pickPrimary(tracks, 'video');
  const audio = pickPrimary(tracks, 'audio');

  return {
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'unknown',
    brand,
    topLevel,
    faststart,
    fragmented,
    hasLargeBoxes: topLevel.some((b) => b.large),
    durationSec: durationSec > 0 ? durationSec : (video?.durationSec ?? 0),
    overallBitrateBps: durationSec > 0 ? (file.size * 8) / durationSec : null,
    tracks,
    video,
    audio,
    encoderTag: readEncoderTag(moov),
    notes,
  };
}

export type { TopLevelEntry };
