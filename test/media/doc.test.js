import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeDoc, docAssetIds, docHasContent, docSummary, docSections, emptyDoc, DOC_MAX_BYTES,
  filterPrivate, privateSections,
} from '../../src/media/doc.js';

const t = (text, ...marks) => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });
const p = (...content) => ({ type: 'paragraph', content });
const img = (assetId, extra = {}) => ({ type: 'mediaImage', attrs: { assetId, size: 'half', caption: 'Фото', ...extra } });
const vid = (assetId) => ({ type: 'mediaVideo', attrs: { assetId, size: 'full', caption: '' } });

test('a document keeps exactly what the TV can draw', () => {
  const { value } = sanitizeDoc({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 7, id: 'x' }, content: [t('Заголовок')] },
      p(t('жирный', 'bold'), t(' и подчёркнутый', 'underline', 'italic'), { type: 'hardBreak' }),
      { type: 'orderedList', attrs: { start: '3' }, content: [{ type: 'listItem', content: [p(t('пункт'))] }] },
      img('abc123def456', { size: 'gigantic', caption: `  ${'x'.repeat(300)} ` }),
      { type: 'iframe', attrs: { src: 'http://evil' } },
      { type: 'details', content: [p(t('внутри неизвестного блока'))] },
      { type: 'mediaImage', attrs: { assetId: '../../etc/passwd' } },
    ],
  });
  const [heading, para, list, image, ...rest] = value.content;
  assert.deepEqual(heading.attrs, { level: 3 }, 'level clamped, unknown attrs dropped');
  assert.deepEqual(para.content[1].marks, [{ type: 'italic' }], 'only drawable marks survive');
  assert.equal(para.content[2].type, 'hardBreak');
  assert.deepEqual(list.attrs, { start: 3 });
  assert.equal(image.attrs.size, 'full', 'an unknown size falls back to full');
  assert.equal(image.attrs.caption.length, 200);
  // The iframe is gone, the unknown wrapper keeps its text, a bad asset id is dropped.
  assert.equal(rest.length, 1);
  assert.equal(rest[0].type, 'paragraph');
  assert.equal(JSON.stringify(rest[0]).includes('внутри'), true);
});

test('anything that is not a document, or is too big, is refused', () => {
  assert.ok(sanitizeDoc(null).error);
  assert.ok(sanitizeDoc({ type: 'paragraph' }).error);
  const huge = { type: 'doc', content: [p(t('x'.repeat(DOC_MAX_BYTES)))] };
  assert.match(sanitizeDoc(huge).error, /too long/);
});

test('asset ids are listed once each, in document order, wherever they are nested', () => {
  const doc = {
    type: 'doc',
    content: [
      img('img111111'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [vid('vid222222')] }] },
      img('img111111'),
      vid('vid333333'),
    ],
  };
  assert.deepEqual(docAssetIds(doc), ['img111111', 'vid222222', 'vid333333']);
});

test('an article is empty until it has text or media', () => {
  assert.equal(docHasContent(emptyDoc()), false);
  assert.equal(docHasContent({ type: 'doc', content: [p(t('   '))] }), false);
  assert.equal(docHasContent({ type: 'doc', content: [p(t('Привет'))] }), true);
  assert.equal(docHasContent({ type: 'doc', content: [img('img111111')] }), true);
});

test('the summary is the first text in the article', () => {
  const doc = { type: 'doc', content: [img('img111111'), { type: 'heading', attrs: { level: 1 }, content: [t('Как '), t('настроить', 'bold')] }] };
  assert.equal(docSummary(doc), 'Как настроить');
  assert.equal(docSummary(emptyDoc()), '');
});

test('an article is split at its top-level videos', () => {
  const doc = {
    type: 'doc',
    content: [p(t('до')), vid('vid111111'), vid('vid222222'), p(t('после')), { type: 'blockquote', content: [vid('vid333333')] }],
  };
  assert.deepEqual(docSections(doc).map((s) => s.kind), ['flow', 'video', 'video', 'flow']);
  // A video nested in a quote stays in its flow (shown as a still).
  assert.equal(docSections(doc)[3].nodes.length, 2);
});

const priv = (audience, ...content) => ({ type: 'privateSection', attrs: { audience }, content });

test('a private section keeps its audience; one nested in another is spliced into it', () => {
  const { value } = sanitizeDoc({
    type: 'doc',
    content: [
      priv({ users: ['4', 4], plans: ['pro'], extra: 1 }, p(t('для своих')), priv({ users: [9] }, p(t('вложенный')))),
      priv(null, p(t('без аудитории'))),
      priv({ users: [1] }),
    ],
  });
  const [first, second, ...rest] = value.content;
  assert.deepEqual(first.attrs, { audience: { users: [4], plans: ['pro'] } });
  assert.deepEqual(first.content.map((n) => n.type), ['paragraph', 'paragraph'], 'the inner section is unwrapped');
  assert.deepEqual(second.attrs.audience, { users: [], plans: [] }, 'a missing audience is nobody');
  assert.equal(rest.length, 0, 'an empty section is dropped');
});

test('private sections are unwrapped for members and removed for everyone else', () => {
  const doc = {
    type: 'doc',
    content: [
      p(t('для всех')),
      priv({ users: [1], plans: [] }, p(t('секрет')), vid('vid111111')),
      { type: 'blockquote', content: [priv({ users: [2], plans: [] }, p(t('цитата')))] },
    ],
  };
  const member = filterPrivate(doc, (aud) => aud.users.includes(1));
  assert.deepEqual(member.content.map((n) => n.type), ['paragraph', 'paragraph', 'mediaVideo', 'blockquote']);
  assert.deepEqual(member.content[3].content, [], 'a section deeper down is resolved too');
  // Unwrapped, a video inside a section is a top-level video like any other.
  assert.deepEqual(docSections(member).map((s) => s.kind), ['flow', 'video', 'flow']);
  const outsider = filterPrivate(doc, () => false);
  assert.deepEqual(outsider.content.map((n) => n.type), ['paragraph', 'blockquote']);
  assert.equal(JSON.stringify(outsider).includes('секрет'), false);
  assert.equal(privateSections(doc).length, 2);
  assert.equal(docHasContent(filterPrivate({ type: 'doc', content: [priv({ users: [1] }, p(t('x')))] }, () => false)), false);
});
