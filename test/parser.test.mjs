/**
 * Cross-validates the MP4 parser against ffprobe.
 *
 * Every numeric claim the app makes about a file comes out of this parser, so the
 * tests compare it to an independent implementation on real muxer output rather
 * than to numbers written by hand. Run `npm run fixtures` first.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import { analyzeFile, diagnose } from './.build/core.mjs';

const fixtureDir = path.join(import.meta.dirname, 'fixtures');

let groundTruth;

before(async () => {
  try {
    groundTruth = JSON.parse(await readFile(path.join(fixtureDir, 'ground-truth.json'), 'utf8'));
  } catch {
    throw new Error('Fixtures are missing. Run `npm run fixtures` (needs ffmpeg on PATH).');
  }
});

/** Loads a fixture as a File, which is what the browser hands the analyzer. */
async function loadFixture(name) {
  const bytes = await readFile(path.join(fixtureDir, name));
  return new File([bytes], name, { type: 'video/mp4' });
}

function truthFor(name) {
  const entry = groundTruth.fixtures[name];
  if (!entry) throw new Error(`No ground truth for ${name}. Re-run \`npm run fixtures\`.`);
  return entry;
}

function stream(name, type) {
  return truthFor(name).streams.find((s) => s.codec_type === type) ?? null;
}

/** ffprobe reports frame rates as "num/den" strings. */
function ratio(value) {
  if (!value || value === '0/0') return null;
  const [num, den] = value.split('/').map(Number);
  return den ? num / den : null;
}

function closeTo(actual, expected, tolerance, label) {
  assert.ok(
    actual !== null && expected !== null && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ~${expected}, got ${actual}`,
  );
}

/** ffprobe names H.264 profiles more precisely than avcC can express. */
function normalizeAvcProfile(probeProfile) {
  if (!probeProfile) return null;
  if (probeProfile.includes('Baseline')) return 'Baseline';
  if (probeProfile.startsWith('High 10')) return 'High 10';
  if (probeProfile.startsWith('High 4:2:2')) return 'High 4:2:2';
  if (probeProfile.startsWith('High')) return 'High';
  if (probeProfile.startsWith('Main')) return 'Main';
  return probeProfile;
}

const ALL_FIXTURES = [
  'portrait-cfr-faststart.mp4',
  'portrait-no-faststart.mp4',
  'landscape-60fps.mp4',
  'untagged-color.mp4',
  'near-cfr.mp4',
  'vfr.mp4',
  'no-audio.mp4',
  'baseline-profile.mp4',
  'hevc.mp4',
  'mono-44k-audio.mp4',
  'hdr-pq.mp4',
  'rotated-90.mp4',
  'rotated-180.mp4',
  'rotated-270.mp4',
];

describe('analyzeFile agrees with ffprobe', () => {
  for (const name of ALL_FIXTURES) {
    it(name, async (t) => {
      if (!groundTruth.fixtures[name]) {
        t.skip(`fixture not built (${name})`);
        return;
      }

      const report = await analyzeFile(await loadFixture(name));
      const truth = truthFor(name);
      const v = stream(name, 'video');
      const a = stream(name, 'audio');

      assert.equal(report.fileName, name);
      assert.equal(report.fileSize, Number(truth.format.size), 'file size');

      // Duration: ffprobe reports the presentation duration, same as mvhd.
      closeTo(report.durationSec, Number(truth.format.duration), 0.15, 'duration');

      assert.ok(report.video, 'a video track should be found');
      assert.equal(report.video.format, v.codec_tag_string, 'video sample entry format');
      assert.equal(report.video.codedWidth, v.width, 'coded width');
      assert.equal(report.video.codedHeight, v.height, 'coded height');

      // Frame count comes from stsz, which is how many samples the table describes.
      if (v.nb_frames) {
        assert.equal(report.video.sampleCount, Number(v.nb_frames), 'video sample count');
      }

      // Nominal rate is the dominant stts delta; ffprobe's r_frame_rate is the same
      // idea. Average rate is samples over duration.
      const rFps = ratio(v.r_frame_rate);
      if (rFps && report.video.timing.mode === 'cfr') {
        closeTo(report.video.timing.nominalFps, rFps, 0.01, 'nominal fps');
      }
      const avgFps = ratio(v.avg_frame_rate);
      if (avgFps) closeTo(report.video.timing.avgFps, avgFps, 0.75, 'average fps');

      // Profile and level out of avcC / hvcC.
      if (v.codec_name === 'h264' && v.profile) {
        assert.equal(report.video.video?.profile, normalizeAvcProfile(v.profile), 'H.264 profile');
        assert.equal(report.video.video?.level, `${Math.floor(v.level / 10)}.${v.level % 10}`, 'H.264 level');
      }
      if (v.codec_name === 'hevc' && v.profile) {
        assert.ok(
          report.video.video?.profile?.startsWith(v.profile),
          `HEVC profile: expected to start with ${v.profile}, got ${report.video.video?.profile}`,
        );
      }

      // Colour tags. ffprobe omits the field entirely when the value is unknown.
      const probePrimaries = v.color_primaries ?? null;
      if (probePrimaries && probePrimaries !== 'unknown') {
        assert.equal(report.video.color.present, true, 'colr box should be present');
        assert.equal(
          report.video.color.primariesLabel.toLowerCase().replace(/[.\s]/g, ''),
          probePrimaries === 'bt2020' ? 'bt2020' : probePrimaries.replace(/[.\s]/g, ''),
          'colour primaries',
        );
      }

      // Rotation from the tkhd matrix, normalised the same way ffprobe reports it.
      const expectedRotation = ((truth.rotation % 360) + 360) % 360;
      assert.equal(report.video.rotationDegrees, expectedRotation, 'rotation');

      if (a) {
        assert.ok(report.audio, 'an audio track should be found');
        assert.equal(report.audio.format, a.codec_tag_string, 'audio sample entry format');
        assert.equal(report.audio.audio?.channels, a.channels, 'audio channels');
        assert.equal(report.audio.audio?.sampleRate, Number(a.sample_rate), 'audio sample rate');
        if (a.profile === 'LC') {
          assert.equal(report.audio.audio?.profile, 'AAC-LC', 'AAC profile');
        }
      } else {
        assert.equal(report.audio, null, 'there should be no audio track');
      }
    });
  }
});

describe('structural properties', () => {
  it('detects faststart when moov precedes mdat', async () => {
    const report = await analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    assert.equal(report.faststart, true);
    const order = report.topLevel.map((b) => b.type);
    assert.ok(order.indexOf('moov') < order.indexOf('mdat'), `box order was ${order.join(', ')}`);
  });

  it('detects a moov written after mdat', async () => {
    const report = await analyzeFile(await loadFixture('portrait-no-faststart.mp4'));
    assert.equal(report.faststart, false);
    const order = report.topLevel.map((b) => b.type);
    assert.ok(order.indexOf('mdat') < order.indexOf('moov'), `box order was ${order.join(', ')}`);
  });

  it('classifies an evenly spaced track as constant frame rate', async () => {
    const report = await analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    assert.equal(report.video.timing.mode, 'cfr');
    assert.equal(report.video.timing.distinctDeltas, 1);
    assert.equal(report.video.timing.dominantShare, 1);
  });

  it('classifies a jittered track as variable frame rate', async () => {
    const report = await analyzeFile(await loadFixture('vfr.mp4'));
    assert.equal(report.video.timing.mode, 'vfr');
    assert.ok(report.video.timing.distinctDeltas > 2, 'should see many frame durations');
    assert.ok(report.video.timing.dominantShare < 0.95, 'no single delta should dominate');
  });

  it('separates near-constant from genuinely variable', async () => {
    const report = await analyzeFile(await loadFixture('near-cfr.mp4'));
    // Mostly one gap with a handful of outliers. Calling this "variable" would send
    // people re-encoding a file that does not need it.
    assert.equal(report.video.timing.mode, 'near-cfr');
    assert.ok(report.video.timing.dominantShare >= 0.95);
    assert.ok(report.video.timing.dominantShare < 0.999);
  });

  it('reports an untagged file as having no colour information', async () => {
    const report = await analyzeFile(await loadFixture('untagged-color.mp4'));
    assert.equal(report.video.color.present, false);
    assert.equal(report.video.color.primariesLabel, 'not tagged');
    assert.equal(report.video.color.isHdr, false);
  });

  it('reports BT.709 tags on a tagged file', async () => {
    const report = await analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    const { color } = report.video;
    assert.equal(color.present, true);
    assert.equal(color.type, 'nclx');
    assert.deepEqual([color.primaries, color.transfer, color.matrix], [1, 1, 1]);
    assert.equal(color.isHdr, false);
  });

  it('flags a PQ source as HDR', async (t) => {
    if (!groundTruth.fixtures['hdr-pq.mp4']) {
      t.skip('hdr-pq fixture not built');
      return;
    }
    const report = await analyzeFile(await loadFixture('hdr-pq.mp4'));
    assert.equal(report.video.color.isHdr, true);
    assert.equal(report.video.color.transferLabel, 'PQ (HDR10)');
    assert.equal(report.video.video?.bitDepth, 10);
  });

  it('orients dimensions by the rotation matrix', async () => {
    // All three are the same 1280x720 bitstream with a different tkhd matrix, which
    // is exactly how a rotated phone export reaches the app.
    const quarter = [90, 270];
    for (const angle of [90, 180, 270]) {
      const report = await analyzeFile(await loadFixture(`rotated-${angle}.mp4`));
      const { video } = report;
      assert.equal(video.rotationDegrees, angle, `rotation for ${angle}`);
      assert.equal(video.codedWidth, 1280, `coded width for ${angle}`);
      assert.equal(video.codedHeight, 720, `coded height for ${angle}`);

      const portrait = quarter.includes(angle);
      assert.equal(video.orientedWidth, portrait ? 720 : 1280, `oriented width for ${angle}`);
      assert.equal(video.orientedHeight, portrait ? 1280 : 720, `oriented height for ${angle}`);
    }
  });

  it('leaves an unrotated track oriented as coded', async () => {
    const report = await analyzeFile(await loadFixture('landscape-60fps.mp4'));
    assert.equal(report.video.rotationDegrees, 0);
    assert.equal(report.video.orientedWidth, 1280);
    assert.equal(report.video.orientedHeight, 720);
  });

  it('reads chroma format and bit depth from a High profile avcC', async () => {
    const report = await analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    assert.equal(report.video.video?.chromaFormat, '4:2:0');
    assert.equal(report.video.video?.bitDepth, 8);
  });

  it('computes a bitrate from the sample table', async () => {
    const report = await analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    const { video } = report;
    assert.ok(video.byteLength > 0, 'summed sample sizes should be positive');
    assert.ok(video.bitrateBps > 0, 'derived bitrate should be positive');
    // The video track cannot be bigger than the file that contains it.
    assert.ok(video.byteLength < report.fileSize, 'track bytes should fit in the file');
  });

  it('reports no fragments for a flat file', async () => {
    const report = await analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    assert.equal(report.fragmented, false);
    assert.equal(report.hasLargeBoxes, false);
  });
});

describe('edit lists', () => {
  it('treats ordinary encoder-delay compensation as trivial', async () => {
    // Practically every H.264 stream with B-frames carries a single edit whose media
    // time is a few frame durations, because that is how the container expresses
    // reordering delay. Classifying that as unusual would flag almost every file.
    const report = await analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    const { editList } = report.video;

    assert.equal(editList.present, true, 'the fixture should carry an edit list');
    assert.equal(editList.entryCount, 1);
    assert.ok(editList.firstMediaTime > 0, 'it should offset the start');
    assert.equal(editList.hasEmptyEdit, false);
    assert.equal(editList.hasRateChange, false);
    assert.equal(editList.nonTrivial, false, 'a single start offset is not noteworthy');
  });
});

describe('recommendations are proportionate', () => {
  it('recommends nothing for a file that is already in good shape', async () => {
    const report = await analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    const diagnosis = diagnose(report);

    assert.equal(
      diagnosis.recommended,
      'none',
      `a clean file should need no processing, got "${diagnosis.recommended}" because of: ` +
        diagnosis.findings.map((f) => `${f.id}(${f.severity}->${f.fix})`).join(', '),
    );
    assert.equal(diagnosis.clean, true);
  });

  it('recommends only a remux when the sole problem is the index position', async () => {
    const report = await analyzeFile(await loadFixture('portrait-no-faststart.mp4'));
    const diagnosis = diagnose(report);

    // The expensive path must not be chosen for a container-only problem.
    assert.equal(
      diagnosis.recommended,
      'remux',
      `expected a remux, got "${diagnosis.recommended}" because of: ` +
        diagnosis.findings.map((f) => `${f.id}(${f.severity}->${f.fix})`).join(', '),
    );
  });

  it('never lets a note escalate the recommendation', async () => {
    for (const name of ALL_FIXTURES) {
      if (!groundTruth.fixtures[name]) continue;
      const diagnosis = diagnose(await analyzeFile(await loadFixture(name)));
      if (diagnosis.recommended === 'none') continue;

      // Whatever mode was chosen, some blocker or warning must justify it.
      const justifying = diagnosis.findings.filter(
        (f) => f.severity !== 'note' && f.fix === diagnosis.recommended,
      );
      assert.ok(
        justifying.length > 0,
        `${name}: recommended "${diagnosis.recommended}" with no blocker or warning asking for it. ` +
          `Findings: ${diagnosis.findings.map((f) => `${f.id}(${f.severity}->${f.fix})`).join(', ')}`,
      );
    }
  });

  it('recommends a re-encode only where one is genuinely needed', async () => {
    // Variable frame rate cannot be fixed by a stream copy, so this is the real case.
    const diagnosis = diagnose(await analyzeFile(await loadFixture('vfr.mp4')));
    assert.equal(diagnosis.recommended, 'master');
  });
});

describe('error handling', () => {
  it('rejects a file with no box structure', async () => {
    const junk = new File([new Uint8Array(4096).fill(0x41)], 'junk.mp4', { type: 'video/mp4' });
    await assert.rejects(() => analyzeFile(junk), /no readable MP4 box structure|no moov box/i);
  });

  it('rejects an empty file', async () => {
    const empty = new File([new Uint8Array(0)], 'empty.mp4', { type: 'video/mp4' });
    await assert.rejects(() => analyzeFile(empty), /no readable MP4 box structure/i);
  });

  it('rejects a truncated file that only has an ftyp', async () => {
    const source = await readFile(path.join(fixtureDir, 'portrait-cfr-faststart.mp4'));
    // Keep the first box only, so ftyp parses but moov never arrives.
    const ftypSize = source.readUInt32BE(0);
    const truncated = new File([source.subarray(0, ftypSize)], 'truncated.mp4', { type: 'video/mp4' });
    await assert.rejects(() => analyzeFile(truncated), /no moov box/i);
  });
});
