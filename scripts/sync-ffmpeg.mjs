/**
 * Copies the ffmpeg.wasm core out of node_modules into public/vendor/ffmpeg so the
 * app can serve it from its own origin.
 *
 * ffmpeg.wasm's documented setup pulls the core from a public CDN at runtime. We
 * self-host instead, for three reasons:
 *   - the app keeps working offline once it has been loaded,
 *   - no third party gets to see which of our users transcodes what, and
 *   - the core version is pinned by package.json instead of by whatever the CDN
 *     serves today.
 *
 * We copy the UMD build on purpose. The ESM build expects to be loaded as a module
 * from a URL it can resolve relative imports against; ffmpeg.wasm loads the core
 * inside a classic worker, which needs the UMD flavour.
 */
import { cp, mkdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(projectRoot, 'public', 'vendor', 'ffmpeg');

/** Files we need out of @ffmpeg/core, relative to that package's root. */
const CORE_FILES = ['dist/umd/ffmpeg-core.js', 'dist/umd/ffmpeg-core.wasm'];

/**
 * @ffmpeg/core declares an "exports" map that does not expose ./package.json, so
 * require.resolve cannot be used to find its root. Walk up from here looking for
 * the install directory instead.
 */
async function findCoreRoot() {
  let dir = projectRoot;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@ffmpeg', 'core');
    try {
      await access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('Could not find @ffmpeg/core in node_modules. Run `npm install` first.');
    }
    dir = parent;
  }
}

async function main() {
  const coreRoot = await findCoreRoot();
  const { version } = JSON.parse(await readFile(path.join(coreRoot, 'package.json'), 'utf8'));

  await mkdir(outDir, { recursive: true });

  let copied = 0;
  for (const rel of CORE_FILES) {
    const from = path.join(coreRoot, rel);
    const to = path.join(outDir, path.basename(rel));
    await cp(from, to);
    const { size } = await stat(to);
    copied += size;
    console.log(`  ${path.basename(rel).padEnd(20)} ${(size / 1048576).toFixed(1)} MB`);
  }

  // The app reads this to build the core URLs and to show the engine version in
  // the UI, so a stale vendor copy can never silently disagree with package.json.
  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify({ version, coreURL: 'ffmpeg-core.js', wasmURL: 'ffmpeg-core.wasm' }, null, 2)}\n`,
  );

  console.log(`ffmpeg.wasm core ${version} vendored -> public/vendor/ffmpeg (${(copied / 1048576).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error('Failed to vendor the ffmpeg.wasm core.');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
