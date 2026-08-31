/**
 * Generates the MP4 fixtures the parser tests run against, plus ffprobe ground
 * truth for each one.
 *
 * The point of using a real encoder is that hand-written fixtures only ever contain
 * the structures the author already thought about. These come out of the same
 * muxer that produced the files users will actually drop on the app, including the
 * awkward ones: moov at the end, unspecified colour, rotation matrices, VFR.
 *
 * Requires ffmpeg and ffprobe on PATH. Run with `npm run fixtures`.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const fixtureDir = path.join(projectRoot, 'test', 'fixtures');

/** Shared source: a moving pattern plus a tone, so both track kinds are real. */
const VIDEO_IN = (size, rate, duration) => [
  '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${duration}`,
];
const AUDIO_IN = (duration) => [
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}:sample_rate=48000`,
];

// `ultrafast` silently forces Constrained Baseline by turning off CABAC and the
// 8x8 transform, which would make the "High profile" fixture a lie.
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
const AAC = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];

/**
 * Colour has to be tagged with the `setparams` filter. The `-color_primaries` and
 * `-color_trc` output options are accepted but only `-colorspace` actually reaches
 * the muxer, which would leave the fixture half-tagged.
 */
const TAG_BT709 = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';

/**
 * Each fixture states what it is meant to exercise, so a failing test points at a
 * property rather than at a filename.
 */
const FIXTURES = [
  {
    name: 'portrait-cfr-faststart.mp4',
    exercises: 'the happy path: 1080x1920, 30 fps CFR, High profile, BT.709, AAC-LC, faststart',
    filters: [TAG_BT709],
    args: [
      ...VIDEO_IN('1080x1920', 30, 2),
      ...AUDIO_IN(2),
      ...H264, '-profile:v', 'high', '-level', '4.0',
      ...AAC,
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'portrait-no-faststart.mp4',
    exercises: 'moov written after mdat, which is the mov muxer default',
    filters: [TAG_BT709],
    args: [
      ...VIDEO_IN('1080x1920', 30, 2),
      ...AUDIO_IN(2),
      ...H264, '-profile:v', 'high',
      ...AAC,
    ],
  },
  {
    name: 'landscape-60fps.mp4',
    exercises: '1280x720 at 60 fps, to check frame rate maths at a second rate',
    filters: [TAG_BT709],
    args: [
      ...VIDEO_IN('1280x720', 60, 2),
      ...AUDIO_IN(2),
      ...H264, '-profile:v', 'high',
      ...AAC,
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'untagged-color.mp4',
    exercises: 'no colour tags at all, the cause of shifted colours after re-encode',
    // Deliberately no setparams: an untagged lavfi source muxes with no colr box,
    // which is exactly what an untagged phone export looks like.
    filters: [],
    args: [
      ...VIDEO_IN('640x360', 30, 2),
      ...AUDIO_IN(2),
      ...H264,
      ...AAC,
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'near-cfr.mp4',
    exercises: 'mostly even spacing with a few decimated gaps, the "near CFR" band',
    filters: ['mpdecimate', TAG_BT709],
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=6:duration=4,fps=30',
      '-fps_mode', 'vfr',
      ...H264,
      '-an',
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'vfr.mp4',
    exercises: 'genuinely variable frame rate: every frame gap differs',
    // Jitters the presentation timestamps continuously. The derivative of
    // N + 0.4*sin(N) is always positive, so timestamps stay monotonic while no
    // single frame duration dominates.
    filters: ['setpts=(N+0.4*sin(N))/30/TB', TAG_BT709],
    args: [
      ...VIDEO_IN('640x360', 30, 4),
      '-fps_mode', 'passthrough',
      ...H264,
      '-an',
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'no-audio.mp4',
    exercises: 'a video-only file, so audio lookups must degrade cleanly',
    filters: [TAG_BT709],
    args: [
      ...VIDEO_IN('720x1280', 30, 2),
      ...H264,
      '-an',
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'baseline-profile.mp4',
    exercises: 'H.264 Baseline, where avcC carries no chroma extension',
    filters: [TAG_BT709],
    args: [
      ...VIDEO_IN('640x360', 30, 2),
      ...AUDIO_IN(2),
      ...H264, '-profile:v', 'baseline', '-level', '3.0',
      ...AAC,
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'hevc.mp4',
    exercises: 'HEVC in an hvc1 sample entry, so hvcC parsing is covered',
    optional: true,
    filters: [TAG_BT709],
    args: [
      ...VIDEO_IN('720x1280', 30, 2),
      ...AUDIO_IN(2),
      '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-tag:v', 'hvc1',
      ...AAC,
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'mono-44k-audio.mp4',
    exercises: 'a single 44.1 kHz channel, off the usual 48 kHz stereo target',
    filters: [TAG_BT709],
    args: [
      ...VIDEO_IN('640x360', 30, 2),
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100',
      ...H264,
      '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '1',
      '-movflags', '+faststart',
    ],
  },
  {
    name: 'hdr-pq.mp4',
    exercises: 'a PQ-tagged 10-bit source, which an SDR re-encode would crush',
    optional: true,
    filters: ['setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc'],
    args: [
      ...VIDEO_IN('720x1280', 30, 2),
      '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
      '-tag:v', 'hvc1',
      '-an',
      '-movflags', '+faststart',
    ],
  },
];

/**
 * Adds a rotation matrix to an existing fixture without touching the bitstream.
 * Three angles, because a single one cannot tell a correct sign convention from an
 * inverted one.
 */
const DERIVED = [90, 180, 270].map((angle) => ({
  name: `rotated-${angle}.mp4`,
  from: 'landscape-60fps.mp4',
  exercises: `a ${angle} degree tkhd transform matrix`,
  args: (input, output) => [
    '-y', '-display_rotation', String(angle), '-i', input,
    '-c', 'copy', '-movflags', '+faststart', output,
  ],
}));

async function ffmpeg(args) {
  try {
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return true;
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim().split('\n').slice(-3).join(' ');
    throw new Error(detail || 'ffmpeg failed');
  }
}

async function ffprobe(file) {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_entries', 'stream=index,codec_name,codec_tag_string,codec_type,profile,level,'
        + 'width,height,coded_width,coded_height,pix_fmt,r_frame_rate,avg_frame_rate,'
        + 'time_base,duration,nb_frames,bit_rate,sample_rate,channels,color_primaries,'
        + 'color_transfer,color_space,start_time:stream_side_data=:format=duration,size,'
        + 'bit_rate,format_name,nb_streams',
      file,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** ffprobe reports rotation in side data, which needs a separate query. */
async function probeRotation(file) {
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_side_data=rotation',
        '-print_format', 'json', file],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    const sideData = parsed.streams?.[0]?.side_data_list ?? [];
    const entry = sideData.find((d) => d.rotation !== undefined);
    return entry ? Number(entry.rotation) : 0;
  } catch {
    return 0;
  }
}

async function main() {
  await mkdir(fixtureDir, { recursive: true });

  const built = [];
  const skipped = [];

  for (const fixture of FIXTURES) {
    const output = path.join(fixtureDir, fixture.name);
    // Filters are declared separately and joined here, since ffmpeg only honours
    // the last -vf on the command line.
    const filterArgs = fixture.filters?.length ? ['-vf', fixture.filters.join(',')] : [];
    try {
      await ffmpeg(['-y', ...fixture.args, ...filterArgs, output]);
      built.push(fixture);
      console.log(`  built    ${fixture.name}`);
    } catch (err) {
      if (fixture.optional) {
        skipped.push({ name: fixture.name, reason: err.message });
        console.log(`  skipped  ${fixture.name} (${err.message})`);
        continue;
      }
      throw new Error(`Failed to build required fixture ${fixture.name}: ${err.message}`);
    }
  }

  for (const derived of DERIVED) {
    const input = path.join(fixtureDir, derived.from);
    const output = path.join(fixtureDir, derived.name);
    if (!built.some((f) => f.name === derived.from)) {
      skipped.push({ name: derived.name, reason: `source ${derived.from} missing` });
      continue;
    }
    await ffmpeg(derived.args(input, output));
    built.push(derived);
    console.log(`  built    ${derived.name}`);
  }

  // Ground truth, so the tests compare against the muxer rather than against numbers
  // someone typed in by hand.
  const truth = {};
  for (const fixture of built) {
    const file = path.join(fixtureDir, fixture.name);
    const probe = await ffprobe(file);
    truth[fixture.name] = {
      exercises: fixture.exercises,
      rotation: await probeRotation(file),
      format: probe.format,
      streams: probe.streams,
    };
  }

  await writeFile(
    path.join(fixtureDir, 'ground-truth.json'),
    `${JSON.stringify({ generatedBy: 'npm run fixtures', skipped, fixtures: truth }, null, 2)}\n`,
  );

  console.log(`\n${built.length} fixture(s) + ground truth written to test/fixtures`);
  if (skipped.length > 0) {
    console.log(`${skipped.length} optional fixture(s) skipped; tests for those will be skipped too.`);
  }
}

main().catch((err) => {
  console.error('Fixture generation failed.');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
