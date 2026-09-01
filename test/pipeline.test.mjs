/**
 * End-to-end verification of the pipeline.
 *
 * The app builds an ffmpeg argument list and hands it to ffmpeg.wasm. ffmpeg.wasm is
 * the same ffmpeg with the same command line, so these tests run the real argument
 * lists through the local ffmpeg binary and then re-analyse the output with our own
 * parser. That checks the thing that actually matters: not "did the command run", but
 * "did the problem the diagnosis named actually go away".
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { analyzeFile, buildPlan, diagnose } from './.build/core.mjs';

const run = promisify(execFile);
const fixtureDir = path.join(import.meta.dirname, 'fixtures');

let workDir;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'haze-pipeline-'));
});

after(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function loadFixture(name) {
  const bytes = await readFile(path.join(fixtureDir, name));
  return new File([bytes], name, { type: 'video/mp4' });
}

/**
 * Runs a built plan through the local ffmpeg and returns the output as a File, so it
 * can go straight back through the analyzer.
 */
async function execute(plan, fixtureName, label) {
  const input = path.join(fixtureDir, fixtureName);
  const output = path.join(workDir, `${label}-${plan.outputName}`);
  const args = plan.args.map((a) => (a === '{input}' ? input : a));

  try {
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args, output], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim();
    throw new Error(`ffmpeg rejected the ${plan.mode} arguments:\n${args.join(' ')}\n${detail}`);
  }

  const bytes = await readFile(output);
  return new File([bytes], `${label}.mp4`, { type: 'video/mp4' });
}

describe('remux', () => {
  it('moves the index to the front without touching the samples', async () => {
    const source = await loadFixture('portrait-no-faststart.mp4');
    const before = await analyzeFile(source);
    assert.equal(before.faststart, false, 'fixture should start without faststart');

    const plan = buildPlan(before, 'remux');
    assert.equal(plan.lossless, true);

    const result = await analyzeFile(await execute(plan, 'portrait-no-faststart.mp4', 'remux'));

    assert.equal(result.faststart, true, 'output should be faststart');

    // A stream copy must not change the picture. Same codec, same frame count, same
    // summed sample sizes to the byte.
    assert.equal(result.video.format, before.video.format, 'codec should be unchanged');
    assert.equal(result.video.sampleCount, before.video.sampleCount, 'frame count should be unchanged');
    assert.equal(result.video.byteLength, before.video.byteLength, 'video payload bytes should be identical');
    assert.equal(result.audio.byteLength, before.audio.byteLength, 'audio payload bytes should be identical');

    // The timeline must survive untouched too. An earlier version passed
    // `-avoid_negative_ts make_zero`, which turned one benign delay-compensation edit
    // into two entries including an empty edit that inserts blank presentation time.
    assert.equal(
      result.video.editList.entryCount,
      before.video.editList.entryCount,
      'the edit list should not gain entries',
    );
    assert.equal(
      result.video.editList.firstMediaTime,
      before.video.editList.firstMediaTime,
      'the start offset should be preserved',
    );
    assert.equal(result.video.editList.hasEmptyEdit, false, 'no empty edit should be introduced');
  });

  it('flattens a fragmented file into one mdat', async () => {
    // Built here rather than as a shared fixture: fragmentation is the only thing it
    // exercises, and it needs a different muxer flag.
    const fragmented = path.join(workDir, 'fragmented.mp4');
    await run('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', path.join(fixtureDir, 'portrait-cfr-faststart.mp4'),
      '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      fragmented,
    ]);

    const source = new File([await readFile(fragmented)], 'fragmented.mp4', { type: 'video/mp4' });
    const before = await analyzeFile(source);
    assert.equal(before.fragmented, true, 'fixture should be fragmented');

    const found = diagnose(before).findings.find((f) => f.id === 'fragmented');
    assert.ok(found, 'diagnosis should report the fragmentation');
    assert.equal(found.severity, 'blocker');
    assert.equal(found.fix, 'remux');

    await writeFile(path.join(workDir, 'frag-copy.mp4'), await readFile(fragmented));
    const plan = buildPlan(before, 'remux');
    const args = plan.args.map((a) => (a === '{input}' ? fragmented : a));
    const output = path.join(workDir, 'defragmented.mp4');
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args, output], {
      maxBuffer: 64 * 1024 * 1024,
    });

    const result = await analyzeFile(
      new File([await readFile(output)], 'defragmented.mp4', { type: 'video/mp4' }),
    );
    assert.equal(result.fragmented, false, 'output should not be fragmented');
    assert.equal(result.faststart, true, 'output should be faststart');
  });
});

describe('retag', () => {
  it('adds Rec.709 tags to an untagged file without re-encoding', async () => {
    const source = await loadFixture('untagged-color.mp4');
    const before = await analyzeFile(source);
    assert.equal(before.video.color.present, false, 'fixture should have no colr box');

    const found = diagnose(before).findings.find((f) => f.id === 'untagged-color');
    assert.ok(found, 'diagnosis should report the missing tags');
    assert.equal(found.fix, 'retag');

    const plan = buildPlan(before, 'retag');
    assert.equal(plan.lossless, true);

    const result = await analyzeFile(await execute(plan, 'untagged-color.mp4', 'retag'));

    // The tags arrived.
    assert.equal(result.video.color.present, true, 'output should carry a colr box');
    assert.equal(result.video.color.type, 'nclx');
    assert.deepEqual(
      [result.video.color.primaries, result.video.color.transfer, result.video.color.matrix],
      [1, 1, 1],
      'output should be tagged Rec.709',
    );

    // And it really was lossless: identical payload bytes on both tracks.
    assert.equal(result.video.byteLength, before.video.byteLength, 'video bytes should be identical');
    assert.equal(result.video.sampleCount, before.video.sampleCount, 'frame count should be identical');
    assert.equal(result.audio.byteLength, before.audio.byteLength, 'audio bytes should be identical');

    // Re-diagnosing the output should no longer raise the finding.
    assert.equal(
      diagnose(result).findings.some((f) => f.id === 'untagged-color'),
      false,
      'the finding should be resolved',
    );
  });
});

describe('master', () => {
  it('converts a variable frame rate source to constant', async () => {
    const source = await loadFixture('vfr.mp4');
    const before = await analyzeFile(source);
    assert.equal(before.video.timing.mode, 'vfr', 'fixture should be VFR');

    const found = diagnose(before).findings.find((f) => f.id === 'vfr');
    assert.ok(found, 'diagnosis should report the variable frame rate');
    assert.equal(found.fix, 'master');
    assert.equal(diagnose(before).recommended, 'master');

    const plan = buildPlan(before, 'master');
    assert.equal(plan.lossless, false);
    assert.ok(plan.master, 'a master plan should be attached');

    const result = await analyzeFile(await execute(plan, 'vfr.mp4', 'master'));

    assert.equal(result.video.timing.mode, 'cfr', 'output should be constant frame rate');
    assert.equal(result.video.timing.distinctDeltas, 1, 'output should have a single frame duration');
    assert.equal(result.faststart, true, 'output should be faststart');
    assert.equal(result.video.format, 'avc1', 'output should be H.264');
    assert.equal(result.video.video.profile, 'High', 'output should be High profile');
    assert.equal(result.video.video.chromaFormat, '4:2:0');
    assert.equal(result.video.video.bitDepth, 8);
    assert.deepEqual(
      [result.video.color.primaries, result.video.color.transfer, result.video.color.matrix],
      [1, 1, 1],
      'output should be tagged Rec.709',
    );

    // The re-encode should land on the frame rate the plan promised.
    assert.equal(Math.round(result.video.timing.nominalFps), plan.master.fps, 'frame rate should match the plan');
  });

  it('normalises HEVC to H.264 High and audio to 48 kHz stereo', async (t) => {
    if (!(await fixtureExists('hevc.mp4'))) {
      t.skip('hevc fixture not built');
      return;
    }
    const source = await loadFixture('hevc.mp4');
    const before = await analyzeFile(source);

    const plan = buildPlan(before, 'master');
    const result = await analyzeFile(await execute(plan, 'hevc.mp4', 'master-hevc'));

    assert.equal(result.video.format, 'avc1', 'output should be H.264');
    assert.equal(result.audio.audio.sampleRate, 48000);
    assert.equal(result.audio.audio.channels, 2);
    assert.equal(result.audio.audio.profile, 'AAC-LC');
  });

  it('keeps a rotated source upright and does not upscale it', async () => {
    const source = await loadFixture('rotated-90.mp4');
    const before = await analyzeFile(source);
    // Stored 1280x720 landscape, displayed 720x1280 portrait.
    assert.equal(before.video.orientedWidth, 720);
    assert.equal(before.video.orientedHeight, 1280);

    const plan = buildPlan(before, 'master');
    const result = await analyzeFile(await execute(plan, 'rotated-90.mp4', 'master-rot'));

    // 720x1280 is already on the ladder, so the plan should leave it alone. After a
    // re-encode the rotation is baked in, so the coded frame is now portrait and the
    // matrix is back to identity.
    assert.equal(plan.master.scaled, false, 'a source already on the ladder should not be scaled');
    assert.equal(result.video.orientedWidth, 720, 'oriented width should be preserved');
    assert.equal(result.video.orientedHeight, 1280, 'oriented height should be preserved');
    assert.equal(result.video.rotationDegrees, 0, 'rotation should be baked into the pixels');
    assert.equal(result.video.codedWidth, 720, 'coded frame should now be portrait');
    assert.equal(result.video.codedHeight, 1280);
  });

  it('scales an off-ladder source down to the nearest rung', async () => {
    const source = await loadFixture('untagged-color.mp4'); // 640x360
    const before = await analyzeFile(source);
    assert.equal(before.video.orientedWidth, 640);

    const plan = buildPlan(before, 'master');
    // 640x360 is landscape and smaller than every landscape rung, so the plan must
    // not upscale it.
    assert.equal(plan.master.scaled, false, 'should never upscale');
    assert.equal(plan.master.width, 640);
    assert.equal(plan.master.height, 360);

    const result = await analyzeFile(await execute(plan, 'untagged-color.mp4', 'master-small'));
    assert.equal(result.video.orientedWidth, 640);
    assert.equal(result.video.orientedHeight, 360);
  });
});

describe('every mode produces a valid MP4 for every fixture', () => {
  const cases = [
    'portrait-cfr-faststart.mp4',
    'portrait-no-faststart.mp4',
    'landscape-60fps.mp4',
    'untagged-color.mp4',
    'no-audio.mp4',
    'baseline-profile.mp4',
    'mono-44k-audio.mp4',
  ];

  for (const name of cases) {
    for (const mode of ['remux', 'retag']) {
      it(`${mode} of ${name}`, async () => {
        const before = await analyzeFile(await loadFixture(name));
        const plan = buildPlan(before, mode);
        const result = await analyzeFile(await execute(plan, name, `${mode}-${name}`));

        // The output has to survive our own strict parser, be faststart, and keep the
        // track layout the source had.
        assert.equal(result.faststart, true, 'should be faststart');
        assert.equal(result.fragmented, false, 'should not be fragmented');
        assert.ok(result.video, 'should have a video track');
        assert.equal(!!result.audio, !!before.audio, 'audio presence should be preserved');
        assert.equal(result.video.byteLength, before.video.byteLength, 'should be a true stream copy');
      });
    }
  }
});

async function fixtureExists(name) {
  try {
    await readFile(path.join(fixtureDir, name));
    return true;
  } catch {
    return false;
  }
}
