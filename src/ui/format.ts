/** Number and unit formatting, kept in one place so the whole app reads the same. */

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${units[unit]}`;
}

export function bitrate(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return '—';
  if (bps < 1_000_000) return `${Math.round(bps / 1000)} kbps`;
  return `${(bps / 1_000_000).toFixed(bps < 10_000_000 ? 2 : 1)} Mbps`;
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fps(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  // Frame rates like 29.97 matter; 30.000001 from float division does not.
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded} fps` : `${rounded.toFixed(2)} fps`;
}

export function dimensions(width: number | null, height: number | null): string {
  if (width === null || height === null) return '—';
  return `${width} x ${height}`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Signed difference between two sizes, for the before/after report. */
export function sizeDelta(before: number, after: number): { text: string; tone: 'good' | 'warn' | 'bad' } {
  const delta = after - before;
  if (delta === 0) return { text: 'unchanged', tone: 'good' };
  const pct = Math.abs(delta / before) * 100;
  const sign = delta > 0 ? '+' : '-';
  const text = `${sign}${bytes(Math.abs(delta))} (${sign}${pct.toFixed(1)}%)`;
  // Growth is expected for a re-encode at a higher bitrate, so it is not a failure,
  // just something the reader should notice.
  return { text, tone: delta > 0 ? 'warn' : 'good' };
}

/** Rough duration for a pending job, phrased so nobody reads it as a promise. */
export function estimate(seconds: number): string {
  if (seconds < 10) return 'a few seconds';
  if (seconds < 60) return `around ${Math.round(seconds / 5) * 5} seconds`;
  const minutes = seconds / 60;
  if (minutes < 10) return `around ${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`;
  return `${Math.round(minutes / 5) * 5}+ minutes`;
}

/**
 * Strips the extension and appends a suffix, keeping the original stem so the user
 * can still tell their files apart.
 */
export function outputName(original: string, suffix: string): string {
  const stem = original.replace(/\.[^./\\]+$/, '') || 'video';
  // Anything that could confuse a download or a filesystem gets flattened.
  const safe = stem.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  return `${safe}_${suffix}.mp4`;
}
