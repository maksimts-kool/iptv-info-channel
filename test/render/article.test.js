import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flowTree, videoTree, indicatorTree, inlineRuns, mediaBox, THEME, SLIDE_WIDTH, PAD_Y,
  MAX_MEDIA_HEIGHT, MEDIA_WIDTHS, MEDIA_MARGIN,
} from '../../src/render/article.js';

const t = (text, ...marks) => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });
const p = (...content) => ({ type: 'paragraph', content });

// Every text span in a tree, in order, with the style it was drawn with.
function spans(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  const { style = {}, children } = node.props || {};
  if (typeof children === 'string') out.push({ text: children, style, type: node.type });
  else if (Array.isArray(children)) children.forEach((c) => spans(c, out));
  return out;
}
const text = (tree) => spans(tree).map((s) => s.text).join('');
function find(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  const { children } = node.props || {};
  for (const c of Array.isArray(children) ? children : []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

// satori refuses a <div> with several children unless it is a flex container.
function assertSatoriSafe(node, where = 'root') {
  if (!node || typeof node !== 'object') return;
  const { style = {}, children } = node.props || {};
  if (node.type === 'div' && Array.isArray(children) && children.length > 1) {
    assert.ok(['flex', 'contents', 'none'].includes(style.display), `${where}: multi-child div without display:flex`);
  }
  if (Array.isArray(children)) children.forEach((c, i) => assertSatoriSafe(c, `${where}.${i}`));
}

const ctx = {
  image: (id) => (id === 'img1' ? { src: 'data:image/jpeg;base64,AA', width: 1600, height: 900 } : null),
  poster: (id) => (id === 'vid1' ? { src: 'data:image/jpeg;base64,BB', width: 1280, height: 720 } : null),
};

test('marks map onto span styles', () => {
  const runs = inlineRuns([t('a', 'bold'), t('b', 'italic'), t('c', 'strike'), t('d', 'code')]);
  assert.equal(runs[0].style.fontWeight, 700);
  assert.equal(runs[0].style.color, THEME.strong);
  assert.equal(runs[1].style.fontStyle, 'italic');
  assert.equal(runs[2].style.textDecoration, 'line-through');
  assert.equal(runs[3].code, true);
});

test('paragraphs wrap word by word, keeping the spaces', () => {
  const tree = flowTree([p(t('Один два '), t('три четыре', 'bold'))]);
  const words = spans(tree);
  assert.deepEqual(words.map((w) => w.text), ['Один ', 'два ', 'три ', 'четыре']);
  assert.equal(words[2].style.fontWeight, 700);
});

test('every block type renders, satori-safe, and only the first/last piece get page padding', () => {
  const nodes = [
    { type: 'heading', attrs: { level: 1 }, content: [t('Заголовок')] },
    p(t('строка'), { type: 'hardBreak' }, t('вторая')),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('пункт')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('вложенный'))] }] }] }] },
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('три'))] }] },
    { type: 'blockquote', content: [p(t('цитата'))] },
    { type: 'horizontalRule' },
    { type: 'codeBlock', content: [t('код\nблок')] },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('A'))] }, { type: 'tableHeader', content: [p(t('B'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('1'))] }, { type: 'tableCell', content: [p(t('2'))] }] },
      ],
    },
    { type: 'mediaImage', attrs: { assetId: 'img1', size: 'half', caption: 'Подпись' } },
    { type: 'mediaImage', attrs: { assetId: 'missing', size: 'full', caption: 'не загружено' } },
  ];
  const tree = flowTree(nodes, ctx, { first: true });
  assertSatoriSafe(tree);
  const all = text(tree);
  for (const piece of ['Заголовок', 'вторая', 'вложенный', '3.', 'цитата', 'блок', 'A', '2', 'Подпись']) {
    assert.ok(all.includes(piece), `missing ${piece}`);
  }
  assert.ok(!all.includes('не загружено'), 'a picture that is not there is left out with its caption');
  assert.match(tree.props.style.padding, new RegExp(`^${PAD_Y}px .* 0px$`));
  const picture = find(tree, (n) => n.type === 'img');
  assert.equal(picture.props.width, MEDIA_WIDTHS.half);
  assert.equal(picture.props.height, Math.round(MEDIA_WIDTHS.half * 9 / 16));
});

test('media boxes keep the aspect ratio and a portrait one narrows instead of growing', () => {
  assert.deepEqual(mediaBox({ width: 1920, height: 1080 }, 'half'), { width: MEDIA_WIDTHS.half, height: Math.round(MEDIA_WIDTHS.half * 9 / 16) });
  // Full width at 16:9 would be taller than fits on screen with its caption.
  assert.deepEqual(mediaBox({ width: 1920, height: 1080 }, 'full'), { width: Math.round(MAX_MEDIA_HEIGHT * 16 / 9), height: MAX_MEDIA_HEIGHT });
  const portrait = mediaBox({ width: 1080, height: 1920 }, 'full');
  assert.equal(portrait.height, MAX_MEDIA_HEIGHT);
  assert.equal(portrait.width, Math.round(MAX_MEDIA_HEIGHT * 1080 / 1920));
  assert.equal(mediaBox(null, 'small').width, MEDIA_WIDTHS.small);
});

test('a video piece reports exactly where its box sits, centred', () => {
  const node = { type: 'mediaVideo', attrs: { assetId: 'vid1', size: 'full', caption: 'Инструкция' } };
  const first = videoTree(node, ctx, { first: true });
  assertSatoriSafe(first.tree);
  assert.equal(first.box.height, MAX_MEDIA_HEIGHT);
  assert.equal(first.box.x, Math.round((SLIDE_WIDTH - first.box.width) / 2));
  assert.equal(first.box.y, PAD_Y + MEDIA_MARGIN);
  assert.ok(first.box.focus > first.box.height, 'the caption is centred with the video');
  assert.equal(videoTree(node, ctx).box.y, MEDIA_MARGIN);
  // Not processed yet (no poster): nothing to place.
  assert.equal(videoTree({ ...node, attrs: { ...node.attrs, assetId: 'vid2' } }, ctx), null);
});

test('the corner chip reads «1/3 · title», and says nothing when there is nothing to say', () => {
  assert.equal(text(indicatorTree({ index: 1, total: 3, title: 'Как настроить' })), '1/3 · Как настроить');
  assert.equal(text(indicatorTree({ index: 2, total: 2, title: '' })), '2/2');
  assert.equal(text(indicatorTree({ index: 1, total: 1, title: 'Одна' })), 'Одна');
  assert.equal(indicatorTree({ index: 1, total: 1, title: '' }), null);
  const long = text(indicatorTree({ index: 1, total: 2, title: 'x'.repeat(80) }));
  assert.ok(long.endsWith('…') && long.length < 60);
});
