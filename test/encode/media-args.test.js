// Byte-identity safety net for the media channel's ffmpeg argument builders,
// for the same reason as channel-args.test.js: strict-player playback can't be
// exercised here, and the loop is only correct while every clip shares one set
// of encode parameters and lasts whole segments (see encode/media.js). Any
// refactor MUST keep these arrays identical. Regenerate (only from known-good
// code, for an intended change) with:
//   UPDATE_GOLDEN=1 node --test test/encode/media-args.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config.js';
import {
  articleClipArgs, articleTimeline, scrollExpression, videoNormalizeArgs, videoPosterArgs, loopArgs,
  tileUp, loopRepeats, concatList,
} from '../../src/encode/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(__dirname, '..', 'fixtures', 'media-args.golden.json');

const PROFILES = {
  default: {
    width: 1280, height: 720, hlsTime: 6, fps: 25, preset: 'veryfast', crf: 24, maxrate: '2500k',
  },
  alt: {
    width: 1920, height: 1080, hlsTime: 4, fps: 30, preset: 'faster', crf: 22, maxrate: '4M',
  },
};

function applyProfile(p) {
  Object.assign(config.channel, { width: p.width, height: p.height, hlsTime: p.hlsTime });
  Object.assign(config.media, {
    fps: p.fps, preset: p.preset, crf: p.crf, maxrate: p.maxrate,
  });
}

const MUSIC = '/m/music.mp3';
const STILLS = {
  background: '/w/bg.png', layer: '/w/page.png', edges: '/w/edges.png', music: MUSIC, out: '/w/clip.mp4',
};

// A text-only article that fits one screen, one that scrolls, and one with two
// videos (one with sound, one silent) and the corner chip.
function textOnly() {
  const t = articleTimeline({ layerHeight: 720, screenHeight: 720, speed: 40, minSeconds: 15 });
  return articleClipArgs({ ...STILLS, phases: t.phases, seconds: t.total });
}
function scrolling() {
  const t = articleTimeline({ layerHeight: 2000, screenHeight: config.channel.height, speed: 60 });
  return articleClipArgs({
    ...STILLS, indicator: '/w/chip.png', phases: t.phases, seconds: t.total,
  });
}
function withVideos() {
  const videos = [
    {
      file: '/f/a.mp4', x: 96, y: 900, width: 1088, height: 612, focus: 650, duration: 7.5, hasAudio: true,
    },
    {
      file: '/f/b.mp4', x: 460, y: 1800, width: 360, height: 640, duration: 4, hasAudio: false,
    },
  ];
  const t = articleTimeline({
    layerHeight: 2600, screenHeight: config.channel.height, videos, speed: 40,
  });
  return articleClipArgs({
    ...STILLS,
    indicator: '/w/chip.png',
    videos: videos.map((v, k) => ({ ...v, start: t.starts[k] })),
    phases: t.phases,
    seconds: t.total,
  });
}

const CASES = [
  ['article-text-default', 'default', textOnly],
  ['article-scroll-default', 'default', scrolling],
  ['article-scroll-alt', 'alt', scrolling],
  ['article-videos-default', 'default', withVideos],
  ['article-videos-alt', 'alt', withVideos],
  ['normalize-audio-default', 'default', () => videoNormalizeArgs({ input: '/in/raw.mov', hasAudio: true, out: '/f/x.tmp.mp4' })],
  ['normalize-silent-alt', 'alt', () => videoNormalizeArgs({ input: '/in/raw.webm', hasAudio: false, out: '/f/x.tmp.mp4' })],
  ['poster-default', 'default', () => videoPosterArgs({ input: '/f/x.mp4', out: '/t/x.jpg' })],
  ['loop-default', 'default', () => loopArgs({ list: '/h/.build/list.txt', outDir: '/h/.build' })],
  ['loop-alt', 'alt', () => loopArgs({ list: '/h/.build/list.txt', outDir: '/h/.build' })],
];

const saved = { channel: { ...config.channel }, media: { ...config.media } };
function restore() {
  Object.assign(config.channel, saved.channel);
  Object.assign(config.media, saved.media);
}

function compute() {
  const out = {};
  for (const [name, profile, run] of CASES) {
    applyProfile(PROFILES[profile]);
    out[name] = run();
  }
  restore();
  return out;
}

if (process.env.UPDATE_GOLDEN) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, `${JSON.stringify(compute(), null, 2)}\n`);
}

test('media ffmpeg argv is byte-identical to the golden snapshot', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(compute(), golden);
});

test('every article clip uses one set of stream parameters', () => {
  // The loop is a stream copy of the clips: if two clips disagreed on any of
  // these, the joined stream would change format mid-way.
  applyProfile(PROFILES.default);
  const tail = (args) => args.slice(args.indexOf('-c:v'), args.indexOf('-t', args.indexOf('-c:v')));
  const a = tail(textOnly());
  const b = tail(withVideos());
  restore();
  assert.deepEqual(a, b);
});

test('clips last whole segments, rounded up so nothing is cut short', () => {
  assert.equal(tileUp(1, 6), 6);
  assert.equal(tileUp(6, 6), 6);
  assert.equal(tileUp(6.01, 6), 12);
  assert.equal(tileUp(0, 6), 6);
});

test('a page that fits holds for its seconds and never scrolls', () => {
  const t = articleTimeline({ layerHeight: 720, screenHeight: 720, speed: 40, minSeconds: 15 });
  assert.equal(t.total, 18); // 15s rounded up to whole 6s segments
  assert.equal(t.maxScroll, 0);
  assert.ok(t.phases.every((p) => p.from === 0 && p.to === 0));
});

test('a tall page holds, scrolls to the end at its speed, and holds again', () => {
  // 1200px of travel at 40px/s = 30s, plus a 3s hold at each end = 36s.
  const t = articleTimeline({ layerHeight: 1920, screenHeight: 720, speed: 40, minSeconds: 15 });
  assert.equal(t.total, 36);
  assert.deepEqual(t.phases.map((p) => [p.from, p.to]), [[0, 0], [0, 1200], [1200, 1200]]);
  assert.equal(t.phases[1].end - t.phases[1].start, 30);
});

test('the scroll stops with each video centred while it plays', () => {
  const videos = [
    { y: 1000, height: 400, duration: 10 },
    { y: 300, height: 200, duration: 5 }, // listed second but higher on the page
  ];
  const t = articleTimeline({ layerHeight: 3000, screenHeight: 720, videos, speed: 50 });
  const playing = t.phases.filter((p) => p.video !== undefined);
  assert.deepEqual(playing.map((p) => p.video), [1, 0], 'played in page order');
  // Video 1 centred: 300 + 100 - 360 = 40; video 0: 1000 + 200 - 360 = 840.
  assert.deepEqual(playing.map((p) => p.from), [40, 840]);
  assert.ok(playing.every((p) => p.from === p.to), 'the page is still while a video plays');
  assert.equal(t.starts[1], 3 + 40 / 50);
  assert.ok(Math.abs(playing[0].end - playing[0].start - 5) < 1e-9);
  // Phases tile the clip with no gap, and it ends a whole number of segments.
  t.phases.forEach((p, i) => { if (i) assert.equal(p.start, t.phases[i - 1].end); });
  assert.equal(t.phases.at(-1).end, t.total);
  assert.equal(t.total % 6, 0);
});

test('a video on a page that fits plays without any scrolling, and the page holds its time', () => {
  const t = articleTimeline({
    layerHeight: 720, screenHeight: 720, videos: [{ y: 200, height: 300, duration: 4 }], speed: 40, minSeconds: 15,
  });
  assert.equal(t.maxScroll, 0);
  assert.equal(t.starts[0], 3);
  assert.equal(t.total, 18);
});

test('the scroll expression follows the phases', () => {
  const phases = [
    { start: 0, end: 3, from: 0, to: 0 },
    { start: 3, end: 13, from: 0, to: 500 },
    { start: 13, end: 18, from: 500, to: 500 },
  ];
  const expr = scrollExpression(phases);
  // Evaluate it the way ffmpeg would, at a few instants.
  const at = (t) => Function('t', `const lt=(a,b)=>a<b?1:0;const iff=(c,a,b)=>c?a:b;return ${expr.replace(/if\(/g, 'iff(')};`)(t);
  assert.equal(at(1), 0);
  assert.equal(at(8), 250);
  assert.equal(at(15), 500);
  assert.equal(at(99), 500);
});

test('a short loop is repeated to fill one live window', (t) => {
  const liveLoop = config.channel.liveLoop;
  t.after(() => { config.channel.liveLoop = liveLoop; restore(); });
  applyProfile(PROFILES.default);
  config.channel.liveLoop = true;
  assert.equal(loopRepeats(6), 8); // 8 x 6s window
  assert.equal(loopRepeats(18), 3);
  assert.equal(loopRepeats(48), 1);
  config.channel.liveLoop = false;
  assert.equal(loopRepeats(6), 1); // plain VOD has no window to fill
});

test('the concat list quotes paths the way the demuxer expects', () => {
  assert.equal(concatList(['/a/b.mp4', "/c/it's.mp4"]), "file '/a/b.mp4'\nfile '/c/it'\\''s.mp4'\n");
});
