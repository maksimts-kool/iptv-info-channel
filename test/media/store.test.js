import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-'));
process.env.DATA_DIR = DATA_DIR;

const {
  MediaItems, MEDIA_DIRS, ensureMediaDirs, sweepOrphans, uploadKind, validateItemFields, validateOrder,
  LIMITS, mediaUsage,
} = await import('../../src/media/store.js');

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('uploads are recognised by MIME type, or by extension when the browser sends none', () => {
  assert.equal(uploadKind('image/jpeg', 'a.jpg'), 'image');
  assert.equal(uploadKind('image/webp', 'x'), 'image');
  assert.equal(uploadKind('video/mp4', 'a.mp4'), 'video');
  assert.equal(uploadKind('', 'клип.MKV'), 'video');
  assert.equal(uploadKind('application/octet-stream', 'clip.mov'), 'video');
  assert.equal(uploadKind('image/gif', 'a.gif'), null);
  assert.equal(uploadKind('application/pdf', 'doc.pdf'), null);
});

test('a text slide needs text, within the limits', () => {
  assert.match(validateItemFields('text', { markdown: '   ' }).error, /empty/);
  assert.match(validateItemFields('text', { markdown: 'x'.repeat(LIMITS.markdownChars + 1) }).error, /characters/);
  assert.deepEqual(validateItemFields('text', { markdown: '# Hi', seconds: 20, scroll_speed: 60 }).value, {
    markdown: '# Hi', seconds: 20, scroll_speed: 60,
  });
  assert.match(validateItemFields('text', { markdown: 'a', seconds: 1 }).error, /seconds/);
  assert.match(validateItemFields('text', { markdown: 'a', seconds: 2.5 }).error, /seconds/);
  assert.match(validateItemFields('text', { markdown: 'a', scroll_speed: 500 }).error, /scroll speed/);
});

test('a partial edit validates only what it sends, and only what the type has', () => {
  assert.deepEqual(validateItemFields('text', { seconds: 30 }, { partial: true }).value, { seconds: 30 });
  assert.deepEqual(validateItemFields('image', { caption: '  Подпись   два ', seconds: 10 }, { partial: true }).value, {
    caption: 'Подпись два', seconds: 10,
  });
  // A video's length is its own; seconds and captions don't apply to it.
  assert.deepEqual(validateItemFields('video', { seconds: 30, caption: 'x' }, { partial: true }).value, {});
  assert.match(validateItemFields('image', { caption: 'x'.repeat(LIMITS.captionChars + 1) }, { partial: true }).error, /caption/);
});

test('a reorder must name every slide exactly once', () => {
  assert.deepEqual(validateOrder(['b', 'a'], ['a', 'b']).value, ['b', 'a']);
  assert.ok(validateOrder(['a'], ['a', 'b']).error);
  assert.ok(validateOrder(['a', 'a'], ['a', 'b']).error);
  assert.ok(validateOrder(['a', 'c'], ['a', 'b']).error);
  assert.ok(validateOrder('a,b', ['a', 'b']).error);
});

test('slides are stored in order, and deleting one deletes its files', () => {
  ensureMediaDirs();
  const text = MediaItems.create({ type: 'text', markdown: 'a' });
  fs.writeFileSync(path.join(MEDIA_DIRS.files, 'pic.jpg'), 'jpg');
  const image = MediaItems.create({ type: 'image', file: 'pic.jpg' });
  fs.writeFileSync(path.join(MEDIA_DIRS.files, 'vid.mp4'), 'mp4');
  fs.writeFileSync(path.join(MEDIA_DIRS.thumbs, 'vid.jpg'), 'jpg');
  const video = MediaItems.create({ type: 'video', file: 'vid.mp4', thumb: 'vid.jpg', status: 'ready' });

  assert.deepEqual(MediaItems.all().map((i) => i.id), [text.id, image.id, video.id]);
  MediaItems.reorder([video.id, text.id, image.id]);
  assert.deepEqual(MediaItems.all().map((i) => i.id), [video.id, text.id, image.id]);

  MediaItems.remove(video.id);
  assert.equal(fs.existsSync(path.join(MEDIA_DIRS.files, 'vid.mp4')), false);
  assert.equal(fs.existsSync(path.join(MEDIA_DIRS.thumbs, 'vid.jpg')), false);
  assert.equal(fs.existsSync(path.join(MEDIA_DIRS.files, 'pic.jpg')), true, 'other slides keep theirs');
  assert.equal(MediaItems.get(video.id), null);
  MediaItems.remove(image.id);
  MediaItems.remove(text.id);
});

test('startup sweep drops stray files and fails videos whose upload was lost', () => {
  ensureMediaDirs();
  fs.writeFileSync(path.join(MEDIA_DIRS.files, 'stray.mp4'), 'x');
  fs.writeFileSync(path.join(MEDIA_DIRS.incoming, 'half-uploaded'), 'x');
  fs.writeFileSync(path.join(MEDIA_DIRS.files, 'kept.jpg'), 'x');
  const kept = MediaItems.create({ type: 'image', file: 'kept.jpg' });
  const stuck = MediaItems.create({ type: 'video', status: 'processing' });

  sweepOrphans();
  assert.equal(fs.existsSync(path.join(MEDIA_DIRS.files, 'stray.mp4')), false);
  assert.equal(fs.existsSync(path.join(MEDIA_DIRS.files, 'kept.jpg')), true);
  assert.deepEqual(fs.readdirSync(MEDIA_DIRS.incoming), []);
  assert.equal(MediaItems.get(stuck.id).status, 'error');
  MediaItems.remove(kept.id);
  MediaItems.remove(stuck.id);
});

test('disk usage counts every media file against the quota', () => {
  ensureMediaDirs();
  const before = mediaUsage().used;
  fs.writeFileSync(path.join(MEDIA_DIRS.clips, 'c.mp4'), Buffer.alloc(1000));
  assert.equal(mediaUsage().used - before, 1000);
  assert.ok(mediaUsage().quota > 0);
});
