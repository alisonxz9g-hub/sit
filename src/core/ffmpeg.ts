/**
 * ffmpeg.wasm lifecycle.
 *
 * The core is ~31 MB and loading it is the single slowest thing this app does, so it
 * is loaded lazily on first use and kept for the rest of the session. It is served
 * from our own origin (see scripts/sync-ffmpeg.mjs) rather than a CDN, which means no
 * third party learns what anyone transcodes and the app keeps working offline.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';

export interface FfmpegProgress {
  /** 0..1, as reported by the core. Unreliable early in a run. */
  readonly ratio: number;
  /** Media timestamp reached, in microseconds. */
  readonly time: number;
}

export type LogHandler = (line: string) => void;
export type ProgressHandler = (progress: FfmpegProgress) => void;

const VENDOR_BASE = 'vendor/ffmpeg';

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

/** Listeners are re-pointed per run rather than re-registered, to avoid leaks. */
let currentLog: LogHandler | null = null;
let currentProgress: ProgressHandler | null = null;

function vendorUrl(file: string): string {
  const version = import.meta.env.VITE_FFMPEG_VERSION;
  const query = version ? `?v=${encodeURIComponent(version)}` : '';
  return new URL(`${VENDOR_BASE}/${file}${query}`, document.baseURI).href;
}

export class FfmpegError extends Error {
  override readonly name = 'FfmpegError';
  /** Tail of the core's own log, which is where the real reason usually is. */
  readonly log: readonly string[];

  constructor(message: string, log: readonly string[] = []) {
    super(message);
    this.log = log;
  }
}

/**
 * Loads the core, or returns the already-loaded one. Concurrent callers share a
 * single load.
 */
export async function loadFfmpeg(onLog?: LogHandler): Promise<FFmpeg> {
  if (instance) return instance;
  if (loading) return loading;

  loading = (async () => {
    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      currentLog?.(message);
    });
    ffmpeg.on('progress', ({ progress, time }) => {
      currentProgress?.({ ratio: Math.min(1, Math.max(0, progress)), time });
    });

    currentLog = onLog ?? null;

    try {
      await ffmpeg.load({
        coreURL: vendorUrl('ffmpeg-core.js'),
        wasmURL: vendorUrl('ffmpeg-core.wasm'),
      });
    } catch (cause) {
      throw new FfmpegError(
        'The transcoding engine could not load. Check your connection, and check ' +
          'whether a content blocker is stopping a 31 MB WebAssembly download.',
        cause instanceof Error ? [cause.message] : [],
      );
    }

    instance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

export function isFfmpegLoaded(): boolean {
  return instance !== null;
}

export interface RunOptions {
  readonly input: File;
  readonly args: readonly string[];
  /** Output filename inside the virtual filesystem. */
  readonly outputName: string;
  readonly onLog?: LogHandler;
  readonly onProgress?: ProgressHandler;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly bytes: Uint8Array;
  readonly log: readonly string[];
}

/** Keeps the tail of the log for error reporting without growing without bound. */
const LOG_TAIL = 40;

/**
 * Runs one ffmpeg invocation against a single input file.
 *
 * The input is written to the virtual filesystem under a fixed name so the caller's
 * argument list never has to quote a user-supplied filename. Both files are removed
 * afterwards even on failure, because the virtual filesystem lives in memory for the
 * whole session and a leaked 500 MB input is a crash later on.
 */
export async function runFfmpeg(options: RunOptions): Promise<RunResult> {
  const { input, args, outputName, onLog, onProgress, signal } = options;

  const ffmpeg = await loadFfmpeg(onLog);
  const tail: string[] = [];

  currentLog = (line) => {
    tail.push(line);
    if (tail.length > LOG_TAIL) tail.shift();
    onLog?.(line);
  };
  currentProgress = onProgress ?? null;

  // A fixed input name keeps user-controlled text out of the argument list entirely.
  const extension = input.name.toLowerCase().endsWith('.mov') ? 'mov' : 'mp4';
  const inputName = `input.${extension}`;

  const onAbort = () => {
    // Terminating kills the worker, so the instance is discarded and the next run
    // reloads the core. That is the only reliable way to stop a running job.
    ffmpeg.terminate();
    instance = null;
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    signal?.throwIfAborted();

    await ffmpeg.writeFile(inputName, new Uint8Array(await input.arrayBuffer()));
    signal?.throwIfAborted();

    const code = await ffmpeg.exec([...args.map((a) => a.replace('{input}', inputName)), outputName]);
    if (code !== 0) {
      throw new FfmpegError(`The transcoding engine exited with code ${code}.`, [...tail]);
    }

    const output = await ffmpeg.readFile(outputName);
    const bytes = typeof output === 'string' ? new TextEncoder().encode(output) : output;
    if (bytes.length === 0) {
      throw new FfmpegError('The transcoding engine produced an empty file.', [...tail]);
    }

    return { bytes, log: [...tail] };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    currentLog = null;
    currentProgress = null;
    if (instance) {
      // Best-effort cleanup: a failed run may never have created either file.
      await instance.deleteFile(inputName).catch(() => undefined);
      await instance.deleteFile(outputName).catch(() => undefined);
    }
  }
}

/** Frees the core and its memory. */
export function disposeFfmpeg(): void {
  instance?.terminate();
  instance = null;
  loading = null;
}
