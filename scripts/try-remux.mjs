/**
 * Runs the native remux over real files and proves the result is sound.
 *
 * "It parses" is not enough for a container rewrite: a wrong chunk offset produces a file
 * that opens, reports the right duration, and plays noise. So this also decodes the output
 * with ffmpeg and compares the decoded frame count and payload bytes against the source.
 *
 * Usage: node scripts/try-remux.mjs <file.mp4> [more.mp4 ...]
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const core = await import('../test/.build/core.mjs');

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('Usage: node scripts/try-remux.mjs <file.mp4> [more.mp4 ...]');
  process.exit(1);
}

const work = await mkdtemp(path.join(tmpdir(), 'native-remux-'));
let failures = 0;

/** Decodes every frame and fails on any error, which is the real playability test. */
async function decodes(file) {
  try {
    const { stderr } = await run(
      'ffmpeg',
      ['-nostdin', '-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return { ok: stderr.trim() === '', detail: stderr.trim() };
  } catch (err) {
    return { ok: false, detail: (err.stderr || err.message || '').trim() };
  }
}

/** Counts decoded frames, so a truncated or misindexed file is caught. */
async function frameCount(file) {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return Number(stdout.trim());
}

/** Hash of the decoded video, to prove the pixels are untouched. */
async function decodedHash(file) {
  const { stdout } = await run(
    'ffmpeg',
    ['-nostdin', '-hide_banner', '-v', 'error', '-i', file,
      '-map', '0:v:0', '-f', 'hash', '-hash', 'md5', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.trim();
}

try {
  for (const target of targets) {
    const name = path.basename(target);
    console.log(`\n${'='.repeat(74)}\n${name}`);

    const bytes = await readFile(target);
    const file = new File([bytes], name, { type: 'video/mp4' });

    const before = await core.analyzeFile(file);
    const support = core.canRemuxNatively(before);
    console.log(`  native path supported: ${support.supported}${support.reason ? ` (${support.reason})` : ''}`);
    if (!support.supported) continue;

    for (const retag of [false, true]) {
      const label = retag ? 'remux+retag' : 'remux';
      const started = performance.now();
      const result = await core.remuxNatively(file, { retagRec709: retag });
      const elapsed = performance.now() - started;

      const outPath = path.join(work, `${label}-${name}`);
      await writeFile(outPath, Buffer.from(await result.blob.arrayBuffer()));

      const after = await core.analyzeFile(
        new File([await readFile(outPath)], `out-${name}`, { type: 'video/mp4' }),
      );

      const checks = [];
      const add = (ok, text) => {
        checks.push(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
        if (!ok) failures++;
      };

      add(after.faststart, 'moov precedes mdat');
      add(
        after.video.byteLength === before.video.byteLength,
        `video payload identical (${after.video.byteLength} vs ${before.video.byteLength})`,
      );
      add(
        after.video.sampleCount === before.video.sampleCount,
        `frame count preserved (${after.video.sampleCount})`,
      );
      add(
        (after.audio?.byteLength ?? 0) === (before.audio?.byteLength ?? 0),
        'audio payload identical',
      );
      add(
        Math.abs(after.durationSec - before.durationSec) < 0.002,
        `duration preserved (${after.durationSec.toFixed(3)}s)`,
      );
      add(after.tracks.length === before.tracks.length, `track count preserved (${after.tracks.length})`);

      if (retag) {
        const c = after.video.color;
        add(
          c.present && c.primaries === 1 && c.transfer === 1 && c.matrix === 1,
          `tagged Rec.709 (${c.primariesLabel}/${c.transferLabel}/${c.matrixLabel})`,
        );
      }

      const decode = await decodes(outPath);
      add(decode.ok, `decodes cleanly${decode.ok ? '' : `: ${decode.detail.slice(0, 160)}`}`);

      const [framesBefore, framesAfter] = await Promise.all([frameCount(target), frameCount(outPath)]);
      add(framesBefore === framesAfter, `decoded frames match (${framesAfter} vs ${framesBefore})`);

      const [hashBefore, hashAfter] = await Promise.all([decodedHash(target), decodedHash(outPath)]);
      add(hashBefore === hashAfter, `decoded video identical (${hashAfter})`);

      const sizeDelta = result.blob.size - bytes.length;
      console.log(
        `\n  ${label}: ${elapsed.toFixed(0)} ms, ${(result.blob.size / 1048576).toFixed(2)} MB ` +
          `(${sizeDelta >= 0 ? '+' : ''}${sizeDelta} bytes), moov ${result.moovBytes} B, ` +
          `offsets shifted ${result.offsetDelta}, ${result.passes} pass(es)` +
          `${result.dropped.length ? `, dropped ${result.dropped.join('/')}` : ''}` +
          `${result.promotedToCo64 ? ', promoted to co64' : ''}`,
      );
      for (const line of checks) console.log(`    ${line}`);
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
