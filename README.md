# Prepare

A local-first video optimizer for social upload. It reads an MP4 or MOV, reports exactly
what will cost you quality when you upload it, and fixes the fixable parts — without
re-encoding wherever a container fix is enough.

No backend, no accounts, no uploads. Analysis and processing both run in the browser tab.

## Why this exists

Most quality lost on upload is lost before the upload starts. The usual culprits are
boring and measurable: a container with its index at the wrong end, variable frame rate,
missing colour tags, a bitrate set too low at export. A receiving platform's encoder then
makes the best of what it was handed.

This tool measures those things and fixes what can be fixed.

## What it deliberately does not do

There is a well-known family of tools that works by corrupting the file on purpose:
cloning the audio track, inflating its sample table roughly tenfold, and appending junk
bytes outside the declared media area, to confuse the receiving platform's analysis into
skipping its heaviest compression pass.

That is not implemented here. It sometimes works, but it produces a file that is out of
spec by construction, stops working the moment the other side tightens its parser, and can
get an upload rejected rather than improved. **Every file this app writes is a valid MP4.**

Two related commitments:

- **No invented specifications.** No platform publishes its internal encoding ladder, so
  any tool stating it exactly is guessing. The targets here encode the uncontroversial
  part: land on a common resolution, use constant frame rate, tag your colour, leave
  bitrate headroom.
- **No pretending a soft source can be rescued.** When the source bitrate is already below
  what its resolution needs, the app says so and declines to re-encode, because
  re-encoding cannot restore detail that was never recorded.

## The three modes

| Mode | What it does | Lossless | Cost |
| --- | --- | --- | --- |
| **Remux** | Rebuilds the container, moves the index to the front, flattens fragments, drops edit lists | Yes — bit-identical streams | Seconds |
| **Retag** | Remux plus Rec.709 colour tags written into the container | Yes — metadata only | Seconds |
| **Re-encode** | Normalises frame timing, resolution, chroma and audio at high bitrate | No | Minutes |

The app picks the cheapest mode that resolves what it found, and explains why. You can
override it, and the exact `ffmpeg` command is shown before you run anything.

## Architecture

```
src/
  core/            no DOM, fully testable under plain Node
    mp4/
      reader.ts    bounds-checked big-endian reader
      boxes.ts     box tree parser
      scan.ts      streaming top-level scan via Blob.slice
      codecs.ts    avcC / hvcC / colr / esds decoders + enum tables
      tracks.ts    sample tables -> frame timing, bitrate, rotation
      analyze.ts   orchestration
    targets.ts     delivery resolutions and bitrate heuristics
    diagnose.ts    report -> findings, each with a concrete fix
    pipeline.ts    findings -> ffmpeg argument list
    ffmpeg.ts      ffmpeg.wasm lifecycle (browser only)
  ui/              vanilla TypeScript, no framework
```

Two design decisions worth calling out.

**Analysis never loads the video.** An MP4 keeps its index (`moov`) separate from its
payload (`mdat`). The scanner walks the top-level boxes by reading 16-byte headers through
`Blob.slice` and then reads only the boxes it needs. A 500 MB export costs a few hundred
kilobytes of memory to analyse, and analyses as fast as a 5 MB one.

**Everything is measured, not read off a label.** Frame rate comes from summing the
`stts` sample duration table, which is the only way to distinguish constant from variable
frame rate. Bitrate comes from summing actual sample sizes in `stsz`. Rotation comes from
the `tkhd` transform matrix, and the app exposes an *oriented* frame size, because a
rotated phone export is stored landscape with a 90-degree matrix and neither the coded nor
the `tkhd` display size answers "is this 1080x1920 portrait?" on its own.

## Getting started

```bash
npm install
npm run dev
```

`npm install` is followed automatically by a vendoring step that copies the pinned
`@ffmpeg/core` build into `public/vendor/ffmpeg`, so the engine is served from your own
origin instead of a CDN. That keeps the app working offline after first load, and means no
third party learns what anyone transcodes.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vendor the engine, then start Vite |
| `npm run build` | Vendor, typecheck, then build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run fixtures` | Regenerate test fixtures (needs `ffmpeg` and `ffprobe` on PATH) |
| `npm test` | Bundle the sources, then run the full suite |
| `npm run smoke` | Boot the built bundle in jsdom and check it renders |
| `npm run browser-check` | Drive the built site in Chromium, end to end |
| `npm run explain <fixture>` | Print the diagnosis for one fixture |

## Testing

71 tests across three files, plus two out-of-band checks. The approach matters more than
the count.

**The parser is cross-validated against ffprobe.** `npm run fixtures` uses a local ffmpeg
to generate 14 fixtures that each exercise one awkward property — moov at the end,
genuinely variable frame rate, untagged colour, PQ/HDR, 90/180/270-degree rotation
matrices, HEVC, Baseline profile, mono 44.1 kHz audio — and records ffprobe's reading of
each as ground truth. The tests then assert that our parser agrees. Real muxer output
rather than hand-written fixtures, because hand-written fixtures only contain the
structures their author already thought about.

**The pipeline is verified end to end.** `test/pipeline.test.mjs` takes the argument lists
the app actually builds, runs them through the local ffmpeg, and re-analyses the output
with our own parser. It checks the claim rather than the exit code: that remux and retag
leave the video payload identical byte for byte, that retag really does add an `nclx`
`colr` box, that a re-encode converts variable frame rate to constant, and that a rotated
source comes out upright without being upscaled.

**The UI is smoke-tested under jsdom**, including a hostile filename
(`<img src=x onerror=...>`) driven through the real intake path to confirm untrusted text
reaches the page as text and never as markup.

**The built site is driven in a real browser.** `npm run browser-check` serves the
production build, launches Chromium, drops in a fixture, clicks Optimize, waits for the
31 MB engine to load and the job to finish, then fetches the resulting blob and checks it
begins `[ftyp][moov`. It also fails on any console error or failed request.

This last one exists because it is the only check that can reach the ffmpeg.wasm path, and
that path has broken twice in ways every other check passed:

- The built site was not being deployed at all, so Pages served the TypeScript entry point.
- The UMD core was vendored where the ESM one is required. `@ffmpeg/ffmpeg` always runs its
  worker as a module, so `importScripts` is unavailable and it falls back to
  `import(coreURL)`. The UMD bundle has no ES exports, so initialisation failed — after
  downloading 31 MB. `scripts/sync-ffmpeg.mjs` now asserts the vendored core has a default
  export, so that mistake cannot come back silently.

### Verified, and not

Verified locally: typecheck clean, production build clean, all 71 tests passing, the
production bundle boots under both `/` and a subpath, every asset served with the correct
MIME type (including the wasm as `application/wasm`, which
`WebAssembly.instantiateStreaming` requires), and a full run through the real UI in
Chromium producing a valid MP4.

Not verified: only Chromium is exercised. Safari in particular has its own history with
WebAssembly memory limits on large files, and nothing here has been run against it.

## Deployment

`npm run build` produces a fully static `dist/`, deployable to any static host with no
special headers.

**Serve `dist/`, not the repository.** The `index.html` at the repo root is a Vite entry
point that loads `src/main.ts`, and browsers do not run TypeScript. Pointing a host at the
repository root serves that file verbatim and renders a blank page with no error.

**Set the base path if the site is not at a domain root.** Built asset URLs are absolute,
so a site served from `example.com/subdir/` needs `VITE_BASE_PATH=/subdir/ npm run build`
or every asset request resolves against the domain root and 404s.

### GitHub Pages

`.github/workflows/deploy.yml` handles both of the above. It builds with the base path
that `actions/configure-pages` reports, boots the result in jsdom to prove it renders, and
publishes the artifact.

It needs one manual setting: **Settings → Pages → Source → GitHub Actions**. With Source
left on "Deploy from a branch", Pages serves the repository source and the workflow output
is ignored.

`.github/workflows/ci.yml` runs the typecheck, the full test suite (installing ffmpeg for
the fixtures) and the build on every push and pull request.

### Notes

`dist/` includes the ~31 MB wasm core. It is fetched lazily on the first re-encode, not on
page load, so the page itself stays well under 100 kB.

The single-threaded ffmpeg core is used so the build deploys anywhere. The multithreaded
one needs `SharedArrayBuffer`, which requires `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot set those. On a host that
can, switching to `@ffmpeg/core-mt` in `scripts/sync-ffmpeg.mjs` makes re-encoding several
times faster.

## Licence

The app code in this repository is yours to do as you like with. Note that its dependencies
carry their own terms: ffmpeg.wasm ships FFmpeg and libx264, which are LGPL and GPL
respectively. Distributing a build means distributing GPL-licensed components, so check
that this fits your intended use.
