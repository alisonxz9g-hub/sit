/**
 * Boots the production bundle in jsdom and asserts the app actually renders.
 *
 * The unit tests exercise view factories directly. This checks the thing that broke on
 * GitHub Pages: that the *built* entry point runs end to end and replaces the empty
 * #app placeholder with a real interface. A blank page is the failure mode with no
 * error message, so it is worth a check that fails loudly.
 *
 * Usage: node scripts/smoke-dist.mjs [baseUrl]
 *   baseUrl defaults to "/" and should match the VITE_BASE_PATH used for the build.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const projectRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const basePath = process.argv[2] ?? '/';

async function findEntryBundle() {
  const assetsDir = path.join(distDir, 'assets');
  const files = await readdir(assetsDir);
  const entry = files.find((f) => /^index-.*\.js$/.test(f));
  if (!entry) throw new Error('No index-*.js found in dist/assets. Run the build first.');
  return path.join(assetsDir, entry);
}

async function main() {
  const html = await readFile(path.join(distDir, 'index.html'), 'utf8');

  // The document must not still be pointing at the TypeScript dev entry: that is
  // exactly what a misconfigured deploy serves, and it renders as a blank page.
  assert.ok(
    !html.includes('src="/src/main.ts"'),
    'dist/index.html still references the dev entry point src/main.ts',
  );

  const dom = new JSDOM(html, {
    url: `https://example.test${basePath}`,
    pretendToBeVisual: true,
  });

  // The bundle expects to run in a window. Anything it touches at module scope has to
  // exist as a global before the import, including MutationObserver, which Vite's
  // module-preload polyfill uses on the very first line.
  const forwarded = [
    'document',
    'navigator',
    'location',
    'history',
    'HTMLElement',
    'SVGElement',
    'Node',
    'Element',
    'Event',
    'CustomEvent',
    'MutationObserver',
    'IntersectionObserver',
    'DocumentFragment',
    'DOMParser',
    'FileReader',
    'DataTransfer',
    'getComputedStyle',
    'matchMedia',
    'performance',
  ];

  const globals = {
    window: dom.window,
    requestAnimationFrame: (cb) => dom.window.setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => dom.window.clearTimeout(id),
  };
  for (const name of forwarded) {
    const value = dom.window[name];
    if (value !== undefined) {
      globals[name] = typeof value === 'function' && !value.prototype ? value.bind(dom.window) : value;
    }
  }
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  dom.window.URL.createObjectURL = () => 'blob:stub';
  dom.window.URL.revokeObjectURL = () => undefined;

  const before = dom.window.document.getElementById('app');
  assert.ok(before, 'dist/index.html should contain #app');

  // Importing the entry runs boot(), the same as a browser loading the module.
  const entry = await findEntryBundle();
  await import(pathToFileURL(entry).href);

  // Give the router's initial navigation a turn to settle.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const app = dom.window.document.getElementById('app');
  const checks = [
    ['the shell header', '.topbar'],
    ['the nav links', '.nav-links .nav-link'],
    ['a mounted view', '.content .view'],
    ['a heading', '.view h1'],
    ['the drop zone', '.dropzone'],
    ['the run log', '.log'],
  ];

  for (const [label, selector] of checks) {
    assert.ok(app.querySelector(selector), `expected ${label} (${selector}) to render`);
  }

  const navCount = app.querySelectorAll('.nav-links .nav-link').length;
  assert.equal(navCount, 3, `expected 3 nav links, found ${navCount}`);

  const heading = app.querySelector('.view h1').textContent;
  assert.equal(heading, 'Optimizer', `expected the default route to be the optimizer, got "${heading}"`);

  // Asset references must be prefixed with the deploy base, or every request 404s.
  const referenced = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  for (const ref of referenced) {
    assert.ok(
      ref.startsWith(basePath),
      `asset "${ref}" is not under the deploy base "${basePath}"`,
    );
  }

  console.log(`Boot OK under base "${basePath}".`);
  console.log(`  shell, ${navCount} nav links and the "${heading}" view rendered`);
  console.log(`  ${referenced.length} asset reference(s), all under the base path`);
}

main().catch((err) => {
  console.error('The production bundle failed to boot.');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
