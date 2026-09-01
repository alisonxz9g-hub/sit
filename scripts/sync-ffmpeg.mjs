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
 * The ESM build is the one to copy, and getting this wrong is not obvious. @ffmpeg/ffmpeg
 * always spawns its worker with `type: "module"`, where `importScripts` does not exist.
 * Its worker tries `importScripts(coreURL)` first, and on failure falls back to
 * `(await import(coreURL)).default`. The UMD bundle has no ES exports, so that `.default`
 * is undefined and the load fails with a bare import error — after the browser has
 * already downloaded 31 MB. The check at the end of this script asserts the copied core
 * really does have a default export, so the mistake cannot be reintroduced silently.
 */
import { cp, mkdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(projectRoot, 'public', 'vendor', 'ffmpeg');

/** Files we need out of @ffmpeg/core, relative to that package's root. */
const CORE_FILES = ['dist/esm/ffmpeg-core.js', 'dist/esm/ffmpeg-core.wasm'];

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

  await assertEsmCore(path.join(outDir, 'ffmpeg-core.js'));

  // The app reads this to build the core URLs and to show the engine version in
  // the UI, so a stale vendor copy can never silently disagree with package.json.
  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(
      { version, flavour: 'esm', coreURL: 'ffmpeg-core.js', wasmURL: 'ffmpeg-core.wasm' },
      null,
      2,
    )}\n`,
  );

  console.log(`ffmpeg.wasm core ${version} (esm) vendored -> public/vendor/ffmpeg (${(copied / 1048576).toFixed(1)} MB)`);
}

/**
 * Fails the build if the vendored core is not an ES module with a default export.
 *
 * Without this, copying the wrong flavour produces a site that looks fine, downloads
 * 31 MB, and only then fails inside a worker with an error the user cannot act on.
 */
async function assertEsmCore(file) {
  const source = await readFile(file, 'utf8');
  if (!/export\s*(\{[^}]*\bdefault\b[^}]*\}|default\s)/.test(source)) {
    throw new Error(
      `${path.basename(file)} has no ES default export, so it is almost certainly the UMD ` +
        'build. @ffmpeg/ffmpeg runs its worker as a module and imports the core, which ' +
        'only works with the ESM build. Check CORE_FILES.',
    );
  }
}

main().catch((err) => {
  console.error('Failed to vendor the ffmpeg.wasm core.');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
