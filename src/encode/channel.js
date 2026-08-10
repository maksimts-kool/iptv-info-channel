// Generates a per-user looping HLS stream (static info card + background music)
// using ffmpeg, and keeps it refreshed daily so "days left" stays accurate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import cron from 'node-cron';
import { config } from '../config.js';
import { Users, Plans, Settings, Incidents } from '../data/store.js';
import {
  renderBodyPng, renderSlidesPng, renderStatusPng,
  buildBrandSlide1Svg, buildBodySvg, buildStatusSlideSvg,
} from '../render/overlay.js';
import { statusSummary } from '../render/status.js';
import { refreshDueSources, describePlans } from '../playlist/catalog.js';
import * as notify from '../notify/notify.js';
import {
  currentLoopPosition, LIVE_WINDOW_SEGMENTS, writeLoopState,
} from './liveloop.js';
import { elapsedMs, log } from '../core/logger.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Common HLS output args. ffmpeg writes a finite VOD asset on disk; liveloop.js
// then serves it as one shared, always-running live channel (it is not
// re-anchored to the intro per tune-in).
function hlsOutArgs(tmpDir) {
  return [
    '-f', 'hls',
    '-hls_time', String(config.channel.hlsTime),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(tmpDir, 'seg_%03d.ts'),
    path.join(tmpDir, 'index.m3u8'),
  ];
}

// Video encoder args shared by both paths. Keyframes are forced exactly on the
// HLS segment boundaries (not via a fixed GOP) so segments stay clean even at
// the very low frame rates we use for a static card. `-sc_threshold 0` stops
// ffmpeg inserting extra keyframes on the (non-existent) scene changes.
function videoEncodeArgs(fps) {
  const seg = config.channel.hlsTime;
  return [
    '-c:v', 'libx264', '-preset', config.channel.preset, '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-force_key_frames', `expr:gte(t,n_forced*${seg})`,
    '-sc_threshold', '0',
  ];
}

// AAC stereo audio settings, identical on every encode path.
const AUDIO_ENCODE_ARGS = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100'];

// Shared output tail for the two intro paths: map the composed video and fade
// the looped music input `audioIndex`, then the common encode + HLS output.
function introOutputArgs(audioIndex, aOut, fps, tmpDir) {
  return [
    '-map', '[v]', '-map', `${audioIndex}:a`,
    '-af', `afade=t=in:d=1,afade=t=out:st=${aOut}:d=2`,
    ...videoEncodeArgs(fps),
    ...AUDIO_ENCODE_ARGS,
    '-shortest',
    ...hlsOutArgs(tmpDir),
  ];
}

// Bottom-right "next slide in N" countdown, baked in with drawtext. `boundaries`
// is the sorted list of times (s) at which the visible slide changes, ending
// with the loop total. Each segment counts whole seconds down to its boundary.
// Escaping: single quotes protect spaces/commas at the filtergraph level, but
// ffmpeg strips them before splitting options on ':', so the colons inside
// %{eif:…:d} must additionally be backslash-escaped to survive that split.
function slideTimerFilters(boundaries) {
  const cfg = config.channel.slideTimer;
  if (!cfg.enabled || boundaries.length < 1) return null;
  const font = cfg.fontFile ? `fontfile='${cfg.fontFile}'` : 'font=Inter';
  let prev = 0;
  // The colons inside %{eif:...:d} must be escaped as \: — ffmpeg strips the
  // quotes around a filter option's value before splitting options on ':', so an
  // unescaped colon there is parsed as a new option and breaks the filtergraph.
  return boundaries.map((b) => {
    const start = Number(prev).toFixed(2);
    const end = Number(b).toFixed(2);
    prev = Number(b);
    return `drawtext=${font}:text='Далее через %{eif\\:ceil(${end}-t)\\:d}'`
      + ':fontcolor=white:fontsize=28:box=1:boxcolor=0x0f1830@0.85:boxborderw=18'
      + `:x=w-tw-40:y=h-th-34:enable='between(t,${start},${end})'`;
  }).join(',');
}

// Append the countdown drawtext to a base filter chain that ends by producing
// the [v] label. No-op when the timer is disabled or has no boundaries.
function withSlideTimer(filter, boundaries) {
  const timer = slideTimerFilters(boundaries);
  if (!timer) return filter;
  return `${filter.replace(/\[v\]$/, '[vbase]')};[vbase]${timer}[v]`;
}

// Round a raw loop length to the NEAREST whole number of HLS segments so the
// looped VOD tiles cleanly (liveloop loops whole segments and drops the trailing
// runt). The account card is the elastic still frame that absorbs the rounding
// slack; rounding to nearest (not up) keeps that drift to ±half a segment so the
// card stays close to its configured ACCOUNT_SLIDE_SECONDS instead of ballooning.
//
// A loop served as live must also be at least one live window long. Below that
// the sliding window wraps inside a single playlist — the same segments listed
// twice, one or two loop discontinuities in every response — so a viewer is
// permanently sitting on a PTS restart, which is the fragile path for strict
// players. The card absorbs the difference, exactly as it absorbs the rounding.
// With the shipped 8-segment window and HLS_TIME=6 that is a 48s floor; drop
// HLS_TIME if you want the slides to rotate faster than that.
function tileToSegments(seconds) {
  const seg = config.channel.hlsTime;
  const tiled = Math.max(seg, Math.round(seconds / seg) * seg);
  if (!config.channel.liveLoop) return tiled; // plain VOD: no window to fill
  return Math.max(tiled, LIVE_WINDOW_SEGMENTS * seg);
}

// ---------------------------------------------------------------------------
// ffmpeg argument builders (introFfmpegArgs / stillFfmpegArgs).
//
// These two exported builders are PINNED by a byte-identity golden snapshot
// (test/encode/channel-args.test.js against test/fixtures/ffmpeg-args.golden.json).
// Real strict-player playback can't be exercised in CI, so byte-identical argv
// is the proof that a refactor of the helpers below changed nothing — the
// golden must keep passing unchanged. Only when you *intend* to change the
// encode do you regenerate it, from known-good code, with:
//   UPDATE_GOLDEN=1 node --test test/encode/channel-args.test.js
// Never rewrite the snapshot silently just to make a red test go green.
// ---------------------------------------------------------------------------

// ffmpeg args for an animated channel: brand slide -> (xfade transition) ->
// info card, with background music. Any global slides present (currently just
// the status board) are appended in order as further chained xfades:
// slide -> card -> status. The account card shows for its own
// configured duration (config.channel.accountSlideSeconds); the loop total is the sum.
export function introFfmpegArgs(slides, music, tmpDir) {
  const extras = globalExtras(slides);
  return extras.length
    ? introWithExtrasArgs(slides.slide1, slides.card, extras, music, tmpDir)
    : introCardOnlyArgs(slides, music, tmpDir);
}

// The optional global slides appended after the card, in fixed order. Each is
// { file, seconds }; the seconds come from each slide's own config so different
// hold times are respected. The list shape is kept (rather than collapsing to
// the single status slide) so another global frame can be added back cheaply.
function globalExtras(slides) {
  const extras = [];
  if (slides.status) extras.push({ file: slides.status, seconds: config.statusSlide.seconds });
  return extras;
}

function introCardOnlyArgs(slides, music, tmpDir) {
  const cardDur = Math.max(6, config.channel.accountSlideSeconds);   // account card on-screen
  const { width: W, height: H, fps } = config.channel;
  const XF = 0.8;                 // transition length (s)
  const S = Math.max(XF + 0.5, config.intro.slideSeconds); // brand slide on-screen
  // Loop total = intro slide + card less the shared xfade, tiled onto segment
  // boundaries; the still card absorbs the rounding slack.
  const total = tileToSegments(S + cardDur - XF);
  const L2 = total - S + XF;                               // card hold length
  const o1 = (S - XF).toFixed(2);                          // transition offset
  const fos = (L2 - 0.6).toFixed(2);                       // card fade-out start
  const aOut = Math.max(0, total - 2).toFixed(2);

  const baseFilter =
    `[0:v]scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p,fade=t=in:st=0:d=0.6[v0];` +
    `[1:v]scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p,fade=t=out:st=${fos}:d=0.6[v1];` +
    `[v0][v1]xfade=transition=${config.intro.transition}:duration=${XF}:offset=${o1}[v]`;
  // Slide -> card transition starts at o1; loop restarts at total (= dur).
  const filter = withSlideTimer(baseFilter, [S - XF, S + L2 - XF]);

  return [
    '-y',
    '-loop', '1', '-t', String(S), '-i', slides.slide1,
    '-loop', '1', '-t', L2.toFixed(2), '-i', slides.card,
    '-stream_loop', '-1', '-i', music,
    '-filter_complex', filter,
    ...introOutputArgs(2, aOut, fps, tmpDir),
  ];
}

// slide -> card -> [extras...], chained xfades. The account card shows for its
// own configured duration; the loop total is the sum of every frame (less the
// xfade overlaps), tiled onto hlsTime segment boundaries so the looped VOD has
// no runt segment. The still card absorbs the rounding slack.
function introWithExtrasArgs(slide1, card, extras, music, tmpDir) {
  const cardDur = Math.max(6, config.channel.accountSlideSeconds);   // account card on-screen
  const { width: W, height: H, fps } = config.channel;
  const XF = 0.8;                                          // transition length (s)
  const S = Math.max(XF + 0.5, config.intro.slideSeconds); // brand slide on-screen
  const extraLens = extras.map((e) => Math.max(XF + 1, e.seconds)); // each extra on-screen
  const k = extras.length;
  const sumExtras = extraLens.reduce((sum, len) => sum + len, 0);
  // n = k + 2 frames; each of the k+1 chained xfades reclaims XF seconds.
  const total = tileToSegments(S + cardDur + sumExtras - (k + 1) * XF);
  const Lc = total - S - sumExtras + (k + 1) * XF;        // card hold length

  // Per-frame on-screen lengths: slide, card, then each extra. n = k + 2 frames.
  const D = [S, Lc, ...extraLens];
  const n = D.length;

  // Source filters: the first frame fades in, the last fades out, middles plain.
  const frameParts = D.map((len, i) => {
    const fade = i === 0
      ? ',fade=t=in:st=0:d=0.6'
      : i === n - 1
        ? `,fade=t=out:st=${(len - 0.6).toFixed(2)}:d=0.6`
        : '';
    return `[${i}:v]scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p${fade}[v${i}];`;
  });

  // Chained xfades. The transition that brings in frame f starts at
  // (sum of on-screen lengths before f) - f*XF. Intermediate labels reuse the
  // original `vx` name for the first, then vx2, vx3, … so the 3-frame argv is
  // unchanged.
  const boundaries = [];
  const xfadeParts = [];
  let prev = 'v0';
  let cumulative = 0;
  for (let f = 1; f < n; f += 1) {
    cumulative += D[f - 1];
    const offset = cumulative - f * XF;
    boundaries.push(offset);
    const out = f === n - 1 ? 'v' : f === 1 ? 'vx' : `vx${f}`;
    xfadeParts.push(
      `[${prev}][v${f}]xfade=transition=${config.intro.transition}:duration=${XF}:offset=${offset.toFixed(2)}[${out}]`
      + (f < n - 1 ? ';' : ''),
    );
    prev = out;
  }
  // The final xfade ends exactly at the pre-computed (tiled) loop total.
  boundaries.push(total);
  const aOut = Math.max(0, total - 2).toFixed(2);

  const filter = withSlideTimer(frameParts.join('') + xfadeParts.join(''), boundaries);

  const inputArgs = [
    '-loop', '1', '-t', String(S), '-i', slide1,
    '-loop', '1', '-t', Lc.toFixed(2), '-i', card,
  ];
  extras.forEach((extra, i) => {
    inputArgs.push('-loop', '1', '-t', extraLens[i].toFixed(2), '-i', extra.file);
  });

  return [
    '-y',
    ...inputArgs,
    '-stream_loop', '-1', '-i', music,
    '-filter_complex', filter,
    ...introOutputArgs(n, aOut, fps, tmpDir),
  ];
}

// ffmpeg args for a plain still loop (intro disabled). `extras` is the ordered
// list of global slides ({ file, seconds }) to concatenate after the card with
// hard cuts: card -> status. Empty `extras` is the bare card loop.
// The card holds for its own configured duration; the loop total is the sum,
// tiled onto segment boundaries (the still card absorbs the rounding slack).
export function stillFfmpegArgs(cardPng, extras, music, tmpDir) {
  const { stillFps: fps } = config.channel;
  const cardDur = Math.max(6, config.channel.accountSlideSeconds);   // account card on-screen
  if (!extras.length) {
    return [
      '-y',
      '-loop', '1', '-i', cardPng,
      '-stream_loop', '-1', '-i', music,
      '-t', String(tileToSegments(cardDur)),
      '-map', '0:v', '-map', '1:a',
      ...videoEncodeArgs(fps),
      ...AUDIO_ENCODE_ARGS,
      ...hlsOutArgs(tmpDir),
    ];
  }

  const extraLens = extras.map((e) => Math.max(2, e.seconds));
  const sumExtras = extraLens.reduce((sum, len) => sum + len, 0);
  // Card shows for its own duration; total tiled onto segments, card takes slack.
  const Lc = tileToSegments(cardDur + sumExtras) - sumExtras;
  const lens = [Lc, ...extraLens]; // on-screen length of every concatenated frame
  const m = lens.length;

  const frameParts = lens.map((_, i) => `[${i}:v]fps=${fps},format=yuv420p,setsar=1[c${i}];`);
  const concatInputs = lens.map((_, i) => `[c${i}]`).join('');
  const baseFilter = `${frameParts.join('')}${concatInputs}concat=n=${m}:v=1:a=0[v]`;

  // Hard cuts at each cumulative frame boundary; loop restarts at the total.
  const boundaries = [];
  let acc = 0;
  for (const len of lens) { acc += len; boundaries.push(acc); }
  const filter = withSlideTimer(baseFilter, boundaries);

  const inputArgs = ['-loop', '1', '-t', Lc.toFixed(2), '-i', cardPng];
  extras.forEach((extra, i) => {
    inputArgs.push('-loop', '1', '-t', extraLens[i].toFixed(2), '-i', extra.file);
  });

  return [
    '-y',
    ...inputArgs,
    '-stream_loop', '-1', '-i', music,
    '-filter_complex', filter,
    '-map', '[v]', '-map', `${m}:a`,
    ...videoEncodeArgs(fps),
    ...AUDIO_ENCODE_ARGS,
    '-shortest',
    ...hlsOutArgs(tmpDir),
  ];
}

class AbortedError extends Error {
  constructor() { super('generation aborted by newer request'); this.aborted = true; }
}

function run(cmd, args, label = cmd, signal = null) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (error) => {
      if (signal?.aborted) { reject(new AbortedError()); return; }
      log.error('process', `${label} could not start`, { error: error.message });
      reject(error);
    });
    p.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      if (signal?.aborted) { reject(new AbortedError()); return; }
      log.error('process', `${label} failed`, {
        pid: p.pid,
        code,
        output: err.slice(-800),
      });
      reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
    });
    signal?.addEventListener('abort', () => p.kill(), { once: true });
  });
}

// Prefer the configured track, then the bundled asset, with synthesis as a
// last resort so stream generation can still proceed after a broken install.
let musicReady = null;
export async function ensureMusic() {
  if (musicReady) return musicReady;
  musicReady = (async () => {
    if (fs.existsSync(config.musicFile) && fs.statSync(config.musicFile).size > 0) {
      return config.musicFile;
    }
    if (
      config.musicFile !== config.defaultMusicFile
      && fs.existsSync(config.defaultMusicFile)
      && fs.statSync(config.defaultMusicFile).size > 0
    ) {
      log.warn('music', 'configured background track missing; using bundled track', {
        configured_file: config.musicFile,
        fallback_file: config.defaultMusicFile,
      });
      return config.defaultMusicFile;
    }
    log.warn('music', 'background track missing; synthesizing placeholder', {
      file: config.musicFile,
    });
    fs.mkdirSync(path.dirname(config.musicFile), { recursive: true });
    // Gentle two-note pad with fades; low volume so it sits quietly under the card.
    await run(FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=329.63:duration=30',
      '-filter_complex',
      '[0:a][1:a]amix=inputs=2,volume=0.18,afade=t=in:d=3,afade=t=out:st=27:d=3,aformat=channel_layouts=stereo',
      '-c:a', 'libmp3lame', '-q:a', '5',
      config.musicFile,
    ], 'placeholder music synthesis');
    log.info('music', 'placeholder track created', { file: config.musicFile });
    return config.musicFile;
  })();
  return musicReady;
}

export function userHlsDir(userId) {
  return path.join(config.hlsDir, String(userId));
}

// A fingerprint of everything that affects a user's rendered stream. Hashing the
// actual SVG content (which already encodes username, plan, price, status,
// days-left and the footer date) plus the encode parameters lets us skip a fresh
// 1-vCPU encode when nothing has changed since the last successful generation —
// e.g. startup pre-gen followed by a manual "regenerate", or rapid double-clicks.
const SIG_FILE = 'sig';
function streamSignature(user, settings, plans, music, summary, subscribeUrl) {
  let musicMtime = 0;
  try { musicMtime = fs.statSync(music).mtimeMs; } catch { /* fall back to 0 */ }
  const c = config.channel;
  const svgs = config.intro.enabled
    ? [buildBrandSlide1Svg(settings, subscribeUrl), buildBodySvg(user, plans, settings)]
    : [buildBodySvg(user, plans, settings)];
  // The status board depends on external state (incidents + today's date), so
  // hashing its SVG busts the encode-skip cache whenever that content changes.
  if (summary) svgs.push(buildStatusSlideSvg(summary, settings));
  const payload = JSON.stringify({
    // Bump when the encode math (frame durations / loop sizing) changes so the
    // skip-cache re-encodes existing streams even when SVG content is identical.
    v: 2,
    svgs,
    enc: {
      W: c.width, H: c.height, fps: c.fps, stillFps: c.stillFps,
      preset: c.preset, accountSlideSeconds: c.accountSlideSeconds, hlsTime: c.hlsTime, liveLoop: c.liveLoop,
      slideTimer: c.slideTimer,
      intro: config.intro.enabled
        ? { slide: config.intro.slideSeconds, transition: config.intro.transition }
        : false,
      status: summary
        ? { seconds: config.statusSlide.seconds }
        : false,
    },
    musicMtime,
  });
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function readSig(dir) {
  try { return fs.readFileSync(path.join(dir, SIG_FILE), 'utf8').trim(); }
  catch { return null; }
}

export function playlistPath(userId) {
  return path.join(userHlsDir(userId), 'index.m3u8');
}

// One ffmpeg run per user at a time. Each entry: { promise, abort, gen }.
const inFlight = new Map();
const generationJobs = new Map();
let genSequence = 0;
const bulkGenerationJobs = new Map();
let bulkJobSequence = 0;

export function generationStatus() {
  const userJobs = [...generationJobs.values()];
  const bulkJobs = [...bulkGenerationJobs.values()];
  const startedAt = [...userJobs, ...bulkJobs]
    .map((job) => job.startedAt)
    .sort()[0] || null;
  const latestBulk = bulkJobs.at(-1);

  return {
    active: userJobs.length > 0 || bulkJobs.length > 0,
    started_at: startedAt,
    reason: latestBulk?.reason || userJobs.at(-1)?.reason || null,
    active_users: userJobs.map(({ userId, username }) => ({ id: userId, username })),
    bulk: latestBulk ? {
      total: latestBulk.total,
      completed: latestBulk.completed,
    } : null,
  };
}

export function generateForUser(userOrId, { reason = 'unspecified', force = false } = {}) {
  const user = typeof userOrId === 'object' ? userOrId : Users.get(userOrId);
  if (!user) throw new Error('user not found');

  // Abort any in-flight encode for this user so the newer request wins.
  if (inFlight.has(user.id)) inFlight.get(user.id).abort();

  const myGen = ++genSequence;
  const ac = new AbortController();
  const { signal } = ac;

  generationJobs.set(user.id, {
    userId: user.id,
    username: user.username,
    reason,
    startedAt: new Date().toISOString(),
  });

  const job = (async () => {
    const startedAt = Date.now();
    // Re-fetch from DB so we always encode the latest values, not a stale caller snapshot.
    const freshUser = Users.get(user.id);
    if (!freshUser) throw new Error('user not found');
    const settings = Settings.all();
    // The plan cards on the card/offer slides list what each plan includes —
    // which is now its catalog categories, resolved to names here so overlay.js
    // keeps rendering a plain `features` array.
    const plans = describePlans(Plans.all());
    const music = await ensureMusic();
    // Global Better Stack–style status board (null when the slide is disabled).
    const summary = config.statusSlide.enabled
      ? statusSummary(Incidents.all(), { tz: config.timezone })
      : null;
    // Per-user notification sign-up QR on the intro slide (only when intro is on
    // AND notifications are enabled). Null otherwise leaves the slide unchanged.
    const subscribeUrl = config.intro.enabled && notify.notifyEnabled()
      ? notify.subscribeUrlFor(freshUser)
      : null;

    const finalDir = userHlsDir(freshUser.id);
    const signature = streamSignature(freshUser, settings, plans, music, summary, subscribeUrl);
    // Skip the encode entirely when the existing stream already matches.
    if (!force && fs.existsSync(playlistPath(freshUser.id)) && readSig(finalDir) === signature) {
      log.info('channel', 'stream up to date; skipping encode', {
        user_id: freshUser.id,
        username: freshUser.username,
        reason,
      });
      return playlistPath(freshUser.id);
    }

    if (signal.aborted) throw new AbortedError();

    log.info('channel', 'generating stream', {
      user_id: freshUser.id,
      username: freshUser.username,
      reason,
    });

    const previousPosition = config.channel.liveLoop
      ? currentLoopPosition(finalDir)
      : null;
    fs.mkdirSync(config.hlsDir, { recursive: true });
    // Build in a temp dir on the SAME filesystem as the target so rename() works.
    // A cross-device rename throws EXDEV when data/ is a separate mount or Docker volume.
    const tmpDir = fs.mkdtempSync(path.join(config.hlsDir, `.build-${freshUser.id}-`));
    try {
      if (config.intro.enabled) {
        const slides = await renderSlidesPng(freshUser, settings, tmpDir, plans, summary, subscribeUrl);
        await run(
          FFMPEG,
          introFfmpegArgs(slides, music, tmpDir),
          `HLS encode for user ${freshUser.id}`,
          signal,
        );
      } else {
        const cardPng = path.join(tmpDir, 'card.png');
        await renderBodyPng(freshUser, settings, cardPng, plans);
        // Ordered global slides appended after the card (currently the status board).
        const extras = [];
        if (summary) {
          const statusPng = path.join(tmpDir, 'status.png');
          await renderStatusPng(summary, settings, statusPng);
          extras.push({ file: statusPng, seconds: config.statusSlide.seconds });
        }
        await run(
          FFMPEG,
          stillFfmpegArgs(cardPng, extras, music, tmpDir),
          `HLS encode for user ${freshUser.id}`,
          signal,
        );
      }

      if (config.channel.liveLoop) {
        writeLoopState(tmpDir, {
          // Skip beyond the previous advertised window. This makes an already
          // open player reload the new generation instead of treating it as old.
          baseSeq: previousPosition
            ? previousPosition.mediaSequence + LIVE_WINDOW_SEGMENTS
            : 0,
          baseDiscontinuity: previousPosition
            ? previousPosition.discontinuitySequence + 1
            : 0,
        });
      }

      // Record the fingerprint alongside the segments so the next run can skip an
      // identical re-encode.
      fs.writeFileSync(path.join(tmpDir, SIG_FILE), signature);

      // Atomic-ish swap: replace the live dir with the freshly generated one.
      const segmentCount = fs.readdirSync(tmpDir).filter((file) => file.endsWith('.ts')).length;
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, finalDir);
      log.info('channel', 'stream ready', {
        user_id: freshUser.id,
        segments: segmentCount,
        duration_ms: elapsedMs(startedAt),
      });
      return playlistPath(freshUser.id);
    } catch (err) {
      // Each job cleans up only its own tmpDir to avoid racing with a successor job.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw err;
    }
  })().finally(() => {
    // Only unregister if this is still the current job (not superseded by a newer one).
    if (inFlight.get(user.id)?.gen === myGen) {
      inFlight.delete(user.id);
      generationJobs.delete(user.id);
    }
  });

  inFlight.set(user.id, { promise: job, abort: () => ac.abort(), gen: myGen });
  return job;
}

export async function generateAll({ reason = 'bulk regeneration' } = {}) {
  const startedAt = Date.now();
  const users = Users.all();
  const bulkJobId = ++bulkJobSequence;
  const bulkJob = {
    reason,
    total: users.length,
    completed: 0,
    startedAt: new Date().toISOString(),
  };
  bulkGenerationJobs.set(bulkJobId, bulkJob);

  try {
    if (users.length > 1) {
      log.info('channel', 'rebuilding streams', { reason, users: users.length });
    }
    const results = [];
    for (const u of users) {
      try {
        await generateForUser(u, { reason });
        results.push({ id: u.id, ok: true });
      } catch (e) {
        results.push({ id: u.id, ok: false, error: e.message });
        log.error('channel', 'generation failed', {
          user_id: u.id,
          username: u.username,
          error: e.message,
        });
      } finally {
        bulkJob.completed += 1;
      }
    }
    if (users.length !== 1) {
      log.info('channel', 'stream rebuild complete', {
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        duration_ms: elapsedMs(startedAt),
      });
    }
    return results;
  } finally {
    bulkGenerationJobs.delete(bulkJobId);
  }
}

export function removeUserHls(userId) {
  fs.rmSync(userHlsDir(userId), { recursive: true, force: true });
}

// Apply the admin-saved notifications on/off flag onto the live config (env var
// is the fallback when unset). Called at startup and after the admin toggle.
export function syncNotifySettings() {
  const s = Settings.all();
  if (typeof s.notify_enabled === 'boolean') config.notify.enabled = s.notify_enabled;
}

// Ensure a user's stream exists; (re)generate if missing.
export async function ensureUserStream(user) {
  if (!fs.existsSync(playlistPath(user.id))) {
    log.warn('stream', 'playlist missing; starting lazy generation', {
      user_id: user.id,
      username: user.username,
    });
    await generateForUser(user, { reason: 'lazy stream request' });
  }
  return playlistPath(user.id);
}

// Regenerate everything daily at 00:05 so the day-counter and expiry status stay current.
export function startDailyRefresh() {
  const schedule = '5 0 * * *';
  cron.schedule(schedule, async () => {
    log.info('scheduler', 'daily refresh triggered', { schedule });
    // Pull fresh channel lists from any upstream provider that has come due.
    // Sources are normally re-downloaded by their own interval scheduler
    // (startSourceAutoRefresh); this nightly pass is the safety net that also
    // catches a source whose interval elapsed while the process was down.
    // Playlists are built per request, so this needs no stream rebuild.
    if (config.catalog.autoRefresh) {
      try {
        const results = await refreshDueSources();
        const failed = results.filter((r) => !r.ok).length;
        log.info('scheduler', 'playlist sources refreshed', { sources: results.length, failed });
      } catch (e) {
        log.error('catalog', 'daily source refresh failed', { error: e.message });
      }
    }
    await generateAll({ reason: 'daily refresh' });
    // After the rebuild, mail anyone who just entered the expiry window (once).
    try {
      const { sent } = await notify.expirySweep();
      if (sent) log.info('notify', 'expiry warnings sent', { count: sent });
    } catch (e) {
      log.error('notify', 'expiry sweep failed', { error: e.message });
    }
  }, { timezone: config.timezone });
  log.info('scheduler', 'daily refresh registered', {
    schedule,
    timezone: config.timezone,
  });
}
