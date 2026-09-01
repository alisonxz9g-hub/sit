/**
 * Prints the frame-timing classification for every fixture plus any extra files given on
 * the command line. Used to calibrate the CFR/VFR thresholds against real material rather
 * than against intuition.
 *
 * Usage: node scripts/timing-table.mjs [extra.mp4 ...]
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const { analyzeFile } = await import('../test/.build/core.mjs');
const fixtureDir = path.join(import.meta.dirname, '..', 'test', 'fixtures');

const files = [];
for (const name of (await readdir(fixtureDir)).filter((f) => f.endsWith('.mp4')).sort()) {
  files.push(path.join(fixtureDir, name));
}
files.push(...process.argv.slice(2));

const pad = (s, n) => String(s).padEnd(n);
console.log(
  `${pad('file', 30)}${pad('mode', 10)}${pad('nominal', 10)}${pad('steady', 9)}${pad('dominant', 10)}${pad('jitter%', 10)}${pad('deltas', 8)}entries`,
);
console.log('-'.repeat(96));

for (const file of files) {
  try {
    const bytes = await readFile(file);
    const report = await analyzeFile(new File([bytes], path.basename(file), { type: 'video/mp4' }));
    const t = report.video?.timing;
    if (!t) {
      console.log(`${pad(path.basename(file), 30)}(no video track)`);
      continue;
    }
    console.log(
      pad(path.basename(file), 30) +
        pad(t.mode, 10) +
        pad(t.nominalFps ? t.nominalFps.toFixed(3) : '-', 10) +
        pad(t.steadyShare.toFixed(4), 9) +
        pad(t.dominantShare.toFixed(4), 10) +
        pad(t.jitterPercent.toFixed(3), 10) +
        pad(t.distinctDeltas, 8) +
        t.entryCount,
    );
  } catch (err) {
    console.log(`${pad(path.basename(file), 30)}ERROR ${err.message}`);
  }
}
