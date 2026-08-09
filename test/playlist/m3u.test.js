import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, buildM3u, parseExtinf, parseAttrs } from '../../src/playlist/m3u.js';

test('parseAttrs reads quoted and bare values', () => {
  assert.deepEqual(
    parseAttrs('tvg-id="x1" tvg-logo="http://a/b.png?w=1" radio=true'),
    { 'tvg-id': 'x1', 'tvg-logo': 'http://a/b.png?w=1', radio: 'true' },
  );
});

test('parseExtinf splits the title at the last comma OUTSIDE quotes', () => {
  // A naive lastIndexOf(',') would cut inside tvg-name and lose the real title.
  const parsed = parseExtinf('-1 tvg-id="a" tvg-name="News, Sport и всё" group-title="Микс",Первый канал');
  assert.equal(parsed.title, 'Первый канал');
  assert.equal(parsed.attrs['tvg-name'], 'News, Sport и всё');
  assert.equal(parsed.attrs['group-title'], 'Микс');
  assert.equal(parsed.duration, '-1');
});

test('parseM3u reads the header, groups, extras and channel URLs', () => {
  const { headerAttrs, items, malformed } = parseM3u([
    '﻿#EXTM3U url-tvg="http://p/epg.xml" x-tvg-url="http://p/other.xml"',
    '',
    '# a comment',
    '#EXTINF:-1 tvg-id="s1" tvg-logo="http://p/1.png" group-title="Спорт",Sport 1',
    '#EXTVLCOPT:http-user-agent=VLC',
    '#KODIPROP:inputstream=ffmpeg',
    'http://p/live/1.ts',
    '#EXTINF:-1 tvg-id="n1",News 1',
    '#EXTGRP:Новости',
    'http://p/live/2.ts',
  ].join('\r\n'));

  assert.equal(malformed, 0);
  assert.equal(headerAttrs['url-tvg'], 'http://p/epg.xml');
  assert.equal(items.length, 2);

  assert.deepEqual(items[0].extras, ['#EXTVLCOPT:http-user-agent=VLC', '#KODIPROP:inputstream=ffmpeg']);
  assert.equal(items[0].group, 'Спорт');
  assert.equal(items[0].name, 'Sport 1');
  assert.equal(items[0].url, 'http://p/live/1.ts');

  // #EXTGRP fills in when the attribute form is missing.
  assert.equal(items[1].group, 'Новости');
});

test('a group-title attribute wins over a later #EXTGRP line', () => {
  const { items } = parseM3u([
    '#EXTM3U',
    '#EXTINF:-1 group-title="Кино",Film',
    '#EXTGRP:Другое',
    'http://p/3.ts',
  ].join('\n'));
  assert.equal(items[0].group, 'Кино');
});

test('parseM3u counts #EXTINF entries left without a URL', () => {
  const { items, malformed } = parseM3u([
    '#EXTM3U',
    '#EXTINF:-1,A',
    '#EXTINF:-1,B',
    'http://p/b.ts',
    '#EXTINF:-1,C',
  ].join('\n'));
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'B');
  assert.equal(malformed, 2);
});

test('a bare URL with no #EXTINF is still imported', () => {
  const { items } = parseM3u('#EXTM3U\nhttp://p/bare.ts\n');
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'http://p/bare.ts');
  assert.equal(items[0].name, 'http://p/bare.ts');
});

test('buildM3u round-trips a parsed playlist', () => {
  const text = [
    '#EXTM3U url-tvg="http://p/epg.xml"',
    '#EXTINF:-1 tvg-id="s1" group-title="Спорт",Sport 1',
    '#EXTVLCOPT:http-user-agent=VLC',
    'http://p/live/1.ts',
    '',
  ].join('\n');
  const { headerAttrs, items } = parseM3u(text);
  assert.equal(buildM3u(items, headerAttrs), text);
});

test('buildM3u drops empty attributes and neutralises quotes in names', () => {
  const out = buildM3u([
    { name: 'A "quoted" name', url: 'http://a', attrs: { 'tvg-id': '', 'group-title': 'G' } },
  ]);
  assert.equal(out, '#EXTM3U\n#EXTINF:-1 group-title="G",A "quoted" name\nhttp://a\n');
});
