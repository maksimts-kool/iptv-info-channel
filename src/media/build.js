// Turns the media channel's articles into the shared live loop served at
// /m/:token/ (see encode/media.js for the two-step clip -> loop design).
//
//   - Uploaded videos are re-encoded ONCE, in a one-at-a-time queue, into the
//     720p copy that is kept; the original upload is deleted afterwards.
//   - Each article is rendered + encoded into one clip, cached by a hash of
//     everything that affects it (its document, its assets, its place in the
//     «1/3» order), so a rebuild after editing one article re-encodes only it.
//   - The loop rebuild is debounced (a burst of edits = one build) and a newer
//     build aborts a running one, like generateForUser in encode/channel.js.
//   - Private content (an article or a section of one for an audience) splits
//     the customers into VARIANTS (media/variants.js): one loop per distinct
//     "what this customer sees", the public one at hls/_media as before. Clips
//     are cached per resolved document, so an article everyone sees the same
//     is still encoded once.
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
  articleTimeline, articleClipArgs, videoNormalizeArgs, videoPosterArgs,
  loopRepeats, concatList, loopArgs, probeMedia,
} from '../encode/media.js';
import {
  renderBackgroundPng, renderArticleLayer, renderIndicatorPng, slideScale,
} from '../render/media.js';
import { Users } from '../data/store.js';
import { docAssetIds } from './doc.js';
import {
  articlesFor, variantKey, mediaVariants, hasPrivateContent,
} from './variants.js';
import {
  Articles, Assets, MEDIA_DIRS, DEFAULTS, mediaLoopDir, mediaVariantDir, mediaVariantDirs,
  assetFilePath, assetThumbPath, ensureMediaDirs, mediaUsage, sweepUnusedAssets, sweepAbandonedArticles,
} from './store.js';

// Bump when the look of an article changes, so cached clips re-render.
const CLIP_VERSION = 3;
// Bump when the loop step itself (loopArgs) changes, so existing loops rebuild.
const LOOP_VERSION = 2;
const SIG_FILE = 'sig';
// An upload nobody saved into an article — or a new article left empty and
// untitled — is kept this long (its editor may still be open), then swept.
const UNSAVED_ASSET_TTL_MS = 6 * 60 * 60 * 1000;

// Everything every clip depends on. A video copy made under another key
// (resolution, frame rate, …) is re-encoded from itself at the next build.
export function encodeKey() {
  const c = config.channel;
  const m = config.media;
  return JSON.stringify({
    W: c.width, H: c.height, seg: c.hlsTime, fps: m.fps, preset: m.preset, crf: m.crf, maxrate: m.maxrate,
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

let status = {
  state: 'idle', error: null, built_at: null, seconds: 0, articles: 0, variants: 0, private_viewers: 0,
};
let pendingTimer = null;

export function mediaStatus() {
  // On air when any loop exists — with only private articles there is no
  // public loop, but their audiences are watching theirs.
  const ready = mediaLoopReady() || mediaVariantDirs().some(loopReady);
  return { ...status, pending: !!pendingTimer, ready };
}

function loopReady(dir) {
  return fs.existsSync(path.join(dir, 'index.m3u8'));
}

// The PUBLIC loop — what a customer in no audience sees.
export function mediaLoopReady() {
  return loopReady(mediaLoopDir());
}

// Where the loop of a (non-public) variant lives, by its key.
export function mediaVariantLoopDir(key) {
  return mediaVariantDir(hash(key));
}
const variantDirFor = mediaVariantLoopDir;

// The loop this customer's player is served, or null when they have nothing
// to watch (no loop yet, or every article is private to someone else). A
// customer whose own variant is not built yet gets the public loop meanwhile:
// it is a subset of what they may see, so it never shows them too much.
export function mediaLoopDirFor(user) {
  const articles = Articles.all();
  const publicDir = mediaLoopDir();
  const fallback = loopReady(publicDir) ? publicDir : null;
  if (!hasPrivateContent(articles)) return fallback;
  const mine = variantKey(articlesFor(articles, user));
  if (mine !== variantKey(articlesFor(articles, null))) {
    const dir = variantDirFor(mine);
    if (loopReady(dir)) return dir;
  }
  return fallback;
}

// Customers moving between audiences (created, deleted, a plan change) can
// change what they see — but only when something is private at all.
export function scheduleMediaBuildForClients(reason = 'clients changed') {
  if (hasPrivateContent(Articles.all())) scheduleMediaBuild(reason);
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

// Images are stored downscaled, so a 40-megapixel phone photo doesn't cost
// 15 MB of the disk budget for a 720p page. Returns the asset fields.
export async function storeImage(assetId, raw) {
  const image = sharp(raw, { failOn: 'error' }).rotate();
  const meta = await image.metadata();
  // PNG only when there really is transparency: screenshots and canvas exports
  // carry an alpha channel that is fully opaque, and a JPEG is far smaller.
  const transparent = meta.hasAlpha && !(await sharp(raw).stats()).isOpaque;
  const ext = transparent ? 'png' : 'jpg';
  const out = path.join(MEDIA_DIRS.files, `${assetId}.${ext}`);
  const resized = image.resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true });
  const info = await (ext === 'png' ? resized.png() : resized.jpeg({ quality: 88 })).toFile(out);
  return {
    file: path.basename(out), size: info.size, width: info.width, height: info.height,
  };
}

const videoJobs = new Map(); // asset id -> AbortController
let videoQueue = Promise.resolve();

// Queue an uploaded video (already saved as a `processing` asset) for its
// one-time encode. `raw` is the upload in incoming/, deleted afterwards.
export function queueVideo(assetId, raw, info) {
  const ac = new AbortController();
  videoJobs.set(assetId, ac);
  videoQueue = videoQueue
    .then(() => processVideo(assetId, raw, info, ac.signal))
    .catch(() => {})
    .finally(() => videoJobs.delete(assetId));
  return videoQueue;
}

// Stop a video's encode (its article was deleted mid-way).
export function cancelVideo(assetId) {
  videoJobs.get(assetId)?.abort();
}

async function encodeVideoCopy(assetId, input, hasAudio, signal) {
  const out = path.join(MEDIA_DIRS.files, `${assetId}.mp4`);
  const tmp = path.join(MEDIA_DIRS.files, `${assetId}.tmp.mp4`);
  const poster = path.join(MEDIA_DIRS.thumbs, `${assetId}.jpg`);
  try {
    await run(FFMPEG, videoNormalizeArgs({ input, hasAudio, out: tmp }), `media video encode ${assetId}`, signal);
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  await run(FFMPEG, videoPosterArgs({ input: out, out: poster }), `media poster ${assetId}`);
  const info = await probeMedia(out);
  return {
    file: path.basename(out),
    thumb: path.basename(poster),
    width: info.width,
    height: info.height,
    duration: Math.round(info.duration * 1000) / 1000,
    has_audio: info.hasAudio,
    size: fs.statSync(out).size,
    enc: encodeKey(),
  };
}

async function processVideo(assetId, raw, info, signal) {
  const startedAt = Date.now();
  try {
    if (signal.aborted || !Assets.get(assetId)) throw new AbortedError();
    const fields = await encodeVideoCopy(assetId, raw, info.hasAudio, signal);
    const saved = Assets.update(assetId, { ...fields, status: 'ready', error: null });
    if (!saved) throw new AbortedError(); // deleted while encoding
    log.info('media', 'video ready', {
      asset_id: assetId, duration_s: fields.duration, bytes: fields.size, duration_ms: elapsedMs(startedAt),
    });
    scheduleMediaBuild('video processed');
  } catch (e) {
    if (!Assets.get(assetId)) {
      for (const f of [`${assetId}.mp4`, `${assetId}.tmp.mp4`]) fs.rmSync(path.join(MEDIA_DIRS.files, f), { force: true });
      fs.rmSync(path.join(MEDIA_DIRS.thumbs, `${assetId}.jpg`), { force: true });
    } else if (!e.aborted) {
      log.error('media', 'video processing failed', { asset_id: assetId, error: e.message });
      Assets.update(assetId, { status: 'error', error: String(e.message).slice(0, 200) });
    }
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

// A ready video whose copy was made under other encode settings (the admin
// changed the resolution): re-encoded from that copy. Lossy, but the original
// is gone by design, and it only happens on a settings change.
async function refreshVideoCopy(asset, signal) {
  const input = path.join(MEDIA_DIRS.files, `${asset.id}.src.mp4`);
  fs.renameSync(assetFilePath(asset), input);
  try {
    const fields = await encodeVideoCopy(asset.id, input, asset.has_audio, signal);
    return Assets.update(asset.id, fields);
  } catch (e) {
    fs.renameSync(input, assetFilePath(asset));
    throw e;
  } finally {
    fs.rmSync(input, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Article clips
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

// The article's ready assets, as the renderer wants them. A video still being
// processed (or broken) is left out of the page until it is ready.
export function articleMedia(article) {
  return docAssetIds(article.doc)
    .map((id) => Assets.get(id))
    .filter((a) => a && a.status !== 'processing' && a.status !== 'error' && fs.existsSync(assetFilePath(a)))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      width: a.width,
      height: a.height,
      duration: a.duration,
      has_audio: !!a.has_audio,
      file: assetFilePath(a),
      picture: a.kind === 'video' ? assetThumbPath(a) : assetFilePath(a),
      stamp: [a.file, a.size, a.enc || ''],
    }));
}

// Lay an article out: the page layer, its timeline, and where its videos go.
// Shared by the encoder and the admin preview so both tell the same story.
export async function layoutArticle(article, media, layerFile) {
  const layer = await renderArticleLayer(article.doc, media, layerFile);
  if (!layer) return null;
  const byId = new Map(media.map((m) => [m.id, m]));
  const videos = layer.videos.map((v) => {
    const m = byId.get(v.assetId);
    return {
      file: m.file, x: v.x, y: v.y, width: v.width, height: v.height, focus: v.focus,
      duration: m.duration, hasAudio: m.has_audio,
    };
  });
  const timeline = articleTimeline({
    layerHeight: layer.height,
    screenHeight: config.channel.height,
    videos,
    speed: (article.scroll_speed || DEFAULTS.scrollSpeed) * slideScale(),
    minSeconds: article.seconds || DEFAULTS.seconds,
  });
  return {
    layer,
    timeline,
    videos: videos.map((v, k) => ({ ...v, start: timeline.starts[k] })),
  };
}

async function articleClip(article, place, music, signal) {
  // Videos made under other encode settings are brought up to date first.
  for (const asset of docAssetIds(article.doc).map((id) => Assets.get(id))) {
    if (asset?.kind === 'video' && asset.status === 'ready' && asset.enc !== encodeKey()) {
      await refreshVideoCopy(asset, signal);
    }
  }
  const media = articleMedia(article);
  const key = hash({
    v: CLIP_VERSION,
    doc: article.doc,
    title: article.title || '',
    place,
    seconds: article.seconds || DEFAULTS.seconds,
    speed: article.scroll_speed || DEFAULTS.scrollSpeed,
    media: media.map((m) => [m.id, ...m.stamp]),
    enc: encodeKey(),
    music: musicMtime(music),
  });
  const hit = cachedClip(key);
  if (hit) return hit;

  const { clip, meta } = clipPaths(key);
  const work = fs.mkdtempSync(path.join(MEDIA_DIRS.clips, '.work-'));
  try {
    const laid = await layoutArticle(article, media, path.join(work, 'page.png'));
    if (!laid) return null;
    const [background, edges] = await Promise.all([
      renderBackgroundPng(path.join(work, 'bg.png')),
      renderBackgroundPng(path.join(work, 'edges.png'), { edges: true }),
    ]);
    const indicator = await renderIndicatorPng({ ...place, title: article.title }, path.join(work, 'chip.png'));
    const out = path.join(work, 'clip.mp4');
    await run(FFMPEG, articleClipArgs({
      background,
      layer: laid.layer.file,
      edges,
      indicator,
      videos: laid.videos,
      phases: laid.timeline.phases,
      seconds: laid.timeline.total,
      music,
      out,
    }), `media article ${article.id}`, signal);
    fs.renameSync(out, clip);
    fs.writeFileSync(meta, JSON.stringify({ seconds: laid.timeline.total }));
    return { file: clip, seconds: laid.timeline.total };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Drop cached clips no current article uses. (Half-built work dirs belong to
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
  const job = { ac };
  job.promise = (async () => {
    await previous?.promise.catch(() => {});
    return doBuild({ reason, force, signal: ac.signal });
  })().finally(() => {
    if (current === job) current = null;
  });
  current = job;
  return job.promise;
}

// The clips of one variant, in play order («1/3» counts this variant's articles).
async function variantClips(entries, music, signal) {
  const clips = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (signal.aborted) throw new AbortedError();
    const { article } = entries[i];
    try {
      const clip = await articleClip(article, { index: i + 1, total: entries.length }, music, signal);
      if (clip) clips.push(clip);
      if (article.error) Articles.update(article.id, { error: null });
    } catch (e) {
      if (e.aborted || signal.aborted) throw new AbortedError();
      log.error('media', 'article could not be rendered', { article_id: article.id, error: e.message });
      Articles.update(article.id, { error: String(e.message).slice(0, 200) });
    }
  }
  return clips;
}

// The furthest live position of ANY media loop on disk. A customer can move
// between loops — public while theirs is built, an old variant to a new one
// after an edit — so a new loop continues from the furthest of them all:
// whichever loop a player was on, its counters never move backwards.
function furthestMediaPosition() {
  let best = null;
  for (const dir of [mediaLoopDir(), ...mediaVariantDirs()]) {
    const pos = currentLoopPosition(dir);
    if (!pos) continue;
    best = {
      mediaSequence: Math.max(best?.mediaSequence ?? 0, pos.mediaSequence),
      discontinuitySequence: Math.max(best?.discontinuitySequence ?? 0, pos.discontinuitySequence),
    };
  }
  return best;
}

// Join one variant's clips into its live loop in `finalDir` (a no-op when the
// loop there already has exactly these clips).
async function buildLoop(finalDir, clips, {
  reason, force, signal, label,
}) {
  const seconds = clips.reduce((sum, c) => sum + c.seconds, 0);
  const repeats = loopRepeats(seconds);
  const files = Array.from({ length: repeats }, () => clips.map((c) => c.file)).flat();
  const signature = hash({
    v: LOOP_VERSION, files, seg: config.channel.hlsTime, live: config.channel.liveLoop,
  });
  if (!force && loopReady(finalDir) && readSig(finalDir) === signature) return { seconds, built: false };

  log.info('media', 'building media loop', {
    reason, variant: label, articles: clips.length, seconds, repeats,
  });
  const previousPosition = config.channel.liveLoop ? furthestMediaPosition() : null;
  fs.mkdirSync(config.hlsDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(config.hlsDir, '.build-media-'));
  try {
    const list = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(list, concatList(files));
    await run(FFMPEG, loopArgs({ list, outDir: tmpDir }), `media loop ${label}`, signal);
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
  return { seconds, built: true };
}

async function doBuild({ reason, force, signal }) {
  const startedAt = Date.now();
  ensureMediaDirs();
  sweepAbandonedArticles({ minAgeMs: UNSAVED_ASSET_TTL_MS });
  sweepUnusedAssets({ minAgeMs: UNSAVED_ASSET_TTL_MS });
  const publicDir = mediaLoopDir();
  status = { ...status, state: 'building', error: null, started_at: new Date().toISOString() };
  try {
    const music = await ensureMusic();
    // Only articles with something in them take part — and count in «1/3».
    // The public variant comes first: it is every other customer's stand-in.
    const { variants } = mediaVariants(Articles.all(), Users.all());
    const keepClips = new Set();
    const keepDirs = new Set();
    let publicSummary = { seconds: 0, articles: 0 };
    let privateLoops = 0;
    let privateViewers = 0;
    let rebuilt = 0;

    for (const [key, variant] of variants) {
      if (signal.aborted) throw new AbortedError();
      const dir = variant.public ? publicDir : variantDirFor(key);
      const clips = await variantClips(variant.entries, music, signal);
      clips.forEach((c) => keepClips.add(path.basename(c.file, '.mp4')));
      if (!clips.length) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      keepDirs.add(dir);
      const { seconds, built } = await buildLoop(dir, clips, {
        reason,
        force,
        signal,
        label: variant.public ? 'public' : path.basename(dir),
      });
      if (built) rebuilt += 1;
      if (variant.public) publicSummary = { seconds, articles: clips.length };
      else {
        privateLoops += 1;
        privateViewers += variant.userIds.length;
      }
    }
    sweepClips(keepClips);
    // Loops of variants nobody is on any more (a customer deleted, an audience narrowed).
    for (const dir of mediaVariantDirs()) {
      if (!keepDirs.has(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }

    status = {
      state: keepDirs.size ? 'idle' : 'empty',
      error: null,
      built_at: rebuilt || !status.built_at ? new Date().toISOString() : status.built_at,
      seconds: publicSummary.seconds,
      articles: publicSummary.articles,
      variants: privateLoops,
      private_viewers: privateViewers,
    };
    if (rebuilt) {
      log.info('media', 'media loop ready', {
        loops: keepDirs.size, rebuilt, duration_ms: elapsedMs(startedAt), disk_bytes: mediaUsage().used,
      });
    }
    return keepDirs.size ? publicDir : null;
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
