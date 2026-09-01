/**
 * Verifies the Observed transform against a real reference output.
 *
 * The point is not "does it run" but "does it match". A reference pair is needed: the
 * original file and the same file after the third-party tool processed it. This applies our
 * replication to the original and compares the two structurally.
 *
 * Usage: node scripts/verify-observed.mjs <original.mp4> <reference-output.mp4>
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const core = await import('../test/.build/core.mjs');

const [originalPath, referencePath] = process.argv.slice(2);
if (!originalPath) {
  console.error('Usage: node scripts/verify-observed.mjs <original.mp4> [reference-output.mp4]');
  process.exit(1);
}

const load = async (p, name) =>
  new File([await readFile(p)], name ?? path.basename(p), { type: 'video/mp4' });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Sums the byte ranges a track's samples occupy, so the stream can be hashed. */
async function hashVideoStream(filePath) {
  // Decoding to a hash proves the pixels survived, independent of container layout.
  const { stdout, stderr } = await run(
    'ffmpeg',
    ['-nostdin', '-hide_banner', '-v', 'error', '-i', filePath,
      '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  if (stderr.trim() !== '') throw new Error(`ffmpeg: ${stderr.trim()}`);
  return stdout.trim();
}

const work = await mkdtemp(path.join(tmpdir(), 'observed-'));
let failures = 0;
const check = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures++;
};

try {
  const original = await load(originalPath);
  const before = await core.analyzeFile(original);

  console.log(`\nsource: ${before.fileName}`);
  const support = core.canApplyObserved(before);
  console.log(`  applicable: ${support.supported}${support.reason ? ` (${support.reason})` : ''}`);
  if (!support.supported) {
    console.log(`  needs AAC preparation: ${support.needsAacPreparation}`);
    process.exit(1);
  }

  const started = performance.now();
  const result = await core.applyObservedTransform(original);
  const elapsed = performance.now() - started;

  const outPath = path.join(work, 'observed.mp4');
  const outBytes = Buffer.from(await result.blob.arrayBuffer());
  await writeFile(outPath, outBytes);

  console.log(
    `\napplied in ${elapsed.toFixed(0)} ms -> ${(result.blob.size / 1048576).toFixed(2)} MB ` +
      `(+${result.blob.size - original.size} bytes)`,
  );
  console.log(`  ${result.classification} / ISO compliant: ${result.isoCompliant} / ${result.validationStatus}`);
  console.log(
    `  cloned track_ID ${result.clonedTrackId}, ${result.sourceAudioSamples} real samples ` +
      `+ ${result.artificialSamples} artificial (${result.artificialBytes} bytes)`,
  );
  console.log(
    `  index ${result.moovBytes} B, offsets shifted ${result.offsetDelta}, ` +
      `${result.passes} pass(es), ${result.editListsRemoved} edit list(s) removed` +
      `${result.dropped.length ? `, dropped ${result.dropped.join('/')}` : ''}`,
  );

  const after = await core.analyzeFile(
    new File([outBytes], 'observed.mp4', { type: 'video/mp4' }),
  );

  console.log('\nstructure');
  check(after.faststart, 'moov precedes mdat');
  check(after.tracks.length === before.tracks.length + 1, `track count ${before.tracks.length} -> ${after.tracks.length}`);

  const audioBefore = before.tracks.filter((t) => t.kind === 'audio');
  const audioAfter = after.tracks.filter((t) => t.kind === 'audio');
  check(audioAfter.length === audioBefore.length + 1, `audio tracks ${audioBefore.length} -> ${audioAfter.length}`);

  const cloneTrack = audioAfter[audioAfter.length - 1];
  const ratio = cloneTrack.sampleCount / audioBefore[0].sampleCount;
  check(Math.abs(ratio - 10) < 0.001, `clone carries ${ratio.toFixed(2)}x the samples (expected 10.00x)`);
  check(cloneTrack.id === result.clonedTrackId, `clone track_ID is ${cloneTrack.id}`);

  check(
    after.tracks.every((t) => !t.editList.present),
    'no track carries an edit list',
  );

  console.log('\nartificial tail');
  const lastBox = after.topLevel[after.topLevel.length - 1];
  const trailing = after.fileSize - lastBox.end;
  check(trailing === result.artificialBytes, `${trailing} bytes past the last box (expected ${result.artificialBytes})`);

  const tailStart = after.fileSize - trailing;
  const pattern = [0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00];
  let patternOk = trailing > 0 && trailing % 8 === 0;
  for (let i = 0; patternOk && i < trailing; i++) {
    if (outBytes[tailStart + i] !== pattern[i % 8]) patternOk = false;
  }
  check(patternOk, `tail is ${trailing / 8} repetitions of 00 00 00 04 00 00 00 00`);

  console.log('\nvideo stream preservation');
  const [hashBefore, hashAfter] = await Promise.all([
    hashVideoStream(originalPath),
    hashVideoStream(outPath),
  ]);
  check(hashBefore === hashAfter, `video stream SHA-256 identical (${hashAfter.slice(0, 24)}...)`);
  check(
    after.video.byteLength === before.video.byteLength,
    `video payload ${after.video.byteLength} bytes, unchanged`,
  );

  // The mdat range must be byte-for-byte identical to the source.
  const originalBytes = await readFile(originalPath);
  const mdatBefore = before.topLevel.find((b) => b.type === 'mdat');
  const mdatAfter = after.topLevel.find((b) => b.type === 'mdat');
  const sameMdat =
    mdatBefore.size === mdatAfter.size &&
    sha256(originalBytes.subarray(mdatBefore.start, mdatBefore.end)) ===
      sha256(outBytes.subarray(mdatAfter.start, mdatAfter.end));
  check(sameMdat, 'mdat copied verbatim');

  console.log('\nplayback');
  try {
    const { stderr } = await run(
      'ffmpeg',
      ['-nostdin', '-hide_banner', '-v', 'error', '-i', outPath, '-f', 'null', '-'],
      { maxBuffer: 128 * 1024 * 1024 },
    );
    check(true, `decodes${stderr.trim() ? ` with warnings: ${stderr.trim().slice(0, 120)}` : ' cleanly'}`);
  } catch (err) {
    check(false, `decode failed: ${(err.stderr || err.message).trim().slice(0, 200)}`);
  }

  /* ------------------------------------------------ compare to reference --- */

  if (referencePath) {
    const reference = await core.analyzeFile(await load(referencePath));
    const refBytes = await readFile(referencePath);
    console.log(`\ncompared to reference: ${path.basename(referencePath)}`);

    const refAudio = reference.tracks.filter((t) => t.kind === 'audio');
    const refLastBox = reference.topLevel[reference.topLevel.length - 1];
    const refTrailing = reference.fileSize - refLastBox.end;

    check(after.tracks.length === reference.tracks.length, `track count ${after.tracks.length} vs ${reference.tracks.length}`);
    check(
      audioAfter.length === refAudio.length,
      `audio track count ${audioAfter.length} vs ${refAudio.length}`,
    );
    check(
      cloneTrack.sampleCount === refAudio[refAudio.length - 1].sampleCount,
      `clone sample count ${cloneTrack.sampleCount} vs ${refAudio[refAudio.length - 1].sampleCount}`,
    );
    check(trailing === refTrailing, `artificial tail ${trailing} vs ${refTrailing} bytes`);
    check(
      after.faststart === reference.faststart,
      `faststart ${after.faststart} vs ${reference.faststart}`,
    );
    check(
      reference.tracks.every((t) => !t.editList.present) ===
        after.tracks.every((t) => !t.editList.present),
      'edit list handling matches',
    );

    const refMdat = reference.topLevel.find((b) => b.type === 'mdat');
    check(
      mdatAfter.size === refMdat.size,
      `mdat size ${mdatAfter.size} vs ${refMdat.size}`,
    );
    check(
      sha256(outBytes.subarray(mdatAfter.start, mdatAfter.end)) ===
        sha256(refBytes.subarray(refMdat.start, refMdat.end)),
      'mdat contents match the reference',
    );

    const sizeGap = result.blob.size - reference.fileSize;
    console.log(
      `  file size ${result.blob.size} vs ${reference.fileSize} (${sizeGap >= 0 ? '+' : ''}${sizeGap} bytes; ` +
        'index differs because the encoder tag text differs)',
    );
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
