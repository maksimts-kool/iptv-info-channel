// The media channel's content: an ordered list of slides (text page, image,
// video) kept in Settings `media_channel`, plus the files on disk behind them.
//
// The channel's NAME and on/off switch are not stored here: they live on its
// built-in catalog row (playlist/model.js INFO_MEDIA_CHANNEL_ID), so the
// catalog screens, the per-customer pins and this page all edit one value.
//
// Disk layout under DATA_DIR/media:
//   files/     uploaded images (downscaled) and the 720p video copies
//   thumbs/    a still per video for the admin list
//   clips/     encoded per-slide clips, cached by content hash (encode/media.js)
//   incoming/  uploads still streaming in; emptied at startup
// and the finished loop in DATA_DIR/hls/_media (served at /m/:token/).
import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { config } from '../config.js';
import { Settings } from '../data/store.js';

const KEY = 'media_channel';
const makeId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 12);

export const MEDIA_DIRS = {
  files: path.join(config.mediaDir, 'files'),
  thumbs: path.join(config.mediaDir, 'thumbs'),
  clips: path.join(config.mediaDir, 'clips'),
  incoming: path.join(config.mediaDir, 'incoming'),
};

export function mediaLoopDir() {
  return path.join(config.hlsDir, '_media');
}

export function ensureMediaDirs() {
  for (const dir of Object.values(MEDIA_DIRS)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Limits + validation (pure; unit-tested)
// ---------------------------------------------------------------------------

export const LIMITS = {
  markdownChars: 20_000,
  captionChars: 140,
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

// Which kind of slide an upload is, from its MIME type or (browsers send an
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

// Fields an admin may set on a slide, by type -> { value } | { error }.
// `partial` is a PATCH: absent fields are left alone.
export function validateItemFields(type, body = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (type === 'text' && (!partial || has('markdown'))) {
    const markdown = String(body.markdown ?? '');
    if (!markdown.trim()) return { error: 'text is empty' };
    if (markdown.length > LIMITS.markdownChars) {
      return { error: `text must be ${LIMITS.markdownChars} characters or less` };
    }
    out.markdown = markdown;
  }
  if (type === 'text' && has('scroll_speed')) {
    const r = intIn(body.scroll_speed, LIMITS.minSpeed, LIMITS.maxSpeed, 'scroll speed');
    if (r.error) return r;
    out.scroll_speed = r.value;
  }
  if ((type === 'text' || type === 'image') && has('seconds')) {
    const r = intIn(body.seconds, LIMITS.minSeconds, LIMITS.maxSeconds, 'seconds');
    if (r.error) return r;
    out.seconds = r.value;
  }
  if (type === 'image' && has('caption')) {
    const caption = String(body.caption ?? '').replace(/\s+/g, ' ').trim();
    if (caption.length > LIMITS.captionChars) {
      return { error: `caption must be ${LIMITS.captionChars} characters or less` };
    }
    out.caption = caption;
  }
  if (has('title')) {
    out.title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return { value: out };
}

// A reorder must name exactly the existing slides, each once.
export function validateOrder(ids, existingIds) {
  if (!Array.isArray(ids)) return { error: 'ids must be an array' };
  const wanted = new Set(existingIds);
  if (ids.length !== wanted.size || new Set(ids).size !== ids.length || ids.some((id) => !wanted.has(id))) {
    return { error: 'the order must list every slide exactly once' };
  }
  return { value: ids };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function read() {
  const stored = Settings.all()[KEY];
  return { items: Array.isArray(stored?.items) ? stored.items : [] };
}

function write(items) {
  Settings.set(KEY, { ...(Settings.all()[KEY] || {}), items });
}

export const MediaItems = {
  all: () => read().items.map((item) => ({ ...item })),
  get: (id) => {
    const item = read().items.find((i) => i.id === id);
    return item ? { ...item } : null;
  },
  create: (fields) => {
    const item = { id: makeId(), created_at: new Date().toISOString(), ...fields };
    write([...read().items, item]);
    return { ...item };
  },
  update: (id, fields) => {
    let updated = null;
    const items = read().items.map((item) => {
      if (item.id !== id) return item;
      updated = { ...item, ...fields };
      return updated;
    });
    if (updated) write(items);
    return updated ? { ...updated } : null;
  },
  reorder: (ids) => {
    const byId = new Map(read().items.map((item) => [item.id, item]));
    write(ids.map((id) => byId.get(id)).filter(Boolean));
  },
  // Removes the row and every file that belonged to it. Cached clips are not
  // per-item (they are keyed by content) and go in the next build's sweep.
  remove: (id) => {
    const items = read().items;
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    write(items.filter((i) => i.id !== id));
    removeItemFiles(item);
    return item;
  },
};

export function itemFilePath(item) {
  return item?.file ? path.join(MEDIA_DIRS.files, path.basename(item.file)) : null;
}

export function itemThumbPath(item) {
  return item?.thumb ? path.join(MEDIA_DIRS.thumbs, path.basename(item.thumb)) : null;
}

export function removeItemFiles(item) {
  for (const file of [itemFilePath(item), itemThumbPath(item)]) {
    if (file) fs.rmSync(file, { force: true });
  }
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
  const used = dirSize(config.mediaDir) + dirSize(mediaLoopDir());
  return {
    used,
    quota: config.media.quotaMb * 1024 * 1024,
    max_video: config.media.maxVideoMb * 1024 * 1024,
    max_image: config.media.maxImageMb * 1024 * 1024,
  };
}

// Startup housekeeping: drop half-received uploads and any file in files/ or
// thumbs/ that no slide references (a crash between upload and save, or a
// delete that died midway). A video still marked "processing" lost its source
// with incoming/, so it is marked failed rather than left spinning forever.
export function sweepOrphans() {
  ensureMediaDirs();
  fs.rmSync(MEDIA_DIRS.incoming, { recursive: true, force: true });
  fs.mkdirSync(MEDIA_DIRS.incoming, { recursive: true });

  const items = MediaItems.all();
  for (const item of items) {
    if (item.type === 'video' && item.status === 'processing') {
      MediaItems.update(item.id, { status: 'error', error: 'обработка прервана перезапуском сервера' });
    }
  }
  for (const name of fs.readdirSync(MEDIA_DIRS.clips)) {
    if (name.startsWith('.work-')) fs.rmSync(path.join(MEDIA_DIRS.clips, name), { recursive: true, force: true });
  }
  const keep = new Set(items.flatMap((i) => [i.file, i.thumb]).filter(Boolean).map((f) => path.basename(f)));
  let removed = 0;
  for (const dir of [MEDIA_DIRS.files, MEDIA_DIRS.thumbs]) {
    for (const name of fs.readdirSync(dir)) {
      if (keep.has(name)) continue;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export const newMediaId = makeId;
