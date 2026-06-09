// Generates a per-user looping HLS stream (static info card + background music)
// using ffmpeg, and keeps it refreshed daily so "days left" stays accurate.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import cron from 'node-cron';
import { config } from './config.js';
import { Users, Plans, Settings } from './db.js';
import { renderBodyPng, renderSlidesPng } from './overlay.js';
import { elapsedMs, log } from './logger.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Common HLS output args (VOD loop). Players restart from segment 0 on each
// tune-in, so the brand intro plays on every "channel open".
function hlsOutArgs(tmpDir) {
  return [
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(tmpDir, 'seg_%03d.ts'),
    path.join(tmpDir, 'index.m3u8'),
  ];
}

// ffmpeg args for an animated channel: brand slide -> (xfade transition) ->
// info card held for the rest of the loop, with background music.
function introFfmpegArgs(slides, music, tmpDir) {
  const dur = config.channel.duration;
  const { width: W, height: H } = config.channel;
  const XF = 0.8;                 // transition length (s)
  const S = Math.max(XF + 0.5, config.intro.slideSeconds); // brand slide on-screen
  const L2 = Math.max(6, dur - S + XF);                    // card hold length
  const o1 = (S - XF).toFixed(2);                          // transition offset
  const fos = (L2 - 0.6).toFixed(2);                       // card fade-out start
  const aOut = Math.max(0, dur - 2).toFixed(2);

  const filter =
    `[0:v]scale=${W}:${H},setsar=1,fps=25,format=yuv420p,fade=t=in:st=0:d=0.6[v0];` +
    `[1:v]scale=${W}:${H},setsar=1,fps=25,format=yuv420p,fade=t=out:st=${fos}:d=0.6[v1];` +
    `[v0][v1]xfade=transition=${config.intro.transition}:duration=${XF}:offset=${o1}[v]`;

  return [
    '-y',
    '-loop', '1', '-t', String(S), '-i', slides.slide1,
    '-loop', '1', '-t', L2.toFixed(2), '-i', slides.card,
    '-stream_loop', '-1', '-i', music,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '2:a',
    '-af', `afade=t=in:d=1,afade=t=out:st=${aOut}:d=2`,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p', '-r', '25', '-g', '50',
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
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p', '-r', '25', '-g', '50',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
    ...hlsOutArgs(tmpDir),
  ];
}

function run(cmd, args, label = cmd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (error) => {
      log.error('process', `${label} could not start`, { error: error.message });
      reject(error);
    });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else {
        log.error('process', `${label} failed`, {
          pid: p.pid,
          code,
          output: err.slice(-800),
        });
        reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
      }
    });
  });
}

// Synthesize a soft ambient placeholder track if the user hasn't supplied music.
let musicReady = null;
export async function ensureMusic() {
  if (musicReady) return musicReady;
  musicReady = (async () => {
    if (fs.existsSync(config.musicFile) && fs.statSync(config.musicFile).size > 0) {
      return config.musicFile;
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

export function playlistPath(userId) {
  return path.join(userHlsDir(userId), 'index.m3u8');
}

// One ffmpeg run per user at a time.
const inFlight = new Map();
const generationJobs = new Map();
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

export function generateForUser(userOrId, { reason = 'unspecified' } = {}) {
  const user = typeof userOrId === 'object' ? userOrId : Users.get(userOrId);
  if (!user) throw new Error('user not found');
  if (inFlight.has(user.id)) return inFlight.get(user.id);

  generationJobs.set(user.id, {
    userId: user.id,
    username: user.username,
    reason,
    startedAt: new Date().toISOString(),
  });

  const job = (async () => {
    const startedAt = Date.now();
    const settings = Settings.all();
    const plans = Plans.all();
    const music = await ensureMusic();
    log.info('channel', 'generating stream', {
      user_id: user.id,
      username: user.username,
      reason,
    });

    const finalDir = userHlsDir(user.id);
    fs.mkdirSync(config.hlsDir, { recursive: true });
    // Build in a temp dir on the SAME filesystem as the target so rename() works.
    // A cross-device rename throws EXDEV when data/ is a separate mount or Docker volume.
    const tmpDir = fs.mkdtempSync(path.join(config.hlsDir, `.build-${user.id}-`));

    if (config.intro.enabled) {
      const slides = await renderSlidesPng(user, settings, tmpDir, plans);
      await run(
        FFMPEG,
        introFfmpegArgs(slides, music, tmpDir),
        `HLS encode for user ${user.id}`,
      );
    } else {
      const cardPng = path.join(tmpDir, 'card.png');
      await renderBodyPng(user, settings, cardPng, plans);
      await run(
        FFMPEG,
        stillFfmpegArgs(cardPng, music, tmpDir),
        `HLS encode for user ${user.id}`,
      );
    }

    // Atomic-ish swap: replace the live dir with the freshly generated one.
    const segmentCount = fs.readdirSync(tmpDir).filter((file) => file.endsWith('.ts')).length;
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
    log.info('channel', 'stream ready', {
      user_id: user.id,
      segments: segmentCount,
      duration_ms: elapsedMs(startedAt),
    });
    return playlistPath(user.id);
  })().finally(() => {
    inFlight.delete(user.id);
    generationJobs.delete(user.id);
    // Clean up any leftover build dirs for this user (e.g. after a failure).
    try {
      for (const d of fs.readdirSync(config.hlsDir)) {
        if (d.startsWith(`.build-${user.id}-`)) {
          fs.rmSync(path.join(config.hlsDir, d), { recursive: true, force: true });
        }
      }
    } catch { /* ignore */ }
  });

  inFlight.set(user.id, job);
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
