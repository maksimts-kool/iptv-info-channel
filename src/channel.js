// Generates a per-user looping HLS stream (static info card + background music)
// using ffmpeg, and keeps it refreshed daily so "days left" stays accurate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import cron from 'node-cron';
import { config } from './config.js';
import { Users, Plans, Settings } from './db.js';
import {
  renderBodyPng, renderSlidesPng, buildBrandSlide1Svg, buildBodySvg,
} from './overlay.js';
import {
  currentLoopPosition, LIVE_WINDOW_SEGMENTS, writeLoopState,
} from './liveloop.js';
import { elapsedMs, log } from './logger.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Common HLS output args (VOD loop). Players restart from segment 0 on each
// tune-in, so the brand intro plays on every "channel open".
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

// ffmpeg args for an animated channel: brand slide -> (xfade transition) ->
// info card held for the rest of the loop, with background music.
function introFfmpegArgs(slides, music, tmpDir) {
  const dur = config.channel.duration;
  const { width: W, height: H, fps } = config.channel;
  const XF = 0.8;                 // transition length (s)
  const S = Math.max(XF + 0.5, config.intro.slideSeconds); // brand slide on-screen
  const L2 = Math.max(6, dur - S + XF);                    // card hold length
  const o1 = (S - XF).toFixed(2);                          // transition offset
  const fos = (L2 - 0.6).toFixed(2);                       // card fade-out start
  const aOut = Math.max(0, dur - 2).toFixed(2);

  const filter =
    `[0:v]scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p,fade=t=in:st=0:d=0.6[v0];` +
    `[1:v]scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p,fade=t=out:st=${fos}:d=0.6[v1];` +
    `[v0][v1]xfade=transition=${config.intro.transition}:duration=${XF}:offset=${o1}[v]`;

  return [
    '-y',
    '-loop', '1', '-t', String(S), '-i', slides.slide1,
    '-loop', '1', '-t', L2.toFixed(2), '-i', slides.card,
    '-stream_loop', '-1', '-i', music,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '2:a',
    '-af', `afade=t=in:d=1,afade=t=out:st=${aOut}:d=2`,
    ...videoEncodeArgs(fps),
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
    '-shortest',
    ...hlsOutArgs(tmpDir),
  ];
}

// ffmpeg args for a plain still-card loop (intro disabled).
function stillFfmpegArgs(cardPng, music, tmpDir) {
  return [
    '-y',
    '-loop', '1', '-i', cardPng,
    '-stream_loop', '-1', '-i', music,
    '-t', String(config.channel.duration),
    '-map', '0:v', '-map', '1:a',
    ...videoEncodeArgs(config.channel.stillFps),
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
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
function streamSignature(user, settings, plans, music) {
  let musicMtime = 0;
  try { musicMtime = fs.statSync(music).mtimeMs; } catch { /* fall back to 0 */ }
  const c = config.channel;
  const svgs = config.intro.enabled
    ? [buildBrandSlide1Svg(settings), buildBodySvg(user, plans, settings)]
    : [buildBodySvg(user, plans, settings)];
  const payload = JSON.stringify({
    v: 1,
    svgs,
    enc: {
      W: c.width, H: c.height, fps: c.fps, stillFps: c.stillFps,
      preset: c.preset, duration: c.duration, hlsTime: c.hlsTime, liveLoop: c.liveLoop,
      intro: config.intro.enabled
        ? { slide: config.intro.slideSeconds, transition: config.intro.transition }
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
    const plans = Plans.all();
    const music = await ensureMusic();

    const finalDir = userHlsDir(freshUser.id);
    const signature = streamSignature(freshUser, settings, plans, music);
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
        const slides = await renderSlidesPng(freshUser, settings, tmpDir, plans);
        await run(
          FFMPEG,
          introFfmpegArgs(slides, music, tmpDir),
          `HLS encode for user ${freshUser.id}`,
          signal,
        );
      } else {
        const cardPng = path.join(tmpDir, 'card.png');
        await renderBodyPng(freshUser, settings, cardPng, plans);
        await run(
          FFMPEG,
          stillFfmpegArgs(cardPng, music, tmpDir),
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
    await generateAll({ reason: 'daily refresh' });
  }, { timezone: config.timezone });
  log.info('scheduler', 'daily refresh registered', {
    schedule,
    timezone: config.timezone,
  });
}
