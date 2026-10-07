// An article (media/doc.js) -> satori element trees for the TV page.
//
// Pure: no I/O, no fonts. Pictures arrive through `ctx` already loaded as data
// URIs, and render/media.js does the rasterising and stacking. Unit-tested in
// test/render/article.test.js.
//
// One satori quirk shapes the inline code: a <div> with several children must
// be `display: flex`, and satori has no inline formatting context — so a
// paragraph mixing plain, bold and italic text cannot be one block of text.
// Every word becomes its own span in a wrapping flex row instead, which wraps
// at word boundaries the way a browser would.

// Logical page size. Everything is laid out 1280 wide and scaled to the
// channel resolution when rasterised, like the SVGs in overlay.js.
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;
export const PAD_X = 96;
export const PAD_Y = 72;
export const CONTENT_WIDTH = SLIDE_WIDTH - 2 * PAD_X;

// The account card's palette (render/overlay.js), so an article looks like
// the rest of the channel.
export const THEME = {
  text: '#dbe4f3',
  strong: '#ffffff',
  muted: '#93a3c0',
  accent: '#38bdf8',
  accent2: '#a5b4fc',
  codeBg: 'rgba(148, 163, 184, 0.18)',
  rule: 'rgba(255, 255, 255, 0.16)',
  chip: 'rgba(15, 24, 48, 0.85)',
};

const BASE_FONT = 34;
const GAP = 18;

const HEADING = {
  1: { fontSize: 60, fontWeight: 700, color: THEME.strong, marginBottom: 22 },
  2: { fontSize: 46, fontWeight: 700, color: THEME.accent, marginBottom: 18 },
  3: { fontSize: 38, fontWeight: 600, color: THEME.accent2, marginBottom: 14 },
};

// Width of a picture or video by its size setting, in logical px.
export const MEDIA_WIDTHS = { full: CONTENT_WIDTH, half: Math.round(CONTENT_WIDTH / 2), small: 360 };
// Tallest a picture or video may be, so a video box with its caption fits on
// one screen (it is played with the scroll paused on it).
export const MAX_MEDIA_HEIGHT = 460;
// Vertical space above/below a picture or video block, and its caption line.
export const MEDIA_MARGIN = 16;
const CAPTION_GAP = 10;
const CAPTION_LINE = Math.ceil(26 * 1.3);

// The box a picture or video occupies: its size setting's width, the media's
// own aspect ratio, capped in height (a portrait video narrows instead).
export function mediaBox(dims, size = 'full') {
  const width = MEDIA_WIDTHS[size] || MEDIA_WIDTHS.full;
  const aspect = dims?.width > 0 && dims?.height > 0 ? dims.height / dims.width : 9 / 16;
  let w = width;
  let h = Math.round(w * aspect);
  if (h > MAX_MEDIA_HEIGHT) {
    h = MAX_MEDIA_HEIGHT;
    w = Math.round(h / aspect);
  }
  return { width: w, height: h };
}

function el(type, style, children) {
  return { type, props: { style, children } };
}

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

const MARK_STYLE = {
  bold: { fontWeight: 700, color: THEME.strong },
  italic: { fontStyle: 'italic' },
  strike: { textDecoration: 'line-through' },
};

// Text nodes -> styled runs: [{ text, style }] or { br: true }.
export function inlineRuns(nodes = [], base = {}) {
  const runs = [];
  for (const node of nodes) {
    if (node.type === 'hardBreak') { runs.push({ br: true }); continue; }
    if (node.type !== 'text') continue;
    let style = { ...base };
    let code = false;
    for (const mark of node.marks || []) {
      if (mark.type === 'code') code = true;
      else style = { ...style, ...MARK_STYLE[mark.type] };
    }
    runs.push({ text: node.text, style, code });
  }
  return runs;
}

// One span per word (trailing space kept on the word) so a wrapping flex row
// breaks between words. Inline code stays one chip.
function wordSpans(runs) {
  const spans = [];
  for (const run of runs) {
    if (run.br) {
      spans.push(el('div', { width: '100%', height: 0 }));
      continue;
    }
    if (run.code) {
      spans.push(el('span', {
        ...run.style,
        whiteSpace: 'pre',
        backgroundColor: THEME.codeBg,
        borderRadius: 6,
        padding: '0 8px',
        margin: '0 4px',
      }, run.text));
      continue;
    }
    for (const word of run.text.split(/(?<=\s)/)) {
      if (word) spans.push(el('span', { ...run.style, whiteSpace: 'pre' }, word));
    }
  }
  return spans;
}

function inlineRow(nodes, style = {}) {
  const spans = wordSpans(inlineRuns(nodes));
  return el('div', { display: 'flex', flexWrap: 'wrap', ...style }, spans.length ? spans : ' ');
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

// A picture (or a video's poster) with its caption, centred. A video that
// cannot play in place (nested in a list or quote) gets a ▶ before its caption.
function figure(node, ctx, { play = false } = {}) {
  const isVideo = node.type === 'mediaVideo';
  const picture = isVideo ? ctx.poster?.(node.attrs.assetId) : ctx.image?.(node.attrs.assetId);
  if (!picture) return null;
  const { width, height } = mediaBox(picture, node.attrs.size);
  const children = [{
    type: 'img',
    props: {
      src: picture.src, width, height, style: { width, height, borderRadius: 12, objectFit: 'cover' },
    },
  }];
  const caption = [isVideo && !play ? '▶' : '', node.attrs.caption || ''].filter(Boolean).join(' ');
  if (caption) {
    children.push(el('div', {
      display: 'flex', justifyContent: 'center', textAlign: 'center', marginTop: CAPTION_GAP,
      fontSize: 26, lineHeight: 1.3, color: THEME.muted, maxWidth: CONTENT_WIDTH,
    }, caption));
  }
  return el('div', {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    width: '100%', margin: `${MEDIA_MARGIN}px 0`,
  }, children);
}

function listBlock(node, ctx, depth) {
  const ordered = node.type === 'orderedList';
  const start = node.attrs?.start || 1;
  const items = (node.content || []).map((item, index) => {
    const marker = ordered ? `${start + index}.` : depth % 2 ? '◦' : '•';
    const body = blocks(item.content, ctx, depth + 1, { tight: true });
    return el('div', { display: 'flex', marginBottom: 8 }, [
      el('div', {
        width: ordered ? 56 : 40, flexShrink: 0, color: THEME.accent, fontWeight: 700,
      }, marker),
      el('div', { display: 'flex', flexDirection: 'column', flex: 1 }, body.length ? body : ' '),
    ]);
  });
  return el('div', { display: 'flex', flexDirection: 'column', marginBottom: depth ? 0 : GAP }, items.length ? items : ' ');
}

function tableBlock(node, ctx) {
  const rows = (node.content || []).map((row, r) => el('div', {
    display: 'flex',
    borderBottom: `${r === 0 ? 2 : 1}px solid ${THEME.rule}`,
    padding: '8px 0',
  }, (row.content || []).map((cell) => {
    const header = cell.type === 'tableHeader';
    const body = blocks(cell.content, ctx, 1, { tight: true });
    return el('div', {
      display: 'flex', flexDirection: 'column', flex: 1, paddingRight: 16,
      ...(header ? { fontWeight: 700, color: THEME.strong } : {}),
    }, body.length ? body : ' ');
  })));
  return el('div', { display: 'flex', flexDirection: 'column', marginBottom: GAP }, rows.length ? rows : ' ');
}

function blocks(nodes = [], ctx = {}, depth = 0, { tight = false } = {}) {
  const out = [];
  const gap = tight ? 4 : GAP;
  for (const node of nodes) {
    switch (node.type) {
      case 'heading':
        out.push(inlineRow(node.content, HEADING[node.attrs?.level] || HEADING[3]));
        break;
      case 'paragraph':
        out.push(inlineRow(node.content, { marginBottom: gap }));
        break;
      case 'bulletList':
      case 'orderedList':
        out.push(listBlock(node, ctx, depth));
        break;
      case 'blockquote':
        out.push(el('div', {
          display: 'flex',
          flexDirection: 'column',
          borderLeft: `6px solid ${THEME.accent}`,
          paddingLeft: 26,
          color: THEME.muted,
          marginBottom: gap,
        }, blocks(node.content, ctx, depth + 1, { tight: true })));
        break;
      case 'horizontalRule':
        out.push(el('div', { height: 2, backgroundColor: THEME.rule, margin: '14px 0 30px' }));
        break;
      case 'codeBlock': {
        const text = (node.content || []).map((t) => t.text || '').join('');
        out.push(el('div', {
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: THEME.codeBg,
          borderRadius: 12,
          padding: '16px 22px',
          fontSize: 28,
          marginBottom: gap,
        }, text.split('\n').map((line) => el('span', { whiteSpace: 'pre' }, line || ' '))));
        break;
      }
      case 'table':
        out.push(tableBlock(node, ctx));
        break;
      case 'mediaImage':
      case 'mediaVideo': {
        const fig = figure(node, ctx);
        if (fig) out.push(fig);
        break;
      }
      default:
        if (node.content?.length) out.push(...blocks(node.content, ctx, depth, { tight }));
    }
  }
  return out;
}

function page(children, { top, bottom }) {
  return el('div', {
    display: 'flex',
    flexDirection: 'column',
    width: SLIDE_WIDTH,
    padding: `${top}px ${PAD_X}px ${bottom}px`,
    color: THEME.text,
    fontFamily: 'Inter',
    fontSize: BASE_FONT,
    lineHeight: 1.42,
  }, children.length ? children : ' ');
}

// A run of ordinary blocks as one page piece. `first`/`last` add the page's
// own top/bottom padding.
export function flowTree(nodes, ctx = {}, { first = false, last = false } = {}) {
  return page(blocks(nodes, ctx), { top: first ? PAD_Y : 0, bottom: last ? PAD_Y : 0 });
}

// A top-level video as its own page piece: its poster where the video will
// play, and the caption. Returns the tree plus where the box sits within the
// piece, so the encoder can lay the playing video exactly over the poster.
export function videoTree(node, ctx = {}, { first = false, last = false } = {}) {
  const poster = ctx.poster?.(node.attrs.assetId);
  if (!poster) return null;
  const box = mediaBox(poster, node.attrs.size);
  const top = (first ? PAD_Y : 0) + MEDIA_MARGIN;
  return {
    tree: page([figure(node, ctx, { play: true })], { top: first ? PAD_Y : 0, bottom: last ? PAD_Y : 0 }),
    box: {
      x: Math.round((SLIDE_WIDTH - box.width) / 2), y: top, width: box.width, height: box.height,
      // What should be centred on screen while it plays: the video and its caption.
      focus: box.height + (node.attrs.caption ? CAPTION_GAP + CAPTION_LINE : 0),
    },
  };
}

// The bottom-right chip: «1/3 · Заголовок». A whole transparent frame, laid
// over the article. null when there is nothing worth saying (a lone untitled
// article).
export function indicatorTree({ index, total, title }) {
  const name = String(title || '').trim();
  const parts = [];
  if (total > 1) parts.push(`${index}/${total}`);
  if (name) parts.push(name.length > 48 ? `${name.slice(0, 47)}…` : name);
  if (!parts.length) return null;
  return el('div', {
    display: 'flex',
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    padding: '0 40px 34px 0',
    fontFamily: 'Inter',
  }, [el('div', {
    display: 'flex',
    backgroundColor: THEME.chip,
    color: THEME.strong,
    fontSize: 26,
    padding: '10px 18px',
    borderRadius: 8,
  }, parts.join(' · '))]);
}
