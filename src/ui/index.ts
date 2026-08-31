/**
 * UI barrel, used by the app shell and by the jsdom smoke tests.
 *
 * Exists so the tests can exercise view construction and report rendering without
 * reaching into individual modules, and so a bundle of the UI layer is built on every
 * test run.
 */
export { el, append, clear, row, section, icon, qs } from './dom';
export * as format from './format';
export { RunLog, ProgressBar } from './log';
export {
  renderFinding,
  renderFindings,
  renderSummary,
  renderTrackDetail,
  renderBoxLayout,
  renderComparison,
} from './report';
export { ROUTES, startRouter } from './router';
export { createOptimizer } from './views/optimizer';
export { createAnalyzer } from './views/analyzer';
export { createGuide } from './views/guide';
export type { View } from './view';
