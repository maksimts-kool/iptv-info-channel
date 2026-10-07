import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { markdownToTree, inlineRuns, THEME, SLIDE_WIDTH } from '../../src/render/markdown.js';

// Every text span in a tree, in order, with the style it was drawn with.
function spans(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') return out;
  const { style = {}, children } = node.props || {};
  if (typeof children === 'string') out.push({ text: children, style, type: node.type });
  else if (Array.isArray(children)) children.forEach((c) => spans(c, out));
  else if (children && typeof children === 'object') spans(children, out);
  return out;
}

const text = (tree) => spans(tree).map((s) => s.text).join('');

// satori refuses a <div> with several children unless it is a flex container.
function assertSatoriSafe(node, where = 'root') {
  if (!node || typeof node !== 'object') return;
  const { style = {}, children } = node.props || {};
  if (node.type === 'div' && Array.isArray(children) && children.length > 1) {
    assert.ok(['flex', 'contents', 'none'].includes(style.display), `${where}: multi-child div without display:flex`);
  }
  if (Array.isArray(children)) children.forEach((c, i) => assertSatoriSafe(c, `${where}.${i}`));
}

test('a page is a full-width column centred within at least one screen', () => {
  const tree = markdownToTree('Привет');
  assert.equal(tree.props.style.width, SLIDE_WIDTH);
  assert.equal(tree.props.style.minHeight, 720);
  assert.equal(tree.props.style.justifyContent, 'center');
  assert.equal(text(tree), 'Привет');
});

test('inline formatting maps onto span styles', () => {
  const runs = inlineRuns(marked.lexer('Это **жирный**, *курсив*, ~~зачёркнутый~~ и `код`')[0].tokens);
  const styleOf = (t) => runs.find((r) => r.text === t)?.style;
  assert.equal(styleOf('жирный').fontWeight, 700);
  assert.equal(styleOf('жирный').color, THEME.strong);
  assert.equal(styleOf('курсив').fontStyle, 'italic');
  assert.equal(styleOf('зачёркнутый').textDecoration, 'line-through');
  assert.equal(styleOf('код').code, true);
});

test('paragraphs wrap word by word, keeping the spaces', () => {
  const tree = markdownToTree('Один два **три четыре**');
  const words = spans(tree);
  assert.deepEqual(words.map((w) => w.text), ['Один ', 'два ', 'три ', 'четыре']);
  assert.equal(words[2].style.fontWeight, 700);
  // The row that holds them wraps.
  const row = tree.props.children[0];
  assert.equal(row.props.style.flexWrap, 'wrap');
});

test('headings, lists, quotes and rules all render, satori-safe', () => {
  const md = [
    '# Заголовок',
    '## Подзаголовок',
    '### Третий',
    '',
    'Абзац с [ссылкой](https://example.com).',
    '',
    '- один',
    '- два',
    '  - вложенный',
    '',
    '3. три',
    '4. четыре',
    '',
    '> цитата',
    '',
    '---',
    '',
    '```',
    'код блок',
    '```',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
  ].join('\n');
  const tree = markdownToTree(md);
  assertSatoriSafe(tree);
  const all = text(tree);
  for (const piece of ['Заголовок', 'Подзаголовок', 'ссылкой', 'вложенный', 'цитата', 'код блок', 'A', '2']) {
    assert.ok(all.includes(piece), `missing ${piece}`);
  }
  // Ordered lists keep their start number; links keep their text, not the URL.
  assert.ok(all.includes('3.') && all.includes('4.'));
  assert.ok(!all.includes('example.com'));
  const h1 = spans(tree).find((s) => s.text.startsWith('Заголовок'));
  const linked = spans(tree).find((s) => s.text.startsWith('ссылкой'));
  assert.equal(linked.style.color, THEME.accent);
  assert.ok(h1);
});

test('a single line break inside a paragraph is kept', () => {
  const tree = markdownToTree('строка один\nстрока два');
  const row = tree.props.children[0];
  const breaker = row.props.children.find((c) => c.props.style.width === '100%');
  assert.ok(breaker, 'a full-width break element splits the lines');
});

test('raw HTML is reduced to its text and entities are decoded', () => {
  const all = text(markdownToTree('<b>жирный</b> & <i>курсив</i> "кавычки"'));
  assert.ok(all.includes('жирный'));
  assert.ok(all.includes('&'));
  assert.ok(all.includes('"кавычки"'));
  assert.ok(!all.includes('<b>'));
});

test('empty text still produces a valid page', () => {
  const tree = markdownToTree('');
  assertSatoriSafe(tree);
  assert.equal(tree.props.children, ' ');
});
