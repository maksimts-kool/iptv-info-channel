// Admin API for the media channel (Информация -> «Медиа», see src/media/).
// Mounted inside admin.js's /api sub-router, like catalog.js, so it inherits
// the auth + CSRF middleware. Multipart uploads are parsed here by multer
// (express.json() upstream ignores them).
//
// Every content mutation schedules a debounced loop rebuild (media/build.js);
// nothing here waits for an encode, so the admin stays responsive while a
// video is processed — the editor polls the asset instead.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { log } from '../core/logger.js';
import {
  Channels, INFO_MEDIA_CHANNEL_ID, INFO_MEDIA_DEFAULT_NAME,
} from '../playlist/catalog.js';
import {
  Articles, Assets, MEDIA_DIRS, DEFAULTS, LIMITS, mediaUsage, uploadKind, validateArticleFields, validateOrder,
  assetFilePath, assetThumbPath, ensureMediaDirs, newMediaId,
} from '../media/store.js';
import { docAssetIds, docHasContent, docSummary } from '../media/doc.js';
import {
  scheduleMediaBuild, buildMediaLoop, mediaStatus, queueVideo, cancelVideo, storeImage,
  articleMedia, layoutArticle,
} from '../media/build.js';
import { probeMedia } from '../encode/media.js';
import { articlePreviewJpeg } from '../render/media.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// View models (pure)
// ---------------------------------------------------------------------------

export function assetJson(asset) {
  return {
    id: asset.id,
    kind: asset.kind,
    status: asset.status || 'ready',
    error: asset.error || null,
    width: asset.width || 0,
    height: asset.height || 0,
    duration: asset.duration || 0,
    has_audio: asset.kind === 'video' ? !!asset.has_audio : undefined,
    size: asset.size || 0,
    original_name: asset.original_name || '',
  };
}

// An article for the list: what is in it, not the whole document.
export function articleSummaryJson(article, assetsById = new Map()) {
  const assets = docAssetIds(article.doc).map((id) => assetsById.get(id)).filter(Boolean);
  const cover = assets.find((a) => a.kind === 'image' || (a.kind === 'video' && a.thumb));
  return {
    id: article.id,
    title: article.title || '',
    summary: docSummary(article.doc),
    empty: !docHasContent(article.doc),
    seconds: article.seconds || DEFAULTS.seconds,
    scroll_speed: article.scroll_speed || DEFAULTS.scrollSpeed,
    images: assets.filter((a) => a.kind === 'image').length,
    videos: assets.filter((a) => a.kind === 'video').length,
    processing: assets.filter((a) => a.status === 'processing').length,
    cover: cover ? cover.id : null,
    error: article.error || null,
    updated_at: article.updated_at,
  };
}

// The whole article, for the editor: its document plus the assets it uses.
export function articleJson(article, assetsById = new Map()) {
  const assets = {};
  for (const id of docAssetIds(article.doc)) {
    if (assetsById.has(id)) assets[id] = assetJson(assetsById.get(id));
  }
  return { ...articleSummaryJson(article, assetsById), doc: article.doc, assets };
}

// The estimated disk cost of keeping a video: its 720p copy, the article clip
// it is composited into and that clip's copy in the finished loop. Used to
// refuse an upload BEFORE spending an encode on something that would not fit.
export function videoCostEstimate(durationSeconds, maxrate = config.media.maxrate) {
  const videoBits = Number.parseFloat(maxrate) * (/m$/i.test(maxrate) ? 1e6 : 1e3);
  const bytesPerSecond = (videoBits + 128_000) / 8;
  return Math.ceil(durationSeconds * bytesPerSecond * 3);
}

const assetMap = () => new Map(Assets.all().map((a) => [a.id, a]));

function mediaView() {
  const channel = Channels.get(INFO_MEDIA_CHANNEL_ID);
  const assets = assetMap();
  return {
    channel: {
      id: INFO_MEDIA_CHANNEL_ID,
      name: channel?.name || INFO_MEDIA_DEFAULT_NAME,
      enabled: channel?.enabled !== false,
    },
    articles: Articles.all().map((a) => articleSummaryJson(a, assets)),
    status: mediaStatus(),
    usage: mediaUsage(),
    limits: LIMITS,
    defaults: DEFAULTS,
  };
}

function requireArticle(req, res) {
  const article = Articles.get(req.params.id);
  if (!article) res.status(404).json({ error: 'article not found' });
  return article;
}

// ---------------------------------------------------------------------------
// Channel + articles
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

// A new (empty) article: created up front so uploads in the editor have an
// article to belong to. An empty article never reaches the channel.
router.post('/media/articles', (req, res) => {
  const { value, error } = validateArticleFields(req.body || {});
  if (error) return res.status(400).json({ error });
  const article = Articles.create(value);
  log.info('admin', 'media article created', { article_id: article.id });
  if (docHasContent(article.doc)) scheduleMediaBuild('article added');
  return res.status(201).json(articleJson(article, assetMap()));
});

router.get('/media/articles/:id', (req, res) => {
  const article = requireArticle(req, res);
  if (!article) return undefined;
  return res.json(articleJson(article, assetMap()));
});

router.patch('/media/articles/:id', (req, res) => {
  const article = requireArticle(req, res);
  if (!article) return undefined;
  const { value, error } = validateArticleFields(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  if (value.doc) {
    const known = assetMap();
    const unknown = docAssetIds(value.doc).filter((id) => !known.has(id));
    if (unknown.length) return res.status(400).json({ error: 'the article refers to a file that no longer exists' });
  }
  const saved = Articles.update(article.id, value); // also deletes assets it dropped
  scheduleMediaBuild('article edited');
  return res.json(articleJson(saved, assetMap()));
});

router.delete('/media/articles/:id', (req, res) => {
  const article = requireArticle(req, res);
  if (!article) return undefined;
  for (const asset of Assets.all()) if (asset.article_id === article.id) cancelVideo(asset.id);
  const { assets } = Articles.remove(article.id); // deletes its files too
  log.info('admin', 'media article deleted', { article_id: article.id, files: assets.length });
  scheduleMediaBuild('article deleted');
  return res.json(mediaView());
});

router.put('/media/order', (req, res) => {
  const { value, error } = validateOrder(req.body?.ids, Articles.all().map((a) => a.id));
  if (error) return res.status(400).json({ error });
  Articles.reorder(value);
  scheduleMediaBuild('articles reordered');
  return res.json(mediaView());
});

router.post('/media/rebuild', (req, res) => {
  buildMediaLoop({ reason: 'admin request', force: true })
    .catch((e) => log.warn('media', 'requested rebuild did not finish', { error: e.message }));
  return res.json(mediaView());
});

// What an article will look like on TV, from the same layout code the encoder
// uses: the whole page (tall when it scrolls) with video posters in place, and
// how long it will be on screen. Works on the unsaved document in the editor.
router.post('/media/preview', async (req, res) => {
  const { value, error } = validateArticleFields(req.body || {});
  if (error) return res.status(400).json({ error });
  const article = { ...value, seconds: value.seconds || DEFAULTS.seconds, scroll_speed: value.scroll_speed || DEFAULTS.scrollSpeed };
  ensureMediaDirs();
  const layerFile = path.join(MEDIA_DIRS.incoming, `preview-${newMediaId()}.png`);
  try {
    const laid = await layoutArticle(article, articleMedia(article), layerFile);
    if (!laid) return res.json({ image: null, seconds: 0, scrolls: false });
    const image = await articlePreviewJpeg(layerFile, laid.layer.height);
    return res.json({
      image: `data:image/jpeg;base64,${image.toString('base64')}`,
      scrolls: laid.timeline.maxScroll > 0,
      seconds: laid.timeline.total,
      videos: laid.videos.length,
      width: config.channel.width,
      height: laid.layer.height,
    });
  } catch (e) {
    log.error('media', 'preview failed', { error: e.message });
    return res.status(500).json({ error: `preview failed: ${e.message}` });
  } finally {
    fs.rmSync(layerFile, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Assets (images and videos inside articles)
// ---------------------------------------------------------------------------

router.get('/media/assets/:id', (req, res) => {
  const asset = Assets.get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'file not found' });
  return res.json(assetJson(asset));
});

// The picture for the editor and the list: the image itself, or a video's poster.
router.get('/media/assets/:id/picture', (req, res) => {
  const asset = Assets.get(req.params.id);
  const file = asset?.kind === 'image' ? assetFilePath(asset) : assetThumbPath(asset);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'no picture' });
  res.set('Cache-Control', 'private, max-age=300');
  return res.sendFile(file);
});

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
      return cb(Object.assign(new Error('the media storage limit is reached; delete something first'), { status: 507 }));
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

// Upload an image or a video into an article. The editor inserts it into the
// document straight away; it becomes part of the channel when the article is
// saved (an upload never saved into an article is swept later).
router.post('/media/articles/:id/assets', receiveFile, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'no file' });
  const raw = file.path;
  const fail = (status, error) => {
    fs.rmSync(raw, { force: true });
    return res.status(status).json({ error });
  };
  const article = Articles.get(req.params.id);
  if (!article) return fail(404, 'article not found');
  const kind = uploadKind(file.mimetype, file.originalname);
  const id = newMediaId();

  if (kind === 'image') {
    if (file.size > config.media.maxImageMb * 1024 * 1024) {
      return fail(413, `image is larger than ${config.media.maxImageMb} MB`);
    }
    let stored;
    try {
      stored = await storeImage(id, raw);
    } catch (e) {
      return fail(400, `not a readable image: ${e.message}`);
    } finally {
      fs.rmSync(raw, { force: true });
    }
    const asset = Assets.create({
      id, article_id: article.id, kind: 'image', status: 'ready', original_name: file.originalname, ...stored,
    });
    log.info('admin', 'media image uploaded', { asset_id: id, article_id: article.id, bytes: stored.size });
    return res.status(201).json(assetJson(asset));
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
    return fail(507, 'not enough media storage for this video; delete something or upload a shorter one');
  }
  const asset = Assets.create({
    id,
    article_id: article.id,
    kind: 'video',
    status: 'processing',
    original_name: file.originalname,
    width: info.width,
    height: info.height,
    duration: Math.round(info.duration * 1000) / 1000,
  });
  log.info('admin', 'media video uploaded; processing', {
    asset_id: id, article_id: article.id, duration_s: info.duration, bytes: file.size,
  });
  queueVideo(id, raw, info); // deletes `raw` when done
  return res.status(201).json(assetJson(asset));
});

export default router;
