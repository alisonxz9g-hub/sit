/**
 * Prints the diagnosis for a fixture, for checking that recommendations are
 * proportionate. Ad-hoc inspection tool, not part of the test suite.
 *
 * Usage: node scripts/explain.mjs [fixture-name]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const { analyzeFile, diagnose } = await import('../test/.build/core.mjs');

const name = process.argv[2] ?? 'portrait-no-faststart.mp4';
const file = path.join(import.meta.dirname, '..', 'test', 'fixtures', name);
const report = await analyzeFile(new File([await readFile(file)], name, { type: 'video/mp4' }));
const diagnosis = diagnose(report);

const v = report.video;
console.log(`${name}`);
console.log(
  `  ${v.orientedWidth}x${v.orientedHeight}  ${v.timing.nominalFps?.toFixed(2)} fps (${v.timing.mode})  ` +
    `${v.codecLabel} ${v.video?.profile}  ${(v.bitrateBps / 1e6).toFixed(2)} Mbps  ` +
    `faststart=${report.faststart}`,
);
console.log(`  recommended: ${diagnosis.recommended}\n`);

for (const f of diagnosis.findings) {
  console.log(`  [${f.severity}] ${f.title}  -> fix: ${f.fix}`);
  console.log(`      ${f.evidence}`);
}
