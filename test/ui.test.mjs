/**
 * Smoke tests for the UI layer under jsdom.
 *
 * Not a substitute for opening a browser, but it catches the failures that are easy to
 * ship and hard to notice: a view that throws on construction, a renderer that breaks
 * on an unusual report, and — the one that actually matters for security — a filename
 * or log line reaching the page as markup instead of text.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const fixtureDir = path.join(import.meta.dirname, 'fixtures');

let ui;
let core;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'https://example.test/',
    pretendToBeVisual: true,
  });

  // The UI modules read these off the global scope, the way they would in a browser.
  // Some of them (navigator, notably) are accessor-only on Node's globalThis, so they
  // have to be redefined rather than assigned.
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (cb) => dom.window.setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => dom.window.clearTimeout(id),
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  // jsdom has no blob URL support; the optimizer only calls this once a job finishes.
  dom.window.URL.createObjectURL = () => 'blob:stub';
  dom.window.URL.revokeObjectURL = () => undefined;

  core = await import('./.build/core.mjs');
  ui = await import('./.build/ui.mjs');
});

async function loadFixture(name, as = name) {
  const bytes = await readFile(path.join(fixtureDir, name));
  return new File([bytes], as, { type: 'video/mp4' });
}

describe('views construct', () => {
  for (const factory of ['createOptimizer', 'createAnalyzer', 'createGuide']) {
    it(factory, () => {
      const view = ui[factory]();
      assert.ok(view.element, 'should expose an element');
      assert.equal(typeof view.destroy, 'function', 'should expose destroy');
      assert.ok(view.element.querySelector('h1'), 'should render a heading');
      // Destroying twice must not throw: the router can race with an unload.
      view.destroy();
      view.destroy();
    });
  }

  it('the router registers every route and marks one active', () => {
    const container = document.createElement('div');
    const nav = document.createElement('nav');
    const stop = ui.startRouter(container, nav);

    assert.equal(nav.childElementCount, ui.ROUTES.length, 'one link per route');
    assert.equal(nav.querySelectorAll('.is-active').length, 1, 'exactly one active link');
    assert.ok(container.querySelector('.view'), 'a view should be mounted');

    stop();
  });
});

describe('report renderers', () => {
  it('render a full report without throwing', async () => {
    const report = await core.analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));
    const diagnosis = core.diagnose(report);

    const summary = ui.renderSummary(report);
    assert.ok(summary.textContent.includes('portrait-cfr-faststart.mp4'));
    assert.ok(summary.textContent.includes('1080 x 1920'));
    assert.ok(summary.textContent.includes('Rec.709'));
    assert.ok(summary.textContent.includes('faststart'));

    const findings = ui.renderFindings(diagnosis);
    assert.ok(findings.textContent.length > 0);

    const boxes = ui.renderBoxLayout(report);
    assert.equal(
      boxes.querySelectorAll('.box-seg').length,
      report.topLevel.length,
      'one segment per top-level box',
    );

    for (const [index, track] of report.tracks.entries()) {
      const detail = ui.renderTrackDetail(track, index);
      assert.ok(detail.textContent.includes(track.codecLabel));
    }
  });

  it('render a comparison between two reports', async () => {
    const before = await core.analyzeFile(await loadFixture('portrait-no-faststart.mp4'));
    const after = await core.analyzeFile(await loadFixture('portrait-cfr-faststart.mp4'));

    const compare = ui.renderComparison(before, after);
    const text = compare.textContent;
    assert.ok(text.includes('end of file'), 'should show the before state');
    assert.ok(text.includes('front'), 'should show the after state');
    assert.ok(compare.querySelectorAll('.compare-row').length > 4);
  });

  it('handle a video-only report without an audio track', async () => {
    const report = await core.analyzeFile(await loadFixture('no-audio.mp4'));
    const summary = ui.renderSummary(report);
    assert.ok(summary.textContent.includes('none'), 'should say audio is missing');
  });

  it('render an empty findings list as an explicit all-clear', () => {
    const clean = { findings: [], recommended: 'none', clean: true, needsReexport: [] };
    const rendered = ui.renderFindings(clean);
    assert.ok(rendered.textContent.includes('Nothing to fix'));
  });
});

describe('untrusted text is never markup', () => {
  const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">.mp4';

  it('a hostile filename is escaped in the summary', async () => {
    const report = await core.analyzeFile(await loadFixture('portrait-cfr-faststart.mp4', HOSTILE));
    assert.equal(report.fileName, HOSTILE, 'the parser should pass the name through unchanged');

    const summary = ui.renderSummary(report);
    // The filename must appear as text, and must not have created an element.
    assert.ok(summary.textContent.includes(HOSTILE), 'should be present as text');
    assert.equal(summary.querySelector('img'), null, 'must not create an element');
    assert.equal(globalThis.__pwned, undefined, 'must not execute');
  });

  it('a hostile filename is escaped in a job card', async () => {
    const view = ui.createOptimizer();
    document.body.appendChild(view.element);

    const dropZone = view.element.querySelector('.dropzone');
    const input = dropZone.querySelector('input[type=file]');
    const file = await loadFixture('portrait-cfr-faststart.mp4', HOSTILE);

    // Drive the real intake path rather than a private helper.
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change'));

    // Intake analyses asynchronously; give the microtask queue room to settle.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const card = view.element.querySelector('.job');
    assert.ok(card, 'a job card should have been added');
    assert.ok(card.textContent.includes(HOSTILE), 'the name should be present as text');
    assert.equal(view.element.querySelector('img'), null, 'must not create an element');
    assert.equal(globalThis.__pwned, undefined, 'must not execute');

    view.destroy();
    view.element.remove();
  });

  it('log lines are written as text', () => {
    const log = new ui.RunLog();
    log.write('<script>globalThis.__pwned = 1</script>', 'bad');
    log.finish();

    assert.equal(log.element.querySelector('script'), null, 'must not create an element');
    assert.ok(log.element.textContent.includes('<script>'), 'should be visible as text');
    assert.equal(globalThis.__pwned, undefined, 'must not execute');
  });

  it('the log drops old lines instead of growing without bound', () => {
    const log = new ui.RunLog();
    for (let i = 0; i < 900; i++) log.write(`line ${i}`);
    log.finish();

    const count = log.element.querySelectorAll('.log-line').length;
    assert.ok(count <= 400, `expected the log to be capped, saw ${count} lines`);
    assert.ok(log.element.textContent.includes('line 899'), 'the newest line should survive');
    assert.ok(!log.element.textContent.includes('line 0\n'), 'the oldest lines should be gone');
  });
});

describe('progress bar', () => {
  it('reflects a ratio and clamps out-of-range values', () => {
    const bar = new ui.ProgressBar();
    const track = bar.element.querySelector('[role=progressbar]');

    bar.set(0.5, 'half');
    assert.equal(track.getAttribute('aria-valuenow'), '50');

    bar.set(2);
    assert.equal(track.getAttribute('aria-valuenow'), '100', 'should clamp above 1');

    bar.set(-1);
    assert.equal(track.getAttribute('aria-valuenow'), '0', 'should clamp below 0');

    bar.indeterminate('loading');
    assert.ok(bar.element.classList.contains('is-indeterminate'));
    bar.reset();
    assert.ok(!bar.element.classList.contains('is-indeterminate'));
  });
});

describe('formatting', () => {
  it('formats sizes, rates and durations', () => {
    const { format } = ui;
    assert.equal(format.bytes(512), '512 B');
    assert.equal(format.bytes(1536), '1.5 KB');
    assert.equal(format.bitrate(850_000), '850 kbps');
    assert.equal(format.bitrate(12_400_000), '12.4 Mbps');
    assert.equal(format.bitrate(null), '—');
    assert.equal(format.duration(75), '1:15');
    assert.equal(format.duration(3725), '1:02:05');
    assert.equal(format.fps(30), '30 fps');
    assert.equal(format.fps(29.97), '29.97 fps');
  });

  it('builds a safe output filename', () => {
    const { format } = ui;
    assert.equal(format.outputName('clip.mp4', 'optimized'), 'clip_optimized.mp4');
    assert.equal(format.outputName('a/b:c*.mov', 'master'), 'a_b_c__master.mp4');
    assert.ok(!format.outputName('x'.repeat(200), 'master').includes('/'));
    assert.ok(format.outputName('x'.repeat(200), 'master').length < 100);
  });
});
