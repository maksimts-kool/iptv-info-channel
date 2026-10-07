// Rasterises the media channel's articles: the tall page (text, pictures and
// video posters, laid out by render/article.js), the corner chip, and the
// channel background the page scrolls over.
//
// satori turns each flexbox tree into an SVG whose glyphs are already outlined
// paths, so sharp needs no fonts to rasterise it — only satori itself needs the
// Inter files (config.media.fontDir; the Docker image ships them).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { config } from '../config.js';
import { buildBackgroundSvg } from './overlay.js';
import {
  SLIDE_WIDTH, MEDIA_WIDTHS, flowTree, videoTree, indicatorTree,
} from './article.js';
import { docSections } from '../media/doc.js';

// satori is loaded on first use, through its CommonJS build: the ESM build of
// the current release references `__dirname` and throws on import. Lazy also
// keeps it (and its fonts) out of every module that merely imports this one.
let satori = null;
function loadSatori() {
  satori ||= createRequire(import.meta.url)('satori').default;
  return satori;
}

const FONT_FILES = [
  ['Inter-Regular.otf', 400, 'normal'],
  ['Inter-SemiBold.otf', 600, 'normal'],
  ['Inter-Bold.otf', 700, 'normal'],
  ['Inter-Italic.otf', 400, 'italic'],
  ['Inter-BoldItalic.otf', 700, 'italic'],
];

let fonts = null;
function loadFonts() {
  if (fonts) return fonts;
  const found = FONT_FILES
    .map(([file, weight, style]) => ({ file: path.join(config.media.fontDir, file), weight, style }))
    .filter((f) => fs.existsSync(f.file));
  if (!found.length) {
    throw new Error(`Inter fonts not found in ${config.media.fontDir} (set MEDIA_FONT_DIR)`);
  }
  fonts = found.map((f) => ({
    name: 'Inter', data: fs.readFileSync(f.file), weight: f.weight, style: f.style,
  }));
  return fonts;
}

// Logical (1280-wide) units -> output pixels.
export function slideScale() {
  return config.channel.width / SLIDE_WIDTH;
}

async function treeToPng(tree, width = SLIDE_WIDTH) {
  const svg = await loadSatori()(tree, { width, fonts: loadFonts() });
  return sharp(Buffer.from(svg), { density: 72 * slideScale() })
    .resize({ width: Math.round(width * slideScale()) })
    .png()
    .toBuffer({ resolveWithObject: true });
}

export async function renderBackgroundPng(outPath, { edges = false } = {}) {
  await sharp(Buffer.from(buildBackgroundSvg({ edges }))).png().toFile(outPath);
  return outPath;
}

// A picture as a data URI, no wider than the widest box it can be shown in.
async function pictureUri(file) {
  const width = Math.round(MEDIA_WIDTHS.full * slideScale());
  const data = await sharp(file)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${data.toString('base64')}`;
}

// Load every ready picture/poster the article uses, for the pure tree builders.
// `media` is [{ id, kind, width, height, picture: file path }].
async function pictureContext(media) {
  const loaded = new Map();
  for (const m of media) {
    if (!m.picture || !fs.existsSync(m.picture)) continue;
    loaded.set(m.id, { src: await pictureUri(m.picture), width: m.width, height: m.height, kind: m.kind });
  }
  const pick = (kind) => (id) => {
    const hit = loaded.get(id);
    return hit && hit.kind === kind ? hit : null;
  };
  return { image: pick('image'), poster: pick('video') };
}

// The whole article as one transparent PNG the width of the channel, as tall
// as it needs (a short article is centred within one screen), plus where every
// playable video sits on it, in output pixels. null = nothing to show.
export async function renderArticleLayer(doc, media, outPath) {
  const ctx = await pictureContext(media);
  const sections = docSections(doc);
  const s = slideScale();
  const pieces = [];
  for (let i = 0; i < sections.length; i += 1) {
    const flags = { first: i === 0, last: i === sections.length - 1 };
    if (sections[i].kind === 'video') {
      const video = videoTree(sections[i].node, ctx, flags);
      if (!video) continue; // not processed yet: left out until it is
      const { data, info } = await treeToPng(video.tree);
      pieces.push({ data, height: info.height, video: { assetId: sections[i].node.attrs.assetId, box: video.box } });
    } else {
      const { data, info } = await treeToPng(flowTree(sections[i].nodes, ctx, flags));
      pieces.push({ data, height: info.height });
    }
  }
  if (!pieces.length) return null;

  const { width: W, height: H } = config.channel;
  const contentHeight = pieces.reduce((sum, p) => sum + p.height, 0);
  const layerHeight = Math.max(H, contentHeight);
  let y = Math.round((layerHeight - contentHeight) / 2);
  const layers = [];
  const videos = [];
  for (const piece of pieces) {
    layers.push({ input: piece.data, left: 0, top: y });
    if (piece.video) {
      const { box } = piece.video;
      const even = (v) => Math.max(2, Math.round(v * s / 2) * 2);
      videos.push({
        assetId: piece.video.assetId,
        x: Math.round(box.x * s),
        y: y + Math.round(box.y * s),
        width: even(box.width),
        height: even(box.height),
        focus: Math.round(box.focus * s),
      });
    }
    y += piece.height;
  }
  await sharp({
    create: {
      width: W, height: layerHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(layers).png().toFile(outPath);
  return { file: outPath, height: layerHeight, videos };
}

// The «1/3 · Заголовок» corner chip as a full transparent frame, or null.
export async function renderIndicatorPng(info, outPath) {
  const tree = indicatorTree(info);
  if (!tree) return null;
  const { data } = await treeToPng(tree);
  await sharp(data)
    .resize({ width: config.channel.width, height: config.channel.height, fit: 'fill' })
    .png()
    .toFile(outPath);
  return outPath;
}

// What the admin's preview shows: the whole page on the channel background
// colour, as a JPEG (tall when the article scrolls).
export async function articlePreviewJpeg(layerFile, layerHeight) {
  return sharp({
    create: {
      width: config.channel.width, height: layerHeight, channels: 3, background: '#0e1630',
    },
  }).composite([{ input: layerFile }]).jpeg({ quality: 80 }).toBuffer();
}
