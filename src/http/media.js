// Admin API for the media channel (Информация -> «Медиа», see src/media/).
// Mounted inside admin.js's /api sub-router, like catalog.js, so it inherits
// the auth + CSRF middleware. Multipart uploads are parsed here by multer
// (express.json() upstream ignores them).
//
// Every mutation schedules a debounced loop rebuild (media/build.js); nothing
// here waits for an encode, so the admin stays responsive while a video is
// being processed — the page polls GET /media for progress instead.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { config } from '../config.js';
import { log } from '../core/logger.js';
import {
  Channels, INFO_MEDIA_CHANNEL_ID, INFO_MEDIA_DEFAULT_NAME,
} from '../playlist/catalog.js';
import {
  MediaItems, MEDIA_DIRS, DEFAULTS, LIMITS, mediaUsage, uploadKind, validateItemFields, validateOrder,
  itemFilePath, itemThumbPath, ensureMediaDirs, newMediaId,
} from '../media/store.js';
import {
  scheduleMediaBuild, buildMediaLoop, mediaStatus, queueVideo, cancelVideo, storeImage,
} from '../media/build.js';
import { probeMedia, textSlideSeconds } from '../encode/media.js';
import { renderTextLayer, composeTextFrame, slideScale } from '../render/media.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// View models (pure)
// ---------------------------------------------------------------------------

export function mediaItemJson(item) {
  const base = {
    id: item.id,
    type: item.type,
    title: item.title || '',
    error: item.error || null,
    created_at: item.created_at,
  };
  if (item.type === 'text') {
    return {
      ...base,
      markdown: item.markdown,
      seconds: item.seconds || DEFAULTS.seconds,
      scroll_speed: item.scroll_speed || DEFAULTS.scrollSpeed,
    };
  }
  if (item.type === 'image') {
    return {
      ...base,
      caption: item.caption || '',
      seconds: item.seconds || DEFAULTS.seconds,
      original_name: item.original_name || '',
      size: item.size || 0,
    };
  }
  return {
    ...base,
    status: item.status || 'ready',
    original_name: item.original_name || '',
    duration: item.duration || 0,
    seconds: item.seconds || 0,
    size: item.size || 0,
    has_thumb: !!item.thumb,
  };
}

// The estimated disk cost of keeping a video: its 720p clip plus the copy of
// it inside the finished loop. Used to refuse an upload BEFORE spending an
// encode on something that would not fit.
export function videoCostEstimate(durationSeconds, maxrate = config.media.maxrate) {
  const videoBits = Number.parseFloat(maxrate) * (/m$/i.test(maxrate) ? 1e6 : 1e3);
  const bytesPerSecond = (videoBits + 128_000) / 8;
  return Math.ceil(durationSeconds * bytesPerSecond * 2);
}

function mediaChannel() {
  return Channels.get(INFO_MEDIA_CHANNEL_ID);
}

function mediaView() {
  const channel = mediaChannel();
  return {
    channel: {
      id: INFO_MEDIA_CHANNEL_ID,
      name: channel?.name || INFO_MEDIA_DEFAULT_NAME,
      enabled: channel?.enabled !== false,
    },
    items: MediaItems.all().map(mediaItemJson),
    status: mediaStatus(),
    usage: mediaUsage(),
    limits: LIMITS,
    defaults: DEFAULTS,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/media', (req, res) => res.json(mediaView()));

router.patch('/media/channel', (req, res) => {
  const { name, enabled } = req.body || {};
  const fields = {};
  if (name !== undefined) {
    const clean = String(name).replace(/\s+/g, ' ').trim();
    if (!clean) return res.status(400).json({ error: 'name required' });
    if (clean.length > 80) return res.status(400).json({ error: 'name must be 80 characters or less' });
    fields.name = clean;
  }
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    fields.enabled = enabled;
  }
  Channels.update(INFO_MEDIA_CHANNEL_ID, fields);
  log.info('admin', 'media channel updated', fields);
  return res.json(mediaView());
});

router.post('/media/items', (req, res) => {
  const body = req.body || {};
  if (body.type !== 'text') return res.status(400).json({ error: 'only text slides are created here; upload images and videos' });
  const { value, error } = validateItemFields('text', body);
  if (error) return res.status(400).json({ error });
  const item = MediaItems.create({
    type: 'text', seconds: DEFAULTS.seconds, scroll_speed: DEFAULTS.scrollSpeed, ...value,
  });
  log.info('admin', 'media text slide added', { item_id: item.id });
  scheduleMediaBuild('text slide added');
  return res.json(mediaView());
});

router.patch('/media/items/:id', (req, res) => {
  const item = MediaItems.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'slide not found' });
  const { value, error } = validateItemFields(item.type, req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  MediaItems.update(item.id, value);
  scheduleMediaBuild('slide edited');
  return res.json(mediaView());
});

router.delete('/media/items/:id', (req, res) => {
  const item = MediaItems.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'slide not found' });
  if (item.type === 'video') cancelVideo(item.id);
  MediaItems.remove(item.id); // deletes its files from disk too
  log.info('admin', 'media slide deleted', { item_id: item.id, type: item.type });
  scheduleMediaBuild('slide deleted');
  return res.json(mediaView());
});

router.put('/media/order', (req, res) => {
  const { value, error } = validateOrder(req.body?.ids, MediaItems.all().map((i) => i.id));
  if (error) return res.status(400).json({ error });
  MediaItems.reorder(value);
  scheduleMediaBuild('slides reordered');
  return res.json(mediaView());
});

router.post('/media/rebuild', async (req, res) => {
  buildMediaLoop({ reason: 'admin request', force: true })
    .catch((e) => log.warn('media', 'requested rebuild did not finish', { error: e.message }));
  return res.json(mediaView());
});

// A slide's picture for the admin list: the stored image, or a video's still.
router.get('/media/items/:id/thumb', (req, res) => {
  const item = MediaItems.get(req.params.id);
  const file = item?.type === 'image' ? itemFilePath(item) : itemThumbPath(item);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'no picture' });
  res.set('Cache-Control', 'private, max-age=300');
  return res.sendFile(file);
});

// What a text page will look like on TV, from the same renderer the encode
// uses: one screen for a page that fits, the whole page for one that scrolls.
router.post('/media/preview', async (req, res) => {
  const { value, error } = validateItemFields('text', req.body || {});
  if (error) return res.status(400).json({ error });
  ensureMediaDirs();
  const layerFile = path.join(MEDIA_DIRS.incoming, `preview-${newMediaId()}.png`);
  try {
    const layer = await renderTextLayer(value.markdown, layerFile);
    const image = layer.scrolls
      ? await sharp({
        create: {
          width: config.channel.width, height: layer.height, channels: 3, background: '#0e1630',
        },
      }).composite([{ input: layerFile }]).jpeg({ quality: 80 }).toBuffer()
      : await sharp(await composeTextFrame(layerFile)).jpeg({ quality: 80 }).toBuffer();
    const seconds = textSlideSeconds({
      seconds: value.seconds || DEFAULTS.seconds,
      layerHeight: layer.height,
      screenHeight: config.channel.height,
      scale: slideScale(),
      speed: value.scroll_speed || DEFAULTS.scrollSpeed,
    });
    return res.json({
      image: `data:image/jpeg;base64,${image.toString('base64')}`,
      scrolls: layer.scrolls,
      seconds,
      width: config.channel.width,
      height: layer.height,
    });
  } catch (e) {
    log.error('media', 'preview failed', { error: e.message });
    return res.status(500).json({ error: `preview failed: ${e.message}` });
  } finally {
    fs.rmSync(layerFile, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureMediaDirs();
      cb(null, MEDIA_DIRS.incoming);
    },
    filename: (req, file, cb) => cb(null, `${newMediaId()}${path.extname(file.originalname || '').toLowerCase().slice(0, 6)}`),
  }),
  // Non-ASCII (Cyrillic) file names arrive as UTF-8.
  defParamCharset: 'utf8',
  limits: {
    files: 1,
    fileSize: Math.max(config.media.maxVideoMb, config.media.maxImageMb) * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!uploadKind(file.mimetype, file.originalname)) {
      return cb(Object.assign(new Error('unsupported file type: use JPG, PNG or WebP images, or MP4, MKV, MOV or WebM video'), { status: 415 }));
    }
    const usage = mediaUsage();
    if (usage.used >= usage.quota) {
      return cb(Object.assign(new Error('the media storage limit is reached; delete a slide first'), { status: 507 }));
    }
    return cb(null, true);
  },
});

function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (req.file) fs.rmSync(req.file.path, { force: true });
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `file is larger than ${config.media.maxVideoMb} MB` });
    }
    return res.status(err.status || 400).json({ error: err.message });
  });
}

router.post('/media/upload', receiveFile, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'no file' });
  const raw = file.path;
  const kind = uploadKind(file.mimetype, file.originalname);
  const fail = (status, error) => {
    fs.rmSync(raw, { force: true });
    return res.status(status).json({ error });
  };

  if (kind === 'image') {
    if (file.size > config.media.maxImageMb * 1024 * 1024) {
      return fail(413, `image is larger than ${config.media.maxImageMb} MB`);
    }
    const { value: fields, error } = validateItemFields('image', req.body || {}, { partial: true });
    if (error) return fail(400, error);
    const id = newMediaId();
    let stored;
    try {
      stored = await storeImage(id, raw);
    } catch (e) {
      return fail(400, `not a readable image: ${e.message}`);
    } finally {
      fs.rmSync(raw, { force: true });
    }
    MediaItems.create({
      id, type: 'image', seconds: DEFAULTS.seconds, caption: '', ...fields,
      ...stored, original_name: file.originalname,
    });
    log.info('admin', 'media image uploaded', { item_id: id, bytes: stored.size });
    scheduleMediaBuild('image added');
    return res.json(mediaView());
  }

  // Video: probe now, so a broken file or one that can't fit is refused at
  // once instead of after a long encode.
  let info;
  try {
    info = await probeMedia(raw);
  } catch (e) {
    return fail(400, `not a readable video: ${e.message}`);
  }
  if (!info.hasVideo || !(info.duration > 0)) return fail(400, 'the file has no video track');
  const usage = mediaUsage(); // includes the raw upload itself
  if (usage.used - file.size + videoCostEstimate(info.duration) > usage.quota) {
    return fail(507, 'not enough media storage for this video; delete a slide or upload a shorter one');
  }
  const item = MediaItems.create({
    id: newMediaId(),
    type: 'video',
    status: 'processing',
    original_name: file.originalname,
    duration: Math.round(info.duration * 10) / 10,
  });
  log.info('admin', 'media video uploaded; processing', {
    item_id: item.id, duration_s: info.duration, bytes: file.size,
  });
  queueVideo(item.id, raw); // deletes `raw` when done
  return res.json(mediaView());
});

export default router;
