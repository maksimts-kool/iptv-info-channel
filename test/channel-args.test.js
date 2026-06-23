// Byte-identity safety net for the ffmpeg argument builders. CLAUDE.md warns
// against changing the HLS/ffmpeg construction without strict-player testing —
// which can't be done here — so instead we pin the exact argv across config
// permutations. Any refactor of channel.js's arg builders MUST keep these
// arrays identical. Regenerate the golden (only from known-good code) with:
//   UPDATE_GOLDEN=1 node --test test/channel-args.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { introFfmpegArgs, stillFfmpegArgs } from '../src/channel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(__dirname, 'fixtures', 'ffmpeg-args.golden.json');

const PROFILES = {
  default: {
    accountSlideSeconds: 120, width: 1280, height: 720, fps: 12, stillFps: 4, preset: 'ultrafast',
    hlsTime: 6, timerEnabled: true, fontFile: '', slideSeconds: 4, transition: 'slideleft', statusSeconds: 12, worldcupSeconds: 14,
  },
  timerOff: {
    accountSlideSeconds: 120, width: 1280, height: 720, fps: 12, stillFps: 4, preset: 'ultrafast',
    hlsTime: 6, timerEnabled: false, fontFile: '', slideSeconds: 4, transition: 'slideleft', statusSeconds: 12, worldcupSeconds: 14,
  },
  fontFile: {
    accountSlideSeconds: 120, width: 1280, height: 720, fps: 12, stillFps: 4, preset: 'ultrafast',
    hlsTime: 6, timerEnabled: true, fontFile: '/fonts/Inter.ttf', slideSeconds: 4, transition: 'slideleft', statusSeconds: 12, worldcupSeconds: 14,
  },
  alt: {
    accountSlideSeconds: 90, width: 1920, height: 1080, fps: 10, stillFps: 5, preset: 'veryfast',
    hlsTime: 4, timerEnabled: true, fontFile: '', slideSeconds: 5, transition: 'fade', statusSeconds: 15, worldcupSeconds: 18,
  },
};

function applyProfile(p) {
  Object.assign(config.channel, {
    accountSlideSeconds: p.accountSlideSeconds, width: p.width, height: p.height, fps: p.fps,
    stillFps: p.stillFps, preset: p.preset, hlsTime: p.hlsTime,
  });
  config.channel.slideTimer.enabled = p.timerEnabled;
  config.channel.slideTimer.fontFile = p.fontFile;
  config.intro.slideSeconds = p.slideSeconds;
  config.intro.transition = p.transition;
  config.statusSlide.seconds = p.statusSeconds;
  config.worldcupSlide.seconds = p.worldcupSeconds;
}

const SLIDES = { slide1: '/t/slide1.png', card: '/t/card.png' };
const SLIDES_STATUS = { ...SLIDES, status: '/t/status.png' };
const SLIDES_WORLDCUP = { ...SLIDES, worldcup: '/t/worldcup.png' };
const SLIDES_STATUS_WORLDCUP = { ...SLIDES_STATUS, worldcup: '/t/worldcup.png' };
const MUSIC = '/m/music.mp3';
const TMP = '/t';

// Still-loop global slides are passed as { file, seconds }; the seconds mirror
// what channel.js threads through from each slide's config.
const statusExtra = () => ({ file: '/t/status.png', seconds: config.statusSlide.seconds });
const worldcupExtra = () => ({ file: '/t/worldcup.png', seconds: config.worldcupSlide.seconds });

const CASES = [
  // --- Original permutations: unchanged argv (byte-identity safety net). ---
  ['intro-card-default', 'default', () => introFfmpegArgs(SLIDES, MUSIC, TMP)],
  ['intro-card-timerOff', 'timerOff', () => introFfmpegArgs(SLIDES, MUSIC, TMP)],
  ['intro-card-fontFile', 'fontFile', () => introFfmpegArgs(SLIDES, MUSIC, TMP)],
  ['intro-status-default', 'default', () => introFfmpegArgs(SLIDES_STATUS, MUSIC, TMP)],
  ['intro-status-timerOff', 'timerOff', () => introFfmpegArgs(SLIDES_STATUS, MUSIC, TMP)],
  ['intro-status-alt', 'alt', () => introFfmpegArgs(SLIDES_STATUS, MUSIC, TMP)],
  ['still-nostatus-default', 'default', () => stillFfmpegArgs('/t/card.png', [], MUSIC, TMP)],
  ['still-status-default', 'default', () => stillFfmpegArgs('/t/card.png', [statusExtra()], MUSIC, TMP)],
  ['still-status-timerOff', 'timerOff', () => stillFfmpegArgs('/t/card.png', [statusExtra()], MUSIC, TMP)],
  ['still-status-alt', 'alt', () => stillFfmpegArgs('/t/card.png', [statusExtra()], MUSIC, TMP)],
  // --- New World Cup bracket permutations (status + bracket global slides). ---
  ['intro-worldcup-default', 'default', () => introFfmpegArgs(SLIDES_WORLDCUP, MUSIC, TMP)],
  ['intro-status-worldcup-default', 'default', () => introFfmpegArgs(SLIDES_STATUS_WORLDCUP, MUSIC, TMP)],
  ['intro-status-worldcup-alt', 'alt', () => introFfmpegArgs(SLIDES_STATUS_WORLDCUP, MUSIC, TMP)],
  ['still-worldcup-default', 'default', () => stillFfmpegArgs('/t/card.png', [worldcupExtra()], MUSIC, TMP)],
  ['still-status-worldcup-default', 'default', () => stillFfmpegArgs('/t/card.png', [statusExtra(), worldcupExtra()], MUSIC, TMP)],
  ['still-status-worldcup-alt', 'alt', () => stillFfmpegArgs('/t/card.png', [statusExtra(), worldcupExtra()], MUSIC, TMP)],
];

function compute() {
  const out = {};
  for (const [name, profile, run] of CASES) {
    applyProfile(PROFILES[profile]);
    out[name] = run();
  }
  return out;
}

if (process.env.UPDATE_GOLDEN) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, `${JSON.stringify(compute(), null, 2)}\n`);
}

test('ffmpeg argv is byte-identical to the golden snapshot across config permutations', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(compute(), golden);
});
