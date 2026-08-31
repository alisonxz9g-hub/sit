/**
 * Guide: what the tool does, what it deliberately does not do, and the export
 * settings that make the tool unnecessary in the first place.
 *
 * The last part matters most. Fixing a container after the fact is strictly worse than
 * exporting correctly, and a tool that hides that is selling something.
 */
import { AUDIO_TARGET, MAX_FPS, TARGETS, targetBitrateBps } from '../../core/index';
import { el } from '../dom';
import type { View } from '../view';

interface Item {
  readonly title: string;
  readonly body: string;
}

const HOW_IT_WORKS: Item[] = [
  {
    title: 'It reads the index, not the video',
    body:
      'An MP4 keeps its index (moov) separate from its payload (mdat). Everything the ' +
      'analysis needs lives in the index, so the app reads a few hundred kilobytes off ' +
      'the front of the file and never loads the video itself. A 500 MB export analyses ' +
      'as fast as a 5 MB one.',
  },
  {
    title: 'It measures rather than trusts',
    body:
      'Frame rate comes from summing the sample duration table, not from a declared ' +
      'field, which is the only way to tell constant frame rate from variable. Bitrate ' +
      'comes from summing actual sample sizes. Both are cross-checked against ffprobe in ' +
      'the test suite on real encoder output.',
  },
  {
    title: 'Fixes are the cheapest that will work',
    body:
      'A container problem gets a container fix: a stream copy, bit-identical video, ' +
      'done in seconds. Only problems that genuinely require re-encoding — uneven frame ' +
      'timing, wrong chroma format, off-ladder resolution — get a re-encode.',
  },
  {
    title: 'It re-checks its own output',
    body:
      'After every run the result goes back through the same parser, and the before/after ' +
      'panel is built from that second reading. When it says the video payload is ' +
      'identical byte for byte, that is a measurement, not a claim.',
  },
];

const NOT_DOING: Item[] = [
  {
    title: 'No malformed containers',
    body:
      'A well-known family of tools works by deliberately corrupting the file: cloning ' +
      'the audio track, inflating its sample table by ten times, and appending junk bytes ' +
      'outside the declared media area. The goal is to confuse the receiving platform\u2019s ' +
      'analysis into skipping its heaviest compression. It sometimes works. It also ' +
      'produces a file that is out of spec by construction, breaks the moment the other ' +
      'side tightens its parser, and can get the upload rejected outright rather than ' +
      'improved. Everything this app writes is a valid MP4.',
  },
  {
    title: 'No claims about internal encoding ladders',
    body:
      'No platform publishes the resolutions and bitrates it encodes to, so any tool ' +
      'stating them exactly is guessing. The targets here encode the uncontroversial part: ' +
      'land on a common resolution, use constant frame rate, tag your colour, and leave ' +
      'bitrate headroom. Those hold regardless of what the other side does this month.',
  },
  {
    title: 'No pretending a soft source can be rescued',
    body:
      'When the source bitrate is already below what its resolution needs, the app says ' +
      'so and stops. Re-encoding cannot restore detail that was never recorded; it just ' +
      'makes a larger file with the same softness. The honest fix is a better export, and ' +
      'the app will tell you that instead of selling you a progress bar.',
  },
];

const CAUSES: Item[] = [
  {
    title: 'Variable frame rate',
    body:
      'Screen recorders and phone cameras emit frames whenever they are ready. A ' +
      'receiving encoder assumes an even grid and resamples your timing to get one, which ' +
      'is where judder comes from. Export at a constant rate and the problem never arises.',
  },
  {
    title: 'Untagged colour',
    body:
      'If nothing in the file says which colour space the pixels are in, every player ' +
      'downstream guesses, and they do not all guess the same way. That is the actual ' +
      'cause of a clip looking washed out in one app and oversaturated in another. Tagging ' +
      'is metadata: it costs nothing and changes no pixels.',
  },
  {
    title: 'Index at the end of the file',
    body:
      'By default many muxers write the index after the media, so a reader must seek to ' +
      'the end before it can start. One flag at export time (faststart) moves it to the ' +
      'front.',
  },
  {
    title: 'Bitrate set too low',
    body:
      'The single biggest cause of a soft upload, and the one no post-processing can fix. ' +
      'Whatever the platform does to your file, it starts from what you gave it.',
  },
];

function itemList(items: readonly Item[]): HTMLElement {
  return el(
    'div',
    { class: 'guide-items' },
    items.map((item) =>
      el('div', { class: 'guide-item' }, [
        el('h3', { text: item.title }),
        el('p', { text: item.body }),
      ]),
    ),
  );
}

/** Concrete export settings, derived from the same constants the pipeline uses. */
function exportTable(): HTMLElement {
  const rows = TARGETS.map((target) => {
    const at30 = targetBitrateBps(target.width, target.height, 30);
    const at60 = targetBitrateBps(target.width, target.height, 60);
    return el('tr', {}, [
      el('td', { text: target.label }),
      el('td', { text: `${(at30 / 1_000_000).toFixed(0)} Mbps` }),
      el('td', { text: `${(at60 / 1_000_000).toFixed(0)} Mbps` }),
    ]);
  });

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Resolution' }),
          el('th', { text: 'At 30 fps' }),
          el('th', { text: 'At 60 fps' }),
        ]),
      ]),
      el('tbody', {}, rows),
    ]),
    el('p', {
      class: 'muted small',
      text:
        'Target bitrates for export, not hard limits. They are generous on purpose: this ' +
        'file is an intermediate, and you want the receiving encoder to be the only lossy ' +
        'step left.',
    }),
  ]);
}

export function createGuide(): View {
  const element = el('div', { class: 'view view-guide' }, [
    el('header', { class: 'view-head' }, [
      el('h1', { text: 'How this works' }),
      el('p', {
        class: 'lede',
        text:
          'A short version: most quality lost on upload is lost before the upload starts. ' +
          'This tool finds the parts that are fixable, fixes them without touching your ' +
          'pixels where it can, and is direct about the parts that are not fixable here.',
      }),
    ]),

    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What it does' }),
      itemList(HOW_IT_WORKS),
    ]),

    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What it deliberately does not do' }),
      itemList(NOT_DOING),
    ]),

    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'Export settings that make this tool unnecessary' }),
      el('p', {
        class: 'lede small',
        text:
          'Every problem below is easier to avoid than to repair. If your editor can do ' +
          'these, you will not need the optimizer for anything except checking.',
      }),
      el('ul', { class: 'checklist' }, [
        el('li', { text: 'H.264 (AVC), High profile, 4:2:0 chroma, 8-bit.' }),
        el('li', { text: `Constant frame rate at 24, 25, 30, 50 or ${MAX_FPS} fps. Not "variable", not "match source".` }),
        el('li', { text: 'One of the resolutions in the table below, exactly.' }),
        el('li', { text: 'Colour tagged as Rec.709. In most editors this is the default; in some it is a checkbox nobody finds.' }),
        el('li', { text: `Audio: ${AUDIO_TARGET.codec}, ${AUDIO_TARGET.sampleRate / 1000} kHz, stereo, ${AUDIO_TARGET.bitrateBps / 1000} kbps or higher.` }),
        el('li', { text: 'Fast start / "optimise for web" / "move index to front" enabled.' }),
        el('li', { text: 'Bitrate at or above the table below. This is the one that actually decides how it looks.' }),
      ]),
      exportTable(),
    ]),

    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'Where the quality actually goes' }),
      itemList(CAUSES),
    ]),

    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'Privacy' }),
      el('p', {
        text:
          'There is no backend. No accounts, no credits, no telemetry, no uploads. The ' +
          'transcoding engine is served from this same origin rather than a CDN, so ' +
          'nothing outside the page learns that you processed anything. You can confirm ' +
          'all of this by opening the network tab and watching it stay empty.',
      }),
    ]),
  ]);

  return {
    element,
    destroy() {
      /* nothing to tear down */
    },
  };
}
