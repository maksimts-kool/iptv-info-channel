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
  stillClipArgs, scrollClipArgs, videoClipArgs, videoThumbArgs, loopArgs,
  tileUp, textSlideSeconds, loopRepeats, concatList,
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

const CASES = [
  ['still-default', 'default', () => stillClipArgs({ frame: '/w/frame.png', seconds: 12, music: MUSIC, out: '/w/clip.mp4' })],
  ['still-alt', 'alt', () => stillClipArgs({ frame: '/w/frame.png', seconds: 8, music: MUSIC, out: '/w/clip.mp4' })],
  ['scroll-default', 'default', () => scrollClipArgs({
    background: '/w/bg.png', layer: '/w/text.png', edges: '/w/edges.png', seconds: 30, speed: 40, scale: 1, music: MUSIC, out: '/w/clip.mp4',
  })],
  ['scroll-alt', 'alt', () => scrollClipArgs({
    background: '/w/bg.png', layer: '/w/text.png', edges: '/w/edges.png', seconds: 28, speed: 60, scale: 1.5, music: MUSIC, out: '/w/clip.mp4',
  })],
  ['video-audio-default', 'default', () => videoClipArgs({
    input: '/in/raw.mov', duration: 7.3, hasAudio: true, music: MUSIC, out: '/f/x.tmp.mp4',
  })],
  ['video-silent-default', 'default', () => videoClipArgs({
    input: '/in/raw.webm', duration: 12, hasAudio: false, music: MUSIC, out: '/f/x.tmp.mp4',
  })],
  ['video-audio-alt', 'alt', () => videoClipArgs({
    input: '/in/raw.mp4', duration: 61.04, hasAudio: true, music: MUSIC, out: '/f/x.tmp.mp4',
  })],
  ['thumb-default', 'default', () => videoThumbArgs({ input: '/f/x.mp4', duration: 7.3, out: '/t/x.jpg' })],
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

test('every clip encoder shares one set of stream parameters', () => {
  // The loop is a stream copy of the clips: if two clips disagreed on any of
  // these, the joined stream would change format mid-way.
  applyProfile(PROFILES.default);
  const tail = (args) => args.slice(args.indexOf('-c:v'), args.indexOf('-t', args.indexOf('-c:v')));
  const still = tail(stillClipArgs({ frame: 'f', seconds: 6, music: 'm', out: 'o' }));
  const scroll = tail(scrollClipArgs({
    background: 'b', layer: 'l', edges: 'e', seconds: 6, speed: 40, music: 'm', out: 'o',
  }));
  const video = tail(videoClipArgs({
    input: 'i', duration: 3, hasAudio: true, music: 'm', out: 'o',
  }));
  restore();
  assert.deepEqual(scroll, still);
  assert.deepEqual(video, still);
});

test('slides last whole segments, rounded up so nothing is cut short', () => {
  assert.equal(tileUp(1, 6), 6);
  assert.equal(tileUp(6, 6), 6);
  assert.equal(tileUp(6.01, 6), 12);
  assert.equal(tileUp(7.3, 6), 12);
  assert.equal(tileUp(0, 6), 6);
});

test('a text page that fits holds; a taller one scrolls at its speed', () => {
  const fits = textSlideSeconds({ seconds: 15, layerHeight: 720, screenHeight: 720, speed: 40 });
  assert.equal(fits, 18); // 15s rounded up to whole 6s segments
  // 1200px of travel at 40px/s = 30s, plus 3s hold at each end = 36s.
  const tall = textSlideSeconds({ seconds: 15, layerHeight: 1920, screenHeight: 720, speed: 40 });
  assert.equal(tall, 36);
  // On a 1080p channel the same page is 1.5x taller AND scrolls 1.5x faster.
  const big = textSlideSeconds({ seconds: 15, layerHeight: 2880, screenHeight: 1080, scale: 1.5, speed: 40 });
  assert.equal(big, 36);
});

test('a short loop is repeated to fill one live window', (t) => {
  const liveLoop = config.channel.liveLoop;
  t.after(() => { config.channel.liveLoop = liveLoop; restore(); });
  applyProfile(PROFILES.default);
  config.channel.liveLoop = true;
  assert.equal(loopRepeats(6), 8); // 8 x 6s window
  assert.equal(loopRepeats(18), 3);
  assert.equal(loopRepeats(48), 1);
  assert.equal(loopRepeats(120), 1);
  config.channel.liveLoop = false;
  assert.equal(loopRepeats(6), 1); // plain VOD has no window to fill
});

test('the concat list quotes paths the way the demuxer expects', () => {
  assert.equal(concatList(['/a/b.mp4', "/c/it's.mp4"]), "file '/a/b.mp4'\nfile '/c/it'\\''s.mp4'\n");
});
