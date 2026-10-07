// Rasterises the media channel's slides to PNG: text pages (Markdown laid out
// by satori, see render/markdown.js) and images with an optional caption, both
// on the account card's background so the channel reads as one product.
//
// satori turns the flexbox tree into an SVG whose glyphs are already outlined
// paths, so sharp needs no fonts to rasterise it — only satori itself needs the
// Inter files (config.media.fontDir; the Docker image ships them).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { config } from '../config.js';
import { buildBackgroundSvg } from './overlay.js';
import { markdownToTree, SLIDE_WIDTH, THEME } from './markdown.js';

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

// The text page as a transparent PNG, the full width of the channel and as
// tall as the text needs (never shorter than one screen: short pages are
// centred by the layout). Taller than one screen means it scrolls.
export async function renderTextLayer(markdown, outPath) {
  const { data, info } = await treeToPng(markdownToTree(markdown));
  await fs.promises.writeFile(outPath, data);
  return { file: outPath, height: info.height, scrolls: info.height > config.channel.height + 2 };
}

// One finished screen: background + a text layer (the top of it, for a long
// page). Used for a page that fits, and for the admin's preview.
export async function composeTextFrame(textLayerFile, outPath = null) {
  const { width: W, height: H } = config.channel;
  // `cover` anchored at the top: an exactly-W-wide layer is not rescaled, just
  // cut to the first screen.
  const layer = await sharp(textLayerFile)
    .resize({ width: W, height: H, fit: 'cover', position: 'top' })
    .toBuffer();
  const frame = sharp(Buffer.from(buildBackgroundSvg())).composite([{ input: layer, left: 0, top: 0 }]).png();
  if (outPath) {
    await frame.toFile(outPath);
    return outPath;
  }
  return frame.toBuffer();
}

const CAPTION_HEIGHT = 110; // logical px reserved under the picture
const IMAGE_MARGIN = 40;

// An image fitted inside the frame (never cropped, never upscaled past 2x) on
// the channel background, with an optional caption of up to two lines below.
export async function renderImageFrame(imageFile, caption, outPath = null) {
  const s = slideScale();
  const { width: W, height: H } = config.channel;
  const capH = caption ? Math.round(CAPTION_HEIGHT * s) : 0;
  const margin = Math.round(IMAGE_MARGIN * s);
  const boxW = W - 2 * margin;
  const boxH = H - 2 * margin - capH;
  const picture = await sharp(imageFile)
    .rotate() // honour EXIF orientation from phone photos
    .resize({ width: boxW, height: boxH, fit: 'inside' })
    .png()
    .toBuffer({ resolveWithObject: true });
  const layers = [{
    input: picture.data,
    left: Math.round((W - picture.info.width) / 2),
    top: Math.round(margin + (boxH - picture.info.height) / 2),
  }];
  if (caption) {
    const tree = {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          width: SLIDE_WIDTH,
          height: CAPTION_HEIGHT,
          padding: '0 80px',
          color: THEME.text,
          fontFamily: 'Inter',
          fontSize: 34,
          lineHeight: 1.3,
        },
        children: caption,
      },
    };
    const { data } = await treeToPng(tree);
    layers.push({ input: data, left: 0, top: H - margin - capH });
  }
  const frame = sharp(Buffer.from(buildBackgroundSvg())).composite(layers).png();
  if (outPath) {
    await frame.toFile(outPath);
    return outPath;
  }
  return frame.toBuffer();
}
