/**
 * Compares two MP4s structurally, box by box and track by track.
 *
 * Written to measure what a third-party "method" tool actually changed, rather than
 * infer it from obfuscated source. Ad-hoc inspection tool.
 *
 * Usage: node scripts/compare.mjs <before.mp4> <after.mp4>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const { analyzeFile } = await import('../test/.build/core.mjs');

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('Usage: node scripts/compare.mjs <before.mp4> <after.mp4>');
  process.exit(1);
}

const load = async (p) => {
  const bytes = await readFile(p);
  return { file: new File([bytes], path.basename(p), { type: 'video/mp4' }), bytes };
};

const a = await load(beforePath);
const b = await load(afterPath);
const ra = await analyzeFile(a.file);
const rb = await analyzeFile(b.file);

const pad = (s, n) => String(s).padEnd(n);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`\n${'='.repeat(78)}`);
console.log(`BEFORE  ${ra.fileName}   ${kb(ra.fileSize)}`);
console.log(`AFTER   ${rb.fileName}   ${kb(rb.fileSize)}   (${rb.fileSize - ra.fileSize >= 0 ? '+' : ''}${rb.fileSize - ra.fileSize} bytes)`);
console.log('='.repeat(78));

/* ------------------------------------------------------------- box layout --- */

console.log('\nTOP-LEVEL BOXES');
const maxRows = Math.max(ra.topLevel.length, rb.topLevel.length);
console.log(`  ${pad('before', 34)}${pad('after', 34)}`);
for (let i = 0; i < maxRows; i++) {
  const x = ra.topLevel[i];
  const y = rb.topLevel[i];
  const left = x ? `${pad(x.type, 8)} ${pad(kb(x.size), 12)} @${x.start}` : '';
  const right = y ? `${pad(y.type, 8)} ${pad(kb(y.size), 12)} @${y.start}` : '';
  const flag = (x?.type ?? '') !== (y?.type ?? '') || (x?.size ?? 0) !== (y?.size ?? 0) ? '  <-- differs' : '';
  console.log(`  ${pad(left, 34)}${pad(right, 34)}${flag}`);
}

// Bytes after the last declared box: where junk tails live.
const tail = (report, size) => {
  const last = report.topLevel[report.topLevel.length - 1];
  return last ? size - last.end : 0;
};
console.log(`\n  trailing bytes after the last box:  before=${tail(ra, ra.fileSize)}  after=${tail(rb, rb.fileSize)}`);

/* ---------------------------------------------------------------- tracks --- */

function describeTrack(t) {
  const bits = [
    `${t.kind}/${t.format}`,
    t.kind === 'video' ? `${t.orientedWidth}x${t.orientedHeight}` : null,
    t.kind === 'video' ? `${t.timing.nominalFps?.toFixed(2)}fps ${t.timing.mode}` : null,
    t.kind === 'audio' ? `${t.audio?.sampleRate}Hz ${t.audio?.channels}ch ${t.audio?.profile ?? ''}` : null,
    `${t.sampleCount} samples`,
    `${kb(t.byteLength)} payload`,
    `${t.durationSec.toFixed(3)}s`,
    `ts=${t.timescale}`,
  ].filter(Boolean);
  return bits.join('  ');
}

console.log(`\nTRACKS   before=${ra.tracks.length}   after=${rb.tracks.length}`);
console.log('\n  before:');
for (const t of ra.tracks) console.log(`    id=${t.id}  ${describeTrack(t)}`);
console.log('\n  after:');
for (const t of rb.tracks) console.log(`    id=${t.id}  ${describeTrack(t)}`);

/* --------------------------------------------------------------- summary --- */

console.log('\nKEY FIELDS');
const rows = [
  ['duration (mvhd)', `${ra.durationSec.toFixed(3)}s`, `${rb.durationSec.toFixed(3)}s`],
  ['faststart', ra.faststart, rb.faststart],
  ['fragmented', ra.fragmented, rb.fragmented],
  ['64-bit boxes', ra.hasLargeBoxes, rb.hasLargeBoxes],
  ['track count', ra.tracks.length, rb.tracks.length],
  ['audio tracks', ra.tracks.filter((t) => t.kind === 'audio').length, rb.tracks.filter((t) => t.kind === 'audio').length],
  ['encoder tag', ra.encoderTag ?? '(none)', rb.encoderTag ?? '(none)'],
  ['brand', ra.brand?.major ?? '?', rb.brand?.major ?? '?'],
];
if (ra.video && rb.video) {
  rows.push(
    ['video codec', ra.video.format, rb.video.format],
    ['video samples', ra.video.sampleCount, rb.video.sampleCount],
    ['video payload', kb(ra.video.byteLength), kb(rb.video.byteLength)],
    ['video bitrate', `${(ra.video.bitrateBps / 1e6).toFixed(2)} Mbps`, `${(rb.video.bitrateBps / 1e6).toFixed(2)} Mbps`],
    ['colr', ra.video.color.present ? `${ra.video.color.primariesLabel}/${ra.video.color.transferLabel}` : 'absent',
      rb.video.color.present ? `${rb.video.color.primariesLabel}/${rb.video.color.transferLabel}` : 'absent'],
    ['rotation', `${ra.video.rotationDegrees}deg`, `${rb.video.rotationDegrees}deg`],
    ['edit list', `${ra.video.editList.entryCount} entry, mt=${ra.video.editList.firstMediaTime}`,
      `${rb.video.editList.entryCount} entry, mt=${rb.video.editList.firstMediaTime}`],
  );
}
for (const [label, x, y] of rows) {
  const same = String(x) === String(y);
  console.log(`  ${pad(label, 18)} ${pad(x, 26)} ${pad(y, 26)} ${same ? '' : '  <-- differs'}`);
}

/* ----------------------------------------------- audio track duplication --- */

const audioA = ra.tracks.filter((t) => t.kind === 'audio');
const audioB = rb.tracks.filter((t) => t.kind === 'audio');
if (audioB.length > audioA.length) {
  console.log('\nAUDIO TRACK WAS DUPLICATED');
  for (const t of audioB) {
    console.log(
      `    id=${t.id}  samples=${t.sampleCount}  payload=${kb(t.byteLength)}  ` +
        `duration=${t.durationSec.toFixed(3)}s  chunks=${t.chunkCount} (${t.chunkOffsetBox})`,
    );
  }
  const ratio = audioB[audioB.length - 1].sampleCount / (audioA[0]?.sampleCount || 1);
  console.log(`    sample-count ratio of the extra track vs the original: ${ratio.toFixed(2)}x`);
}

/* --------------------------------------------------------- raw byte diff --- */

console.log('\nRAW BYTES');
let firstDiff = -1;
const min = Math.min(a.bytes.length, b.bytes.length);
for (let i = 0; i < min; i++) {
  if (a.bytes[i] !== b.bytes[i]) {
    firstDiff = i;
    break;
  }
}
console.log(`  first differing byte offset: ${firstDiff === -1 ? 'none within the shared length' : firstDiff}`);

// Is the media payload itself untouched? Compare the mdat ranges.
const mdatA = ra.topLevel.find((x) => x.type === 'mdat');
const mdatB = rb.topLevel.find((x) => x.type === 'mdat');
if (mdatA && mdatB) {
  const sameSize = mdatA.size === mdatB.size;
  let identical = sameSize;
  if (sameSize) {
    for (let i = 0; i < mdatA.size; i++) {
      if (a.bytes[mdatA.start + i] !== b.bytes[mdatB.start + i]) {
        identical = false;
        break;
      }
    }
  }
  console.log(`  mdat size:  before=${mdatA.size}  after=${mdatB.size}`);
  console.log(`  mdat contents identical: ${identical}`);
}

// Dump any trailing bytes, which is where a junk tail would be.
const trailingB = tail(rb, rb.fileSize);
if (trailingB > 0) {
  const start = rb.fileSize - trailingB;
  const sample = Array.from(b.bytes.subarray(start, Math.min(start + 32, rb.fileSize)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join(' ');
  console.log(`\n  ${trailingB} trailing bytes after the last box. First 32:`);
  console.log(`    ${sample}`);

  // Check whether it is one 8-byte pattern repeated.
  const unit = b.bytes.subarray(start, start + 8);
  let repeats = trailingB % 8 === 0;
  if (repeats) {
    for (let i = 0; i < trailingB; i++) {
      if (b.bytes[start + i] !== unit[i % 8]) {
        repeats = false;
        break;
      }
    }
  }
  console.log(`    is a repeated 8-byte pattern: ${repeats}  (${trailingB / 8} repetitions)`);
}
console.log('');
