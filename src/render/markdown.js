// Markdown -> a satori element tree for one text slide of the media channel.
//
// Pure: no I/O, no fonts — `marked` tokenises the Markdown and this module only
// maps its tokens onto satori's flexbox elements (render/media.js does the
// rasterising). Unit-tested in test/render/markdown.test.js.
//
// One satori quirk shapes the inline code: a <div> with several children must
// be `display: flex`, and satori has no inline formatting context — so a
// paragraph mixing plain, bold and italic text cannot be one block of text.
// Instead every word becomes its own span in a wrapping flex row, which wraps
// at word boundaries exactly like a browser would.
import { marked } from 'marked';

// Logical slide size. Everything is laid out at 1280 wide and scaled to the
// configured channel resolution when rasterised, like the SVGs in overlay.js.
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;

// The account card's palette (render/overlay.js), so a text page looks like
// the rest of the channel.
export const THEME = {
  text: '#dbe4f3',
  strong: '#ffffff',
  muted: '#93a3c0',
  accent: '#38bdf8',
  accent2: '#a5b4fc',
  codeBg: 'rgba(148, 163, 184, 0.18)',
  rule: 'rgba(255, 255, 255, 0.16)',
};

const BASE_FONT = 34;
const PAD_X = 96;
const PAD_Y = 72;

const HEADING = {
  1: { fontSize: 60, fontWeight: 700, color: THEME.strong, marginBottom: 22 },
  2: { fontSize: 46, fontWeight: 700, color: THEME.accent, marginBottom: 18 },
  3: { fontSize: 38, fontWeight: 600, color: THEME.accent2, marginBottom: 14 },
};

function el(type, style, children) {
  return { type, props: { style, children } };
}

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

// Flatten marked's inline tokens into styled runs: [{ text, style }] or the
// special { br: true } for a hard line break.
export function inlineRuns(tokens = [], style = {}) {
  const runs = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
        runs.push(...inlineRuns(token.tokens, { ...style, fontWeight: 700, color: THEME.strong }));
        break;
      case 'em':
        runs.push(...inlineRuns(token.tokens, { ...style, fontStyle: 'italic' }));
        break;
      case 'del':
        runs.push(...inlineRuns(token.tokens, { ...style, textDecoration: 'line-through' }));
        break;
      case 'link':
        runs.push(...inlineRuns(token.tokens, { ...style, color: THEME.accent }));
        break;
      case 'codespan':
        runs.push({ text: unescape(token.text), style: { ...style, code: true } });
        break;
      case 'br':
        runs.push({ br: true });
        break;
      case 'image':
        // A TV slide can't fetch an image from a URL in the text; the alt text
        // keeps the sentence readable. Images are their own slides.
        if (token.text) runs.push({ text: token.text, style });
        break;
      case 'text':
        if (token.tokens?.length) runs.push(...inlineRuns(token.tokens, style));
        else runs.push({ text: unescape(token.text), style });
        break;
      case 'html':
        runs.push({ text: unescape(String(token.text).replace(/<[^>]*>/g, '')), style });
        break;
      default:
        if (token.tokens?.length) runs.push(...inlineRuns(token.tokens, style));
        else if (token.text) runs.push({ text: unescape(token.text), style });
    }
  }
  return runs;
}

// marked hands back entities for &, <, > and quotes inside text tokens.
function unescape(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Split runs into one span per word (trailing whitespace kept on the word), so
// a wrapping flex row breaks lines between words. Inline code stays one chip.
function wordSpans(runs) {
  const spans = [];
  for (const run of runs) {
    if (run.br) {
      // A zero-height full-width box forces the following words onto a new line.
      spans.push(el('div', { width: '100%', height: 0 }));
      continue;
    }
    const { code, ...style } = run.style || {};
    if (code) {
      spans.push(el('span', {
        ...style,
        whiteSpace: 'pre',
        backgroundColor: THEME.codeBg,
        borderRadius: 6,
        padding: '0 8px',
        margin: '0 4px',
      }, run.text));
      continue;
    }
    const text = run.text.replace(/\s*\n\s*/g, ' ');
    for (const word of text.split(/(?<=\s)/)) {
      if (word) spans.push(el('span', { ...style, whiteSpace: 'pre' }, word));
    }
  }
  return spans;
}

function inlineRow(tokens, style = {}) {
  const spans = wordSpans(inlineRuns(tokens));
  return el('div', { display: 'flex', flexWrap: 'wrap', ...style }, spans.length ? spans : ' ');
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function listBlock(token, depth) {
  const start = Number(token.start) || 1;
  const items = token.items.map((item, index) => {
    const marker = token.ordered ? `${start + index}.` : depth % 2 ? '◦' : '•';
    const body = blocks(item.tokens, depth + 1, { tight: true });
    return el('div', { display: 'flex', marginBottom: 8 }, [
      el('div', {
        width: token.ordered ? 56 : 40, flexShrink: 0, color: THEME.accent, fontWeight: 700,
      }, marker),
      el('div', { display: 'flex', flexDirection: 'column', flex: 1 }, body.length ? body : ' '),
    ]);
  });
  return el('div', { display: 'flex', flexDirection: 'column', marginBottom: depth ? 0 : 18 }, items);
}

function blocks(tokens = [], depth = 0, { tight = false } = {}) {
  const out = [];
  const gap = tight ? 4 : 18;
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        out.push(inlineRow(token.tokens, HEADING[Math.min(3, token.depth)] || HEADING[3]));
        break;
      case 'paragraph':
        out.push(inlineRow(token.tokens, { marginBottom: gap }));
        break;
      case 'text':
        // A tight list item's text arrives as a bare `text` block.
        out.push(inlineRow(token.tokens || [{ type: 'text', text: token.text }], { marginBottom: gap }));
        break;
      case 'list':
        out.push(listBlock(token, depth));
        break;
      case 'blockquote':
        out.push(el('div', {
          display: 'flex',
          flexDirection: 'column',
          borderLeft: `6px solid ${THEME.accent}`,
          paddingLeft: 26,
          color: THEME.muted,
          marginBottom: gap,
        }, blocks(token.tokens, depth, { tight: true })));
        break;
      case 'hr':
        out.push(el('div', { height: 2, backgroundColor: THEME.rule, margin: '14px 0 30px' }));
        break;
      case 'code':
        out.push(el('div', {
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: THEME.codeBg,
          borderRadius: 12,
          padding: '16px 22px',
          fontSize: 28,
          marginBottom: gap,
        }, String(token.text).split('\n').map((line) => el('span', { whiteSpace: 'pre' }, line || ' '))));
        break;
      case 'table': {
        const row = (cells, style) => el('div', { display: 'flex', ...style }, cells.map(
          (cell) => inlineRow(cell.tokens, { flex: 1, paddingRight: 16 }),
        ));
        out.push(el('div', { display: 'flex', flexDirection: 'column', marginBottom: gap }, [
          row(token.header, { fontWeight: 700, color: THEME.strong, borderBottom: `2px solid ${THEME.rule}`, paddingBottom: 6 }),
          ...token.rows.map((cells) => row(cells, { borderBottom: `1px solid ${THEME.rule}`, padding: '6px 0' })),
        ]));
        break;
      }
      case 'html': {
        const text = unescape(String(token.text).replace(/<[^>]*>/g, '')).trim();
        if (text) out.push(inlineRow([{ type: 'text', text }], { marginBottom: gap }));
        break;
      }
      case 'space':
        break;
      default:
        if (token.tokens?.length) out.push(inlineRow(token.tokens, { marginBottom: gap }));
    }
  }
  return out;
}

// The whole page: a transparent column 1280 wide whose height follows the
// content — render/media.js decides whether that fits one screen or scrolls.
// Short pages are centred vertically within one screen (`minHeight`).
export function markdownToTree(markdown) {
  const tokens = marked.lexer(String(markdown ?? ''), { gfm: true, breaks: true });
  const body = blocks(tokens);
  return el('div', {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    width: SLIDE_WIDTH,
    minHeight: SLIDE_HEIGHT,
    padding: `${PAD_Y}px ${PAD_X}px`,
    color: THEME.text,
    fontFamily: 'Inter',
    fontSize: BASE_FONT,
    lineHeight: 1.42,
  }, body.length ? body : ' ');
}
