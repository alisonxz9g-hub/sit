/**
 * End-to-end check in a real browser.
 *
 * This exists because the ffmpeg.wasm path cannot be verified any other way, and it is
 * the part of this app that has broken twice: once because the built site was not being
 * deployed at all, and once because the UMD core was vendored where the ESM one is
 * required. Both produced a page that looked fine until someone tried to process a file.
 *
 * It serves the production build, drives the real UI, and asserts a valid MP4 comes out
 * the other end.
 *
 * Usage: node scripts/browser-check.mjs [--headed]
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const projectRoot = path.resolve(import.meta.dirname, '..');
const PORT = 4199;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURE = 'portrait-no-faststart.mp4';
const headed = process.argv.includes('--headed');

/**
 * Starts `vite preview` and resolves once it actually answers a request.
 *
 * Vite's own bin is invoked through node directly rather than through npx with a shell:
 * no shell means no argument-escaping concerns, and it works the same on every platform.
 * Readiness is decided by polling rather than by matching the startup banner, because
 * banner text is not a contract and terminal encodings mangle it.
 */
async function startServer() {
  const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const server = spawn(
    process.execPath,
    [viteBin, 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  server.stdout.on('data', (chunk) => (output += chunk));
  server.stderr.on('data', (chunk) => (output += chunk));

  let exited = null;
  server.once('exit', (code) => (exited = code));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`vite preview exited early with code ${exited}\n${output.trim()}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return server;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  await stopServer(server);
  throw new Error(`vite preview did not answer on ${ORIGIN} within 60s\n${output.trim()}`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
  await Promise.race([once(server, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
}

async function main() {
  const fixturePath = path.join(projectRoot, 'test', 'fixtures', FIXTURE);
  await readFile(fixturePath); // fail early and clearly if fixtures were never generated

  const server = await startServer();
  const browser = await chromium.launch({ headless: !headed });
  const consoleErrors = [];
  const failedRequests = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`);
    });

    console.log('1. loading the app');
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });

    // The shell has to render. A blank page is the failure this whole script exists for.
    await page.waitForSelector('.topbar .nav-link', { timeout: 20_000 });
    await page.waitForSelector('.view-optimizer .dropzone', { timeout: 20_000 });
    const heading = await page.textContent('.view h1');
    assert.equal(heading?.trim(), 'Optimizer', `unexpected default view: ${heading}`);
    console.log('   shell and optimizer view rendered');

    console.log(`2. selecting ${FIXTURE}`);
    await page.setInputFiles('.view-optimizer input[type=file]', fixturePath);

    // Analysis is local and fast; the job card and mode picker appear when it is done.
    await page.waitForSelector('.job .modes', { timeout: 30_000 });
    const findingCount = await page.locator('.job .finding').count();
    assert.ok(findingCount > 0, 'expected the analysis to report at least one finding');
    console.log(`   analysed, ${findingCount} finding(s) shown`);

    // This fixture has its index at the end, so a remux is the suggested fix.
    const suggested = await page.textContent('.mode:has(.badge-accent) .mode-title');
    console.log(`   suggested mode: ${suggested?.trim()}`);

    // The engine is 31 MB. Watching for the request is how we prove the lossless path
    // does not touch it, which is the difference between 20 ms and minutes.
    const engineRequests = [];
    page.on('request', (req) => {
      if (/ffmpeg-core\.(js|wasm)/.test(req.url())) engineRequests.push(req.url());
    });

    console.log('3. running the suggested (lossless) mode');
    const startedAt = Date.now();
    await page.click('.queue-bar button.btn-primary');
    await page.waitForSelector('.job.state-done a.btn-primary[download]', { timeout: 180_000 });
    const elapsed = Date.now() - startedAt;
    console.log(`   job completed in ${elapsed} ms and a download link appeared`);

    assert.deepEqual(
      engineRequests,
      [],
      `the lossless path must not fetch the engine, but requested:\n${engineRequests.join('\n')}`,
    );
    const engineReady = await page.locator('.log-line', { hasText: 'Engine ready.' }).count();
    assert.equal(engineReady, 0, 'the engine should never have loaded for a container rewrite');
    assert.ok(
      await page.locator('.log-line', { hasText: 'index rebuilt' }).count() > 0,
      'the log should show the index being rewritten natively',
    );
    console.log('   engine was never requested (native path confirmed)');

    console.log('4. checking the output');
    const result = await page.evaluate(async () => {
      const link = document.querySelector('.job.state-done a.btn-primary[download]');
      const response = await fetch(link.href);
      const buffer = new Uint8Array(await response.arrayBuffer());
      const fourcc = String.fromCharCode(...buffer.subarray(4, 8));
      const second = String.fromCharCode(...buffer.subarray(buffer[3] + 4, buffer[3] + 8));
      return { name: link.getAttribute('download'), size: buffer.length, fourcc, second };
    });

    assert.equal(result.fourcc, 'ftyp', `output does not start with an ftyp box: got "${result.fourcc}"`);
    assert.ok(result.size > 1000, `output is implausibly small: ${result.size} bytes`);
    // Remux moves the index to the front, so moov should be the box right after ftyp.
    assert.equal(result.second, 'moov', `expected moov immediately after ftyp, got "${result.second}"`);

    console.log(`   ${result.name} — ${(result.size / 1024).toFixed(0)} KB, [ftyp][moov...] as expected`);

    const mode = suggested?.trim() ?? 'unknown';

    // Second phase: the ffmpeg path still has to work, since re-encodes depend on it.
    // A small fixture keeps this from taking minutes in single-threaded wasm.
    console.log('5. forcing a re-encode, to exercise the ffmpeg path');
    await page.click('.job .btn-ghost'); // remove the finished job
    await page.setInputFiles(
      '.view-optimizer input[type=file]',
      path.join(projectRoot, 'test', 'fixtures', 'untagged-color.mp4'),
    );
    await page.waitForSelector('.job .modes', { timeout: 30_000 });
    await page.locator('.mode input[value=master]').check();

    await page.click('.queue-bar button.btn-primary');
    await page.waitForSelector('.job.state-done a.btn-primary[download]', { timeout: 300_000 });

    assert.ok(engineRequests.length > 0, 'a re-encode should have fetched the engine');
    assert.ok(
      await page.locator('.log-line', { hasText: 'Engine ready.' }).count() > 0,
      'the log should confirm the engine loaded for the re-encode',
    );
    console.log(`   re-encode finished; engine fetched ${engineRequests.length} file(s)`);

    // Blob URLs show up as failed requests when revoked, so only flag real asset misses.
    const realFailures = failedRequests.filter((f) => !f.includes('blob:'));
    assert.deepEqual(realFailures, [], `requests failed:\n${realFailures.join('\n')}`);
    assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join('\n')}`);

    console.log(
      `\nBrowser check passed:\n` +
        `  "${mode}" ran natively in ${elapsed} ms with no engine download\n` +
        `  output is a faststart MP4\n` +
        `  the ffmpeg path still works for re-encodes`,
    );
  } finally {
    await browser.close();
    await stopServer(server);
  }
}

main().catch((err) => {
  console.error('\nBrowser check FAILED.');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
