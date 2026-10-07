// Turns the media channel's slides into the shared live loop served at
// /m/:token/ (see encode/media.js for the two-step clip -> loop design).
//
//   - Uploaded videos are re-encoded ONCE, in a one-at-a-time queue, straight
//     into their clip form; the original upload is deleted afterwards, so only
//     the 720p copy ever stays on disk.
//   - Text and image clips are rendered on demand and cached by a hash of
//     everything that affects them, so a rebuild after editing one slide
//     re-encodes that slide only.
//   - The loop rebuild is debounced (a burst of edits = one build) and a newer
//     build aborts a running one, like generateForUser in encode/channel.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from '../config.js';
import { elapsedMs, log } from '../core/logger.js';
import { FFMPEG, AbortedError, run } from '../encode/ffmpeg.js';
import { ensureMusic } from '../encode/channel.js';
import { currentLoopPosition, writeLoopState, LIVE_WINDOW_SEGMENTS } from '../encode/liveloop.js';
import {
  stillClipArgs, scrollClipArgs, videoClipArgs, videoThumbArgs, tileUp, textSlideSeconds,
  loopRepeats, concatList, loopArgs, probeMedia,
} from '../encode/media.js';
import {
  renderBackgroundPng, renderTextLayer, composeTextFrame, renderImageFrame, slideScale,
} from '../render/media.js';
import {
  MediaItems, MEDIA_DIRS, DEFAULTS, mediaLoopDir, itemFilePath, ensureMediaDirs, mediaUsage,
} from './store.js';

// Bump when the look of text/image slides changes, so cached clips re-render.
const CLIP_VERSION = 2;
// Bump when the loop step itself (loopArgs) changes, so existing loops rebuild.
const LOOP_VERSION = 2;
const SIG_FILE = 'sig';

// Everything every clip depends on. A video clip encoded under another key
// (resolution, segment length, …) is re-encoded from itself at the next build.
export function encodeKey() {
  const c = config.channel;
  const m = config.media;
  return JSON.stringify({
    v: CLIP_VERSION, W: c.width, H: c.height, seg: c.hlsTime,
    fps: m.fps, preset: m.preset, crf: m.crf, maxrate: m.maxrate,
  });
}

function hash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function musicMtime(music) {
  try { return fs.statSync(music).mtimeMs; } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Status (for the admin page)
// ---------------------------------------------------------------------------

let status = { state: 'idle', error: null, built_at: null, seconds: 0, slides: 0 };
let pendingTimer = null;

export function mediaStatus() {
  return { ...status, pending: !!pendingTimer, ready: mediaLoopReady() };
}

export function mediaLoopReady() {
  return fs.existsSync(path.join(mediaLoopDir(), 'index.m3u8'));
}

// ---------------------------------------------------------------------------
// Video uploads
// ---------------------------------------------------------------------------

const videoJobs = new Map(); // item id -> AbortController
let videoQueue = Promise.resolve();

// Queue an uploaded video (already saved as a `processing` item) for its
// one-time encode. `raw` is the upload in incoming/, deleted afterwards.
export function queueVideo(itemId, raw) {
  const ac = new AbortController();
  videoJobs.set(itemId, ac);
  videoQueue = videoQueue
    .then(() => processVideo(itemId, raw, ac.signal))
    .catch(() => {})
    .finally(() => videoJobs.delete(itemId));
  return videoQueue;
}

// Stop a video's encode (its slide was deleted mid-way).
export function cancelVideo(itemId) {
  videoJobs.get(itemId)?.abort();
}

async function processVideo(itemId, raw, signal) {
  const startedAt = Date.now();
  const out = path.join(MEDIA_DIRS.files, `${itemId}.mp4`);
  const tmp = path.join(MEDIA_DIRS.files, `${itemId}.tmp.mp4`);
  const thumb = path.join(MEDIA_DIRS.thumbs, `${itemId}.jpg`);
  try {
    if (signal.aborted || !MediaItems.get(itemId)) throw new AbortedError();
    const info = await probeMedia(raw);
    if (!info.hasVideo || !(info.duration > 0)) throw new Error('в файле нет видеодорожки');
    const music = await ensureMusic();
    await run(FFMPEG, videoClipArgs({
      input: raw, duration: info.duration, hasAudio: info.hasAudio, music, out: tmp,
    }), `media video encode ${itemId}`, signal);
    fs.renameSync(tmp, out);
    await run(FFMPEG, videoThumbArgs({ input: out, duration: info.duration, out: thumb }), `media thumb ${itemId}`)
      .catch(() => {}); // a missing thumbnail is cosmetic
    const saved = MediaItems.update(itemId, {
      status: 'ready',
      error: null,
      file: path.basename(out),
      thumb: fs.existsSync(thumb) ? path.basename(thumb) : null,
      duration: Math.round(info.duration * 10) / 10,
      seconds: tileUp(info.duration),
      size: fs.statSync(out).size,
      enc: encodeKey(),
    });
    if (!saved) throw new AbortedError(); // deleted while encoding
    log.info('media', 'video ready', {
      item_id: itemId, duration_s: info.duration, duration_ms: elapsedMs(startedAt),
    });
    scheduleMediaBuild('video processed');
  } catch (e) {
    for (const file of [tmp, ...(MediaItems.get(itemId) ? [] : [out, thumb])]) fs.rmSync(file, { force: true });
    if (!e.aborted) {
      log.error('media', 'video processing failed', { item_id: itemId, error: e.message });
      MediaItems.update(itemId, { status: 'error', error: String(e.message).slice(0, 200) });
    }
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

// Re-encode a ready video whose clip was made under different encode settings
// (the admin changed the resolution or segment length). Lossy, but the
// original is gone by design, and it only happens on a settings change.
async function reencodeVideo(item, music, signal) {
  const file = itemFilePath(item);
  const tmp = path.join(MEDIA_DIRS.files, `${item.id}.tmp.mp4`);
  const info = await probeMedia(file);
  try {
    await run(FFMPEG, videoClipArgs({
      input: file, duration: item.duration || info.duration, hasAudio: info.hasAudio, music, out: tmp,
    }), `media video re-encode ${item.id}`, signal);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return MediaItems.update(item.id, {
    enc: encodeKey(), seconds: tileUp(item.duration || info.duration), size: fs.statSync(file).size,
  });
}

// ---------------------------------------------------------------------------
// Uploaded images: stored downscaled, so a 40-megapixel phone photo doesn't
// cost 15 MB of the disk budget for a 720p slide.
// ---------------------------------------------------------------------------

export async function storeImage(itemId, raw) {
  const image = sharp(raw, { failOn: 'error' }).rotate();
  const meta = await image.metadata();
  // PNG only when there really is transparency: screenshots and canvas exports
  // carry an alpha channel that is fully opaque, and a JPEG is far smaller.
  const transparent = meta.hasAlpha && !(await sharp(raw).stats()).isOpaque;
  const ext = transparent ? 'png' : 'jpg';
  const out = path.join(MEDIA_DIRS.files, `${itemId}.${ext}`);
  const resized = image.resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true });
  await (ext === 'png' ? resized.png() : resized.jpeg({ quality: 88 })).toFile(out);
  return { file: path.basename(out), size: fs.statSync(out).size };
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

function clipPaths(key) {
  return {
    clip: path.join(MEDIA_DIRS.clips, `${key}.mp4`),
    meta: path.join(MEDIA_DIRS.clips, `${key}.json`),
  };
}

function cachedClip(key) {
  const { clip, meta } = clipPaths(key);
  try {
    if (!fs.existsSync(clip)) return null;
    return { file: clip, seconds: JSON.parse(fs.readFileSync(meta, 'utf8')).seconds };
  } catch {
    return null;
  }
}

// Render + encode one cached clip via `make(workDir, out) -> seconds`.
async function buildClip(key, make) {
  const hit = cachedClip(key);
  if (hit) return hit;
  const { clip, meta } = clipPaths(key);
  const work = fs.mkdtempSync(path.join(MEDIA_DIRS.clips, '.work-'));
  try {
    const out = path.join(work, 'clip.mp4');
    const seconds = await make(work, out);
    fs.renameSync(out, clip);
    fs.writeFileSync(meta, JSON.stringify({ seconds }));
    return { file: clip, seconds };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function textClip(item, music, signal) {
  const seconds = item.seconds || DEFAULTS.seconds;
  const speed = item.scroll_speed || DEFAULTS.scrollSpeed;
  const key = hash({
    k: 'text', md: item.markdown, seconds, speed, enc: encodeKey(), music: musicMtime(music),
  });
  return buildClip(key, async (work, out) => {
    const layer = await renderTextLayer(item.markdown, path.join(work, 'text.png'));
    const total = textSlideSeconds({
      seconds, layerHeight: layer.height, screenHeight: config.channel.height, scale: slideScale(), speed,
    });
    if (layer.scrolls) {
      const background = await renderBackgroundPng(path.join(work, 'bg.png'));
      const edges = await renderBackgroundPng(path.join(work, 'edges.png'), { edges: true });
      await run(FFMPEG, scrollClipArgs({
        background, layer: layer.file, edges, seconds: total, speed, scale: slideScale(), music, out,
      }), `media text clip ${item.id}`, signal);
    } else {
      const frame = await composeTextFrame(layer.file, path.join(work, 'frame.png'));
      await run(FFMPEG, stillClipArgs({ frame, seconds: total, music, out }), `media text clip ${item.id}`, signal);
    }
    return total;
  });
}

function imageClip(item, music, signal) {
  const seconds = tileUp(item.seconds || DEFAULTS.seconds);
  const key = hash({
    k: 'image', file: item.file, caption: item.caption || '', seconds, enc: encodeKey(), music: musicMtime(music),
  });
  return buildClip(key, async (work, out) => {
    const frame = await renderImageFrame(itemFilePath(item), item.caption || '', path.join(work, 'frame.png'));
    await run(FFMPEG, stillClipArgs({ frame, seconds, music, out }), `media image clip ${item.id}`, signal);
    return seconds;
  });
}

async function videoClip(item, music, signal) {
  if (item.status !== 'ready' || !fs.existsSync(itemFilePath(item))) return null;
  const current = item.enc === encodeKey() ? item : await reencodeVideo(item, music, signal);
  return current ? { file: itemFilePath(current), seconds: current.seconds } : null;
}

async function clipFor(item, music, signal) {
  if (item.type === 'text') return textClip(item, music, signal);
  if (item.type === 'image') return imageClip(item, music, signal);
  if (item.type === 'video') return videoClip(item, music, signal);
  return null;
}

// Drop cached clips no current slide uses. (Half-built work dirs belong to
// the running build; leftovers from a crash go in sweepOrphans at startup.)
function sweepClips(keep) {
  let entries = [];
  try { entries = fs.readdirSync(MEDIA_DIRS.clips); } catch { return; }
  for (const name of entries) {
    if (name.startsWith('.work-') || keep.has(name.replace(/\.(mp4|json)$/, ''))) continue;
    fs.rmSync(path.join(MEDIA_DIRS.clips, name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function readSig(dir) {
  try { return fs.readFileSync(path.join(dir, SIG_FILE), 'utf8').trim(); } catch { return null; }
}

let current = null; // { ac, promise }

// Rebuild after a short pause, so a burst of edits costs one build.
export function scheduleMediaBuild(reason = 'content changed', delayMs = 1500) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    buildMediaLoop({ reason }).catch(() => {});
  }, delayMs);
  pendingTimer.unref?.();
}

export function buildMediaLoop({ reason = 'unspecified', force = false } = {}) {
  const previous = current;
  previous?.ac.abort();
  const ac = new AbortController();
  const job = {};
  job.ac = ac;
  job.promise = (async () => {
    await previous?.promise.catch(() => {});
    return doBuild({ reason, force, signal: ac.signal });
  })().finally(() => {
    if (current === job) current = null;
  });
  current = job;
  return job.promise;
}

async function doBuild({ reason, force, signal }) {
  const startedAt = Date.now();
  ensureMediaDirs();
  const finalDir = mediaLoopDir();
  status = { ...status, state: 'building', error: null, started_at: new Date().toISOString() };
  try {
    const music = await ensureMusic();
    const clips = [];
    for (const item of MediaItems.all()) {
      if (signal.aborted) throw new AbortedError();
      try {
        const clip = await clipFor(item, music, signal);
        if (clip) clips.push(clip);
        if (item.type !== 'video' && item.error) MediaItems.update(item.id, { error: null });
      } catch (e) {
        if (e.aborted || signal.aborted) throw new AbortedError();
        log.error('media', 'slide could not be rendered', { item_id: item.id, type: item.type, error: e.message });
        if (item.type !== 'video') MediaItems.update(item.id, { error: String(e.message).slice(0, 200) });
      }
    }
    sweepClips(new Set(clips.map((c) => path.basename(c.file, '.mp4'))));

    if (!clips.length) {
      fs.rmSync(finalDir, { recursive: true, force: true });
      status = { state: 'empty', error: null, built_at: new Date().toISOString(), seconds: 0, slides: 0 };
      return null;
    }

    const seconds = clips.reduce((sum, c) => sum + c.seconds, 0);
    const repeats = loopRepeats(seconds);
    const files = Array.from({ length: repeats }, () => clips.map((c) => c.file)).flat();
    const signature = hash({
      v: LOOP_VERSION, files, seg: config.channel.hlsTime, live: config.channel.liveLoop,
    });
    if (!force && mediaLoopReady() && readSig(finalDir) === signature) {
      status = { state: 'idle', error: null, built_at: status.built_at || new Date().toISOString(), seconds, slides: clips.length };
      return finalDir;
    }

    log.info('media', 'building media loop', { reason, slides: clips.length, seconds, repeats });
    const previousPosition = config.channel.liveLoop ? currentLoopPosition(finalDir) : null;
    fs.mkdirSync(config.hlsDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(config.hlsDir, '.build-media-'));
    try {
      const list = path.join(tmpDir, 'list.txt');
      fs.writeFileSync(list, concatList(files));
      await run(FFMPEG, loopArgs({ list, outDir: tmpDir }), 'media loop', signal);
      fs.rmSync(list, { force: true });
      if (config.channel.liveLoop) {
        // Never move the live counters backwards (see encode/channel.js).
        writeLoopState(tmpDir, {
          baseSeq: previousPosition ? previousPosition.mediaSequence + LIVE_WINDOW_SEGMENTS : 0,
          baseDiscontinuity: previousPosition ? previousPosition.discontinuitySequence + 1 : 0,
        });
      }
      fs.writeFileSync(path.join(tmpDir, SIG_FILE), signature);
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, finalDir);
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw e;
    }
    status = { state: 'idle', error: null, built_at: new Date().toISOString(), seconds, slides: clips.length };
    log.info('media', 'media loop ready', {
      slides: clips.length, seconds: seconds * repeats, duration_ms: elapsedMs(startedAt), disk_bytes: mediaUsage().used,
    });
    return finalDir;
  } catch (e) {
    if (e.aborted || signal.aborted) {
      status = { ...status, state: 'idle' };
      throw new AbortedError();
    }
    log.error('media', 'media loop build failed', { error: e.message });
    status = { ...status, state: 'error', error: String(e.message).slice(0, 300) };
    throw e;
  }
}
