import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-'));
process.env.DATA_DIR = DATA_DIR;

const {
  Articles, Assets, MEDIA_DIRS, ensureMediaDirs, sweepOrphans, sweepUnusedAssets, sweepAbandonedArticles, uploadKind,
  validateArticleFields, validateOrder, LIMITS, mediaUsage,
} = await import('../../src/media/store.js');

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const img = (assetId) => ({ type: 'mediaImage', attrs: { assetId, size: 'full', caption: '' } });
const doc = (...content) => ({ type: 'doc', content });

// An asset with a real file behind it.
function asset(articleId, kind = 'image', extra = {}) {
  ensureMediaDirs();
  const created = Assets.create({ article_id: articleId, kind, status: 'ready', ...extra });
  const file = `${created.id}.${kind === 'image' ? 'jpg' : 'mp4'}`;
  fs.writeFileSync(path.join(MEDIA_DIRS.files, file), 'x');
  const thumb = kind === 'video' ? `${created.id}.jpg` : null;
  if (thumb) fs.writeFileSync(path.join(MEDIA_DIRS.thumbs, thumb), 'x');
  return Assets.update(created.id, { file, thumb });
}
const onDisk = (a) => fs.existsSync(path.join(MEDIA_DIRS.files, a.file));

test('uploads are recognised by MIME type, or by extension when the browser sends none', () => {
  assert.equal(uploadKind('image/jpeg', 'a.jpg'), 'image');
  assert.equal(uploadKind('video/mp4', 'a.mp4'), 'video');
  assert.equal(uploadKind('', 'клип.MKV'), 'video');
  assert.equal(uploadKind('image/gif', 'a.gif'), null);
  assert.equal(uploadKind('application/pdf', 'doc.pdf'), null);
});

test('article fields are validated, and the document is cleaned', () => {
  const { value } = validateArticleFields({ title: '  Как   настроить ', doc: doc(p('Привет')), seconds: 20, scroll_speed: 60 });
  assert.equal(value.title, 'Как настроить');
  assert.equal(value.doc.content[0].content[0].text, 'Привет');
  assert.equal(value.seconds, 20);
  // A new article without a document starts with an empty one.
  assert.equal(validateArticleFields({}).value.doc.type, 'doc');
  assert.match(validateArticleFields({ doc: { type: 'nope' } }).error, /document/);
  assert.match(validateArticleFields({ seconds: 1 }, { partial: true }).error, /seconds/);
  assert.match(validateArticleFields({ scroll_speed: 999 }, { partial: true }).error, /scroll speed/);
  assert.deepEqual(validateArticleFields({ seconds: 30 }, { partial: true }).value, { seconds: 30 });
  assert.equal(validateArticleFields({ title: 'x'.repeat(500) }).value.title.length, LIMITS.titleChars);
});

test('a reorder must name every article exactly once', () => {
  assert.deepEqual(validateOrder(['b', 'a'], ['a', 'b']).value, ['b', 'a']);
  assert.ok(validateOrder(['a'], ['a', 'b']).error);
  assert.ok(validateOrder(['a', 'a'], ['a', 'b']).error);
  assert.ok(validateOrder('a,b', ['a', 'b']).error);
});

test('articles are stored in order', () => {
  const a = Articles.create({ title: 'A' });
  const b = Articles.create({ title: 'B' });
  Articles.reorder([b.id, a.id]);
  assert.deepEqual(Articles.all().map((x) => x.title), ['B', 'A']);
  Articles.remove(a.id);
  Articles.remove(b.id);
});

test('saving an article deletes the files it no longer uses', () => {
  const article = Articles.create();
  const keep = asset(article.id);
  const drop = asset(article.id);
  Articles.update(article.id, { doc: doc(img(keep.id), img(drop.id)) });
  assert.ok(onDisk(keep) && onDisk(drop));

  Articles.update(article.id, { doc: doc(img(keep.id)) });
  assert.equal(Assets.get(drop.id), null);
  assert.equal(onDisk(drop), false);
  assert.ok(onDisk(keep));
  Articles.remove(article.id);
});

test('deleting an article deletes its files, except ones another article uses', () => {
  const a = Articles.create();
  const b = Articles.create();
  const own = asset(a.id, 'video');
  const shared = asset(a.id);
  Articles.update(a.id, { doc: doc(img(own.id), img(shared.id)) });
  Articles.update(b.id, { doc: doc(img(shared.id)) }); // pasted into another article

  Articles.remove(a.id);
  assert.equal(Assets.get(own.id), null);
  assert.equal(onDisk(own), false);
  assert.equal(fs.existsSync(path.join(MEDIA_DIRS.thumbs, own.thumb)), false, 'the video poster goes too');
  assert.ok(Assets.get(shared.id) && onDisk(shared), 'still shown in the other article');
  Articles.remove(b.id);
});

test('an upload nobody saved into an article is swept once it is old enough', () => {
  const article = Articles.create();
  const fresh = asset(article.id);
  assert.equal(sweepUnusedAssets({ minAgeMs: 60_000 }), 0, 'an open editor may still save it');
  assert.equal(sweepUnusedAssets({ minAgeMs: 60_000, now: Date.now() + 120_000 }), 1);
  assert.equal(onDisk(fresh), false);
  Articles.remove(article.id);
});

test('startup sweep drops stray files and fails videos whose upload was lost', () => {
  ensureMediaDirs();
  const article = Articles.create();
  const kept = asset(article.id);
  const stuck = asset(article.id, 'video', { status: 'processing' });
  Articles.update(article.id, { doc: doc(img(kept.id), img(stuck.id)) });
  fs.writeFileSync(path.join(MEDIA_DIRS.files, 'stray.mp4'), 'x');
  fs.writeFileSync(path.join(MEDIA_DIRS.incoming, 'half-uploaded'), 'x');
  fs.mkdirSync(path.join(MEDIA_DIRS.clips, '.work-abc'));

  sweepOrphans();
  assert.equal(fs.existsSync(path.join(MEDIA_DIRS.files, 'stray.mp4')), false);
  assert.ok(onDisk(kept));
  assert.deepEqual(fs.readdirSync(MEDIA_DIRS.incoming), []);
  assert.equal(fs.existsSync(path.join(MEDIA_DIRS.clips, '.work-abc')), false);
  assert.equal(Assets.get(stuck.id).status, 'error');
  Articles.remove(article.id);
});

test('disk usage counts every media file against the quota', () => {
  ensureMediaDirs();
  const before = mediaUsage().used;
  fs.writeFileSync(path.join(MEDIA_DIRS.clips, 'c.mp4'), Buffer.alloc(1000));
  assert.equal(mediaUsage().used - before, 1000);
  assert.ok(mediaUsage().quota > 0);
});

test('a new article left empty and untitled is swept once it is old enough', () => {
  const abandoned = Articles.create();
  const titled = Articles.create({ title: 'Черновик' });
  const written = Articles.create({ doc: doc(p('текст')) });
  assert.equal(sweepAbandonedArticles({ minAgeMs: 60_000 }), 0, 'its editor may still be open');
  assert.equal(sweepAbandonedArticles({ minAgeMs: 60_000, now: Date.now() + 120_000 }), 1);
  assert.equal(Articles.get(abandoned.id), null);
  assert.ok(Articles.get(titled.id) && Articles.get(written.id));
  Articles.remove(titled.id);
  Articles.remove(written.id);
});
