import test from 'node:test';
import assert from 'node:assert/strict';
import { isHlsUrl, rewriteHlsManifest } from '../../src/playlist/hls.js';

const BASE = 'http://provider.example/live/user/pass/123/index.m3u8';

test('isHlsUrl looks past the query string', () => {
  assert.equal(isHlsUrl('http://p/live/1.m3u8'), true);
  assert.equal(isHlsUrl('http://p/live/1.m3u8?token=abc&x=1'), true);
  assert.equal(isHlsUrl('http://p/live/1.M3U8#frag'), true);
  // Raw MPEG-TS and extensionless Xtream links have no manifest to rewrite.
  assert.equal(isHlsUrl('http://p/live/user/pass/1.ts'), false);
  assert.equal(isHlsUrl('http://p/live/user/pass/1'), false);
  assert.equal(isHlsUrl(''), false);
  assert.equal(isHlsUrl(undefined), false);
});

test('relative segments become absolute provider URLs', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.000,',
    'seg_001.ts',
    '#EXTINF:6.000,',
    '../shared/seg_002.ts',
    '#EXTINF:6.000,',
    '/abs/seg_003.ts?token=xyz',
  ].join('\n');

  assert.deepEqual(rewriteHlsManifest(manifest, BASE).split('\n'), [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.000,',
    'http://provider.example/live/user/pass/123/seg_001.ts',
    '#EXTINF:6.000,',
    'http://provider.example/live/user/pass/shared/seg_002.ts',
    '#EXTINF:6.000,',
    'http://provider.example/abs/seg_003.ts?token=xyz',
  ]);
});

test('URIs inside tags are rewritten too — a relative key URI would 404', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:6.000,',
    'seg_001.ts',
  ].join('\n');

  const out = rewriteHlsManifest(manifest, BASE);
  assert.match(out, /URI="http:\/\/provider\.example\/live\/user\/pass\/123\/key\.bin"/);
  assert.match(out, /METHOD=AES-128,URI="[^"]+",IV=0x0/, 'the rest of the tag is untouched');
  assert.match(out, /URI="http:\/\/provider\.example\/live\/user\/pass\/123\/init\.mp4"/);
});

test('a master playlist has its variants absolutised the same way', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ru",URI="audio/ru.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    'hi/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000',
    'lo/index.m3u8',
  ].join('\n');

  const out = rewriteHlsManifest(manifest, BASE);
  assert.match(out, /^http:\/\/provider\.example\/live\/user\/pass\/123\/hi\/index\.m3u8$/m);
  assert.match(out, /^http:\/\/provider\.example\/live\/user\/pass\/123\/lo\/index\.m3u8$/m);
  assert.match(out, /URI="http:\/\/provider\.example\/live\/user\/pass\/123\/audio\/ru\.m3u8"/);
});

test('already absolute URIs and blank lines survive unchanged', () => {
  const manifest = [
    '#EXTM3U',
    '',
    '#EXTINF:6.000,',
    'https://cdn.example/edge/seg_001.ts?sig=abc',
    '',
  ].join('\r\n');

  assert.deepEqual(rewriteHlsManifest(manifest, BASE).split('\n'), [
    '#EXTM3U',
    '',
    '#EXTINF:6.000,',
    'https://cdn.example/edge/seg_001.ts?sig=abc',
    '',
  ]);
});

test('an unparseable line is passed through rather than losing the channel', () => {
  const out = rewriteHlsManifest('#EXTM3U\n:::not a uri:::', 'not-a-base');
  assert.equal(out, '#EXTM3U\n:::not a uri:::');
});
