import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isHlsUrl, rewriteHlsManifest, isMasterPlaylist, parseMediaPlaylist, buildSplicedPlaylist,
} from '../../src/playlist/hls.js';

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

test('with playlistUri, a master hands out its variants and renditions through the gate', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ru",URI="audio/ru.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"',
    'low/index.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframes.m3u8"',
  ].join('\n');
  const gate = (url) => `GATE(${url})`;
  const out = rewriteHlsManifest(manifest, BASE, { playlistUri: gate }).split('\n');
  assert.equal(out[1], '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ru",URI="GATE(http://provider.example/live/user/pass/123/audio/ru.m3u8)"');
  assert.equal(out[3], 'GATE(http://provider.example/live/user/pass/123/low/index.m3u8)');
  // Trick-play playlists are not refreshed during normal playback: left direct.
  assert.equal(out[4], '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="http://provider.example/live/user/pass/123/iframes.m3u8"');
});

test('playlistUri leaves a media playlist alone — its lines are segments', () => {
  const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts';
  assert.equal(isMasterPlaylist(manifest), false);
  assert.ok(rewriteHlsManifest(manifest, BASE, { playlistUri: () => 'NO' }).endsWith('/123/seg.ts'));
});

// ---- the mid-view cut-over ----

const PROVIDER = parseMediaPlaylist([
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:500',
  '#EXT-X-DISCONTINUITY-SEQUENCE:7',
  '#EXT-X-KEY:METHOD=AES-128,URI="http://p/k"',
  '#EXT-X-PROGRAM-DATE-TIME:2026-10-06T10:00:00.000Z',
  '#EXTINF:4.000,',
  'http://p/a.ts',
  '#EXTINF:4.000,',
  'http://p/b.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:4.000,',
  'http://p/c.ts',
].join('\n'));
const FILLER = [{ file: 'seg_000.ts', duration: 6 }, { file: 'seg_001.ts', duration: 6 }, { file: 'seg_002.ts', duration: 6 }];
const fillerUri = (seg, seq) => `https://me/hls/t/${seg.file}?s=${seq}`;

// Read a playlist the way ExoPlayer does: each segment's media sequence and
// discontinuity number (base + every tag up to and including the segment).
function timeline(text) {
  const lines = text.split('\n');
  let seq = Number(lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:')).split(':')[1]);
  let disc = Number(lines.find((l) => l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')).split(':')[1]);
  const out = new Map();
  for (const line of lines) {
    if (line === '#EXT-X-DISCONTINUITY') disc += 1;
    else if (line && !line.startsWith('#')) out.set(seq++, { disc, uri: line });
  }
  return out;
}

test('parseMediaPlaylist keeps per-segment tags and the key in force', () => {
  assert.equal(PROVIDER.mediaSequence, 500);
  assert.equal(PROVIDER.discontinuitySequence, 7);
  assert.equal(PROVIDER.segments.length, 3);
  assert.equal(PROVIDER.segments[2].discontinuity, true);
  assert.match(PROVIDER.segments[2].key, /AES-128/, 'the key carries over to later segments');
  assert.equal(PROVIDER.segments[0].pdt, Date.parse('2026-10-06T10:00:00Z'));
});

test('the cut-over continues the same stream: sequence and discontinuity numbers never disagree', () => {
  let previous = null;
  let previousFirst = -1;
  for (let t = 0; t <= 120; t += 2) {
    const text = buildSplicedPlaylist({
      provider: PROVIDER, filler: FILLER, fillerUri, elapsedSeconds: t, window: 6,
    });
    const now = timeline(text);
    const first = Math.min(...now.keys());
    assert.ok(first >= previousFirst, `media sequence moved backwards at t=${t}`);
    // ExoPlayer only accepts a refresh that is newer than what it holds: a
    // later first sequence, or the same one with more segments.
    assert.ok(
      first > PROVIDER.mediaSequence || now.size > PROVIDER.segments.length,
      'newer than the last provider window',
    );
    if (previous) {
      for (const [seq, seg] of now) {
        if (previous.has(seq)) assert.deepEqual(seg, previous.get(seq), `seq ${seq} changed at t=${t}`);
      }
    }
    // A tag on the first listed segment would be counted twice.
    assert.doesNotMatch(text, /DISCONTINUITY-SEQUENCE:\d+\n(#EXT-X-KEY[^\n]*\n)?#EXT-X-DISCONTINUITY\n/);
    previous = now;
    previousFirst = first;
  }
  // The provider part keeps its numbers; the cut and every loop wrap add one.
  const end = timeline(buildSplicedPlaylist({ provider: PROVIDER, filler: FILLER, fillerUri, elapsedSeconds: 0, window: 20 }));
  assert.deepEqual([...end.values()].map((s) => s.disc), [7, 7, 8, 9, 9, 9]);
  assert.equal(end.get(503).uri, 'https://me/hls/t/seg_000.ts?s=503');
});

test('the cut switches the encryption off and keeps the wall clock running', () => {
  const text = buildSplicedPlaylist({ provider: PROVIDER, filler: FILLER, fillerUri, elapsedSeconds: 0 });
  const lines = text.split('\n');
  const cut = lines.indexOf('https://me/hls/t/seg_000.ts?s=503');
  assert.deepEqual(lines.slice(cut - 4, cut), [
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXT-X-PROGRAM-DATE-TIME:2026-10-06T10:00:12.000Z',
    '#EXTINF:6.000000,',
  ]);
  // Once the provider segments scroll off, so does every key line.
  const later = buildSplicedPlaylist({ provider: PROVIDER, filler: FILLER, fillerUri, elapsedSeconds: 300, window: 4 });
  assert.doesNotMatch(later, /EXT-X-KEY/);
});

test('the key that scrolled off is restated for the first provider segment still listed', () => {
  const text = buildSplicedPlaylist({ provider: PROVIDER, filler: FILLER, fillerUri, elapsedSeconds: 0, window: 5 });
  const lines = text.split('\n');
  assert.equal(lines[lines.indexOf('http://p/b.ts') - 2], '#EXT-X-KEY:METHOD=AES-128,URI="http://p/k"');
});

test('an fMP4 provider cannot be followed by TS segments, so its window is closed instead', () => {
  const fmp4 = parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="http://p/init.mp4"\n#EXTINF:4,\nhttp://p/a.m4s');
  const text = buildSplicedPlaylist({ provider: fmp4, filler: FILLER, fillerUri });
  assert.match(text, /#EXT-X-ENDLIST\n$/);
  assert.doesNotMatch(text, /seg_000/);
});
