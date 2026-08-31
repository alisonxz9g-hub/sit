import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // The vendored ffmpeg core lives in public/ and is fetched at runtime, so it
    // never enters the bundle graph. Everything we do bundle is small.
    chunkSizeWarningLimit: 700,
  },
  server: {
    // We ship the single-threaded ffmpeg core, which does not need
    // SharedArrayBuffer, so we deliberately do not set COOP/COEP here. That keeps
    // the built app deployable to any plain static host. See README for how to
    // switch to the multithreaded core.
    port: 5173,
  },
  // Vite pre-bundles dependencies for dev. @ffmpeg/ffmpeg spawns a worker from a
  // URL it computes itself, which the optimizer rewrites incorrectly, so we keep
  // it out.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});
