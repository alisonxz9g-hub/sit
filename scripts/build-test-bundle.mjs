/**
 * Bundles src/core into plain ESM so `node --test` can import it.
 *
 * The core is written as extensionless TypeScript modules, which Vite resolves but
 * Node does not. Rather than contorting the source to satisfy two resolvers, we run
 * it through the same bundler that builds the app. That has a useful side effect:
 * the test run fails if the core stops bundling cleanly.
 */
import path from 'node:path';
import process from 'node:process';
import { build } from 'vite';

const projectRoot = path.resolve(import.meta.dirname, '..');

/**
 * Two entries: the core (pure logic, runs under plain Node) and the UI layer (needs a
 * DOM, exercised under jsdom). Building both here means a test run also proves the UI
 * still bundles.
 */
const ENTRIES = [
  { entry: 'src/core/index.ts', out: 'core.mjs' },
  { entry: 'src/ui/index.ts', out: 'ui.mjs' },
];

async function main() {
  for (const [index, { entry, out }] of ENTRIES.entries()) {
    await build({
      configFile: false,
      root: projectRoot,
      logLevel: 'warn',
      build: {
        lib: {
          entry: path.join(projectRoot, entry),
          formats: ['es'],
          fileName: () => out,
        },
        outDir: path.join(projectRoot, 'test', '.build'),
        // Only the first pass clears the directory, or each entry would delete the
        // previous one's output.
        emptyOutDir: index === 0,
        target: 'node22',
        minify: false,
        sourcemap: false,
        reportCompressedSize: false,
        // CSS is imported by main.ts, not by the barrels, but keep it out regardless.
        cssCodeSplit: false,
      },
    });
    console.log(`bundled ${entry} -> test/.build/${out}`);
  }
}

main().catch((err) => {
  console.error('Failed to bundle sources for tests.');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
