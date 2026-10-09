// The media channel's content: ARTICLES (rich documents, media/doc.js) shown
// in order, and the ASSETS (uploaded images and videos) they embed. Both live
// in Settings `media_channel`; the files behind the assets on disk.
//
// The channel's NAME and on/off switch are not stored here: they live on its
// built-in catalog row (playlist/model.js INFO_MEDIA_CHANNEL_ID), so the
// catalog screens, the per-customer pins and the admin page edit one value.
//
// An asset belongs to the article it was uploaded into. It is deleted — row and
// files — when that article is deleted, when a save drops it from the article,
// or (never saved into one: an editor closed without saving) by the sweep.
//
// Disk layout under DATA_DIR/media:
//   files/     stored images (downscaled) and the 720p video copies
//   thumbs/    a poster per video
//   clips/     encoded per-article clips, cached by content hash
//   incoming/  uploads still streaming in; emptied at startup
// and the finished loops in DATA_DIR/hls/_media (the public one) and
// DATA_DIR/hls/_media-<variant> (customers who see private content — see
// media/variants.js), served at /m/:token/.
import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { config } from '../config.js';
import { Settings } from '../data/store.js';
import { cleanAudience } from '../core/audience.js';
import {
  sanitizeDoc, docAssetIds, docHasContent, emptyDoc,
} from './doc.js';

const KEY = 'media_channel';
const makeId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 12);
export const newMediaId = makeId;

export const MEDIA_DIRS = {
  files: path.join(config.mediaDir, 'files'),
  thumbs: path.join(config.mediaDir, 'thumbs'),
  clips: path.join(config.mediaDir, 'clips'),
  incoming: path.join(config.mediaDir, 'incoming'),
};

export function mediaLoopDir() {
  return path.join(config.hlsDir, '_media');
}

// The loop of a non-public variant (media/variants.js), named by a hash of its key.
export function mediaVariantDir(hashed) {
  return path.join(config.hlsDir, `_media-${hashed}`);
}

// Every variant loop directory on disk (not the public one).
export function mediaVariantDirs() {
  let names = [];
  try { names = fs.readdirSync(config.hlsDir); } catch { return []; }
  return names.filter((n) => /^_media-[a-z0-9]+$/.test(n)).map((n) => path.join(config.hlsDir, n));
}

export function ensureMediaDirs() {
  for (const dir of Object.values(MEDIA_DIRS)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Limits + validation (pure; unit-tested)
// ---------------------------------------------------------------------------

export const LIMITS = {
  titleChars: 120,
  minSeconds: 3,
  maxSeconds: 600,
  minSpeed: 10,
  maxSpeed: 200,
};

export const DEFAULTS = {
  seconds: 15,
  scrollSpeed: 40, // logical px per second, ~1 line every 1.2s
};

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const VIDEO_TYPES = ['video/mp4', 'video/x-matroska', 'video/quicktime', 'video/webm'];
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mkv|mov|webm)$/i;

// Which kind of asset an upload is, from its MIME type or (browsers send an
// empty or generic type for .mkv) its extension. null = not accepted.
export function uploadKind(mimetype, filename) {
  const type = String(mimetype || '').toLowerCase();
  if (IMAGE_TYPES.includes(type) || IMAGE_EXT.test(filename || '')) return 'image';
  if (VIDEO_TYPES.includes(type) || VIDEO_EXT.test(filename || '')) return 'video';
  return null;
}

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return { error: `${label} must be a whole number from ${min} to ${max}` };
  return { value: n };
}

// Article fields an admin may set -> { value } | { error }. `partial` is a
// PATCH: absent fields are left alone.
export function validateArticleFields(body = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('title')) {
    out.title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.titleChars);
  }
  if (!partial || has('doc')) {
    if (!has('doc')) out.doc = emptyDoc();
    else {
      const { value, error } = sanitizeDoc(body.doc);
      if (error) return { error };
      out.doc = value;
    }
  }
  if (has('seconds')) {
    const r = intIn(body.seconds, LIMITS.minSeconds, LIMITS.maxSeconds, 'seconds');
    if (r.error) return r;
    out.seconds = r.value;
  }
  if (has('scroll_speed')) {
    const r = intIn(body.scroll_speed, LIMITS.minSpeed, LIMITS.maxSpeed, 'scroll speed');
    if (r.error) return r;
    out.scroll_speed = r.value;
  }
  // null = every customer; an audience = only that group (core/audience.js).
  if (has('audience')) {
    if (body.audience === null) out.audience = null;
    else {
      const audience = cleanAudience(body.audience);
      if (!audience) return { error: 'audience must be null or { users, plans }' };
      out.audience = audience;
    }
  }
  return { value: out };
}

// A reorder must name exactly the existing articles, each once.
export function validateOrder(ids, existingIds) {
  if (!Array.isArray(ids)) return { error: 'ids must be an array' };
  const wanted = new Set(existingIds);
  if (ids.length !== wanted.size || new Set(ids).size !== ids.length || ids.some((id) => !wanted.has(id))) {
    return { error: 'the order must list every article exactly once' };
  }
  return { value: ids };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function read() {
  const stored = Settings.all()[KEY] || {};
  return {
    articles: Array.isArray(stored.articles) ? stored.articles : [],
    assets: Array.isArray(stored.assets) ? stored.assets : [],
  };
}

function write(patch) {
  const current = Settings.all()[KEY] || {};
  // `items` was the first draft of this feature (single-media slides); it
  // never shipped, and is dropped on the first write.
  const { items: _draft, ...rest } = current;
  Settings.set(KEY, { ...rest, ...patch });
}

function updateIn(list, id, fields) {
  let updated = null;
  const next = list.map((row) => {
    if (row.id !== id) return row;
    updated = { ...row, ...fields };
    return updated;
  });
  return { next, updated };
}

export const Assets = {
  all: () => read().assets.map((a) => ({ ...a })),
  get: (id) => {
    const asset = read().assets.find((a) => a.id === id);
    return asset ? { ...asset } : null;
  },
  create: (fields) => {
    const asset = { id: makeId(), created_at: new Date().toISOString(), ...fields };
    write({ assets: [...read().assets, asset] });
    return { ...asset };
  },
  update: (id, fields) => {
    const { next, updated } = updateIn(read().assets, id, fields);
    if (updated) write({ assets: next });
    return updated ? { ...updated } : null;
  },
  // Row + files.
  remove: (id) => {
    const assets = read().assets;
    const asset = assets.find((a) => a.id === id);
    if (!asset) return null;
    write({ assets: assets.filter((a) => a.id !== id) });
    removeAssetFiles(asset);
    return asset;
  },
};

export const Articles = {
  all: () => read().articles.map((a) => ({ ...a })),
  get: (id) => {
    const article = read().articles.find((a) => a.id === id);
    return article ? { ...article } : null;
  },
  create: (fields = {}) => {
    const now = new Date().toISOString();
    const article = {
      id: makeId(),
      title: '',
      doc: emptyDoc(),
      seconds: DEFAULTS.seconds,
      scroll_speed: DEFAULTS.scrollSpeed,
      audience: null,
      created_at: now,
      updated_at: now,
      ...fields,
    };
    write({ articles: [...read().articles, article] });
    return { ...article };
  },
  // Saving a new document also deletes this article's assets it no longer
  // uses — "removed from the article = removed from disk".
  update: (id, fields) => {
    const { next, updated } = updateIn(read().articles, id, { ...fields, updated_at: new Date().toISOString() });
    if (!updated) return null;
    write({ articles: next });
    if (fields.doc) {
      // Any article counts: an image copy-pasted into another article stays.
      const used = new Set(next.flatMap((a) => docAssetIds(a.doc)));
      for (const asset of read().assets) {
        if (asset.article_id === id && !used.has(asset.id)) Assets.remove(asset.id);
      }
    }
    return { ...updated };
  },
  reorder: (ids) => {
    const byId = new Map(read().articles.map((a) => [a.id, a]));
    write({ articles: ids.map((id) => byId.get(id)).filter(Boolean) });
  },
  // Row + every asset uploaded into it (and their files).
  remove: (id) => {
    const { articles, assets } = read();
    const article = articles.find((a) => a.id === id);
    if (!article) return null;
    const rest = articles.filter((a) => a.id !== id);
    const stillUsed = new Set(rest.flatMap((a) => docAssetIds(a.doc)));
    const owners = new Set(rest.map((a) => a.id));
    // Its own uploads — and any whose owner is already gone (shared from an
    // article deleted earlier) — unless an article still shows them.
    const mine = assets.filter((a) => (a.article_id === id || !owners.has(a.article_id)) && !stillUsed.has(a.id));
    const gone = new Set(mine.map((a) => a.id));
    write({ articles: rest, assets: assets.filter((a) => !gone.has(a.id)) });
    mine.forEach(removeAssetFiles);
    return { article, assets: mine };
  },
};

export function assetFilePath(asset) {
  return asset?.file ? path.join(MEDIA_DIRS.files, path.basename(asset.file)) : null;
}

export function assetThumbPath(asset) {
  return asset?.thumb ? path.join(MEDIA_DIRS.thumbs, path.basename(asset.thumb)) : null;
}

export function removeAssetFiles(asset) {
  for (const file of [assetFilePath(asset), assetThumbPath(asset)]) {
    if (file) fs.rmSync(file, { force: true });
  }
}

// Articles opened with "Новая статья" and abandoned (the tab was closed before
// the editor could clean up): still empty and untitled after `minAgeMs`.
export function sweepAbandonedArticles({ minAgeMs = 0, now = Date.now() } = {}) {
  let removed = 0;
  for (const article of read().articles) {
    if (article.title || docHasContent(article.doc)) continue;
    if (now - Date.parse(article.updated_at || article.created_at || 0) < minAgeMs) continue;
    Articles.remove(article.id);
    removed += 1;
  }
  return removed;
}

// Assets no saved article uses: uploaded into an editor that was then closed
// without saving, or whose article is gone. `minAgeMs` spares fresh uploads an
// editor that is still open is about to save.
export function sweepUnusedAssets({ minAgeMs = 0, now = Date.now() } = {}) {
  const { articles, assets } = read();
  const used = new Set(articles.flatMap((a) => docAssetIds(a.doc)));
  let removed = 0;
  for (const asset of assets) {
    if (used.has(asset.id)) continue;
    if (now - Date.parse(asset.created_at || 0) < minAgeMs) continue;
    if (asset.status === 'processing' && minAgeMs) continue;
    Assets.remove(asset.id);
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Disk budget
// ---------------------------------------------------------------------------

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else {
      try { total += fs.statSync(full).size; } catch { /* vanished meanwhile */ }
    }
  }
  return total;
}

export function mediaUsage() {
  const used = dirSize(config.mediaDir) + dirSize(mediaLoopDir())
    + mediaVariantDirs().reduce((sum, dir) => sum + dirSize(dir), 0);
  return {
    used,
    quota: config.media.quotaMb * 1024 * 1024,
    max_video: config.media.maxVideoMb * 1024 * 1024,
    max_image: config.media.maxImageMb * 1024 * 1024,
  };
}

// Startup housekeeping: drop half-received uploads, half-built clips, assets
// no article uses and any file nothing references (a crash between upload and
// save, or a delete that died midway). A video still marked "processing" lost
// its source with incoming/, so it is marked failed rather than left spinning.
export function sweepOrphans() {
  ensureMediaDirs();
  fs.rmSync(MEDIA_DIRS.incoming, { recursive: true, force: true });
  fs.mkdirSync(MEDIA_DIRS.incoming, { recursive: true });
  for (const name of fs.readdirSync(MEDIA_DIRS.clips)) {
    if (name.startsWith('.work-')) fs.rmSync(path.join(MEDIA_DIRS.clips, name), { recursive: true, force: true });
  }
  for (const asset of Assets.all()) {
    if (asset.status === 'processing') {
      Assets.update(asset.id, { status: 'error', error: 'обработка прервана перезапуском сервера' });
    }
  }
  let removed = sweepUnusedAssets();
  const keep = new Set(Assets.all().flatMap((a) => [a.file, a.thumb]).filter(Boolean).map((f) => path.basename(f)));
  for (const dir of [MEDIA_DIRS.files, MEDIA_DIRS.thumbs]) {
    for (const name of fs.readdirSync(dir)) {
      if (keep.has(name)) continue;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
