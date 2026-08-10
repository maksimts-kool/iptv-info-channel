import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserPlaylist } from '../../src/http/stream.js';
import { fossIdHash } from '../../src/epg/epgfoss.js';
import { INFO_CATEGORY_ID, INFO_CHANNEL_ID } from '../../src/playlist/model.js';

const USER = { token: 'abc123', username: 'ivan' };
const CONFIG = {
  publicBaseUrl: 'https://iptv.example',
  epg: {
    enabled: true,
    foss: { enabled: true, providerId: 'infochannel' },
  },
};

const INFO_CATEGORY = { id: INFO_CATEGORY_ID, name: 'Информация' };
const INFO_ENTRY = {
  category: INFO_CATEGORY,
  channel: { id: INFO_CHANNEL_ID, name: '', attrs: {} },
};

const entries = (...extra) => [INFO_ENTRY, ...extra];

test('playlist enters OTT-play static mode and avoids both match requests', () => {
  const playlist = buildUserPlaylist(USER, { brand_name: 'TestIPTV' }, CONFIG, entries());
  // The `=` source must end at the directory holding the programme files:
  // OTT-play appends "<hash>.json" to it with nothing in between.
  assert.match(
    playlist,
    /foss-tvg="=infochannel::https:\/\/iptv\.example\/foss-epg\/u\/abc123\/epg\/"/,
  );
  assert.match(playlist, /tvg-source="=infochannel"/);
  assert.match(
    playlist,
    /tvg-logo="https:\/\/iptv\.example\/foss-epg\/u\/abc123\/logo\.svg"/,
  );

  // This is the URL assembled by the shipped OTT-play M3U provider in static mode.
  const sourceUrl = /foss-tvg="=infochannel::([^"]+)"/.exec(playlist)[1];
  const directEpgUrl = `${sourceUrl}${fossIdHash(USER)}.json`;
  assert.equal(directEpgUrl, 'https://iptv.example/foss-epg/u/abc123/epg/463191053.json');
});

test('FOSS attributes disappear when the feature is disabled', () => {
  const config = {
    ...CONFIG,
    epg: { ...CONFIG.epg, foss: { ...CONFIG.epg.foss, enabled: false } },
  };
  const playlist = buildUserPlaylist(USER, {}, config, entries());
  assert.doesNotMatch(playlist, /foss-tvg|tvg-source|tvg-logo/);
  assert.match(playlist, /url-tvg=/);
});

test('the info channel points at this server and is named after the brand', () => {
  const playlist = buildUserPlaylist(USER, { brand_name: 'TestIPTV' }, CONFIG, entries());
  assert.match(playlist, /,TestIPTV — ivan\n/);
  assert.match(playlist, /group-title="Информация"/);
  assert.match(playlist, /^https:\/\/iptv\.example\/hls\/abc123\/index\.m3u8$/m);
});

test('catalog channels are emitted with the catalog name and category, not the upstream ones', () => {
  const playlist = buildUserPlaylist(USER, {}, CONFIG, entries({
    category: { id: 'c1', name: 'Спорт' },
    channel: {
      id: 'ch1',
      name: 'Спорт 1 HD',            // admin rename
      original_name: 'SPORT 1 [RAW]', // upstream name
      url: 'http://provider/live/1.ts',
      attrs: { 'tvg-id': 'sport1', 'tvg-logo': 'http://provider/1.png' },
      extras: ['#EXTVLCOPT:http-user-agent=Mozilla'],
    },
  }));

  assert.match(playlist, /#EXTINF:-1 tvg-id="sport1" tvg-logo="http:\/\/provider\/1\.png" group-title="Спорт",Спорт 1 HD/);
  assert.doesNotMatch(playlist, /SPORT 1 \[RAW\]/);
  // Per-channel playback directives survive the round trip, in order.
  assert.match(playlist, /#EXTVLCOPT:http-user-agent=Mozilla\nhttp:\/\/provider\/live\/1\.ts/);
});

test('an upstream guide is advertised alongside ours on one url-tvg', () => {
  const playlist = buildUserPlaylist(USER, {}, CONFIG, entries(), ['http://provider/epg.xml.gz']);
  assert.match(
    playlist,
    /url-tvg="https:\/\/iptv\.example\/u\/abc123\/epg\.xml,http:\/\/provider\/epg\.xml\.gz"/,
  );
});

test('a locked (expired) customer receives only the info channel', () => {
  // resolveUserChannels already filtered the list; the builder just renders it.
  const playlist = buildUserPlaylist(USER, { brand_name: 'TestIPTV' }, CONFIG, entries());
  const urls = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(urls, ['https://iptv.example/hls/abc123/index.m3u8']);
});

const hlsEntry = {
  category: { id: 'c1', name: 'Спорт' },
  channel: {
    id: 'ch1',
    name: 'Спорт 1 HD',
    url: 'http://provider/live/1.m3u8',
    attrs: { 'tvg-id': 'sport1' },
    extras: ['#EXTVLCOPT:http-user-agent=Mozilla'],
  },
};

test('the stream gateway replaces provider URLs with per-customer gate links', () => {
  const gated = { ...CONFIG, gateway: { enabled: true } };
  const playlist = buildUserPlaylist(USER, {}, gated, entries(hlsEntry));
  const urls = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(urls, [
    // The account channel already lives on this server; only imported channels
    // are routed through the gate. The ".m3u8" ending is required: ExoPlayer
    // picks its media source from the URL extension, and an extensionless link
    // makes it decode the manifest as if it were video (a black screen).
    'https://iptv.example/hls/abc123/index.m3u8',
    'https://iptv.example/c/abc123/ch1.m3u8',
  ]);
  // Everything else about the entry is untouched — name, attributes, directives.
  assert.match(playlist, /#EXTINF:-1 tvg-id="sport1" group-title="Спорт",Спорт 1 HD/);
  assert.match(playlist, /#EXTVLCOPT:http-user-agent=Mozilla/);

  // …and with the gateway off the same entry points straight at the provider.
  const direct = buildUserPlaylist(USER, {}, CONFIG, entries(hlsEntry));
  assert.match(direct, /^http:\/\/provider\/live\/1\.m3u8$/m);
});

test('a non-HLS channel is never gated, because that would need a redirect', () => {
  // The gate answers an HLS channel with the manifest itself; a raw MPEG-TS
  // stream has no manifest, so gating it would mean a 302 from this server's
  // https to the provider's http — which Android players refuse to follow,
  // leaving the channel buffering forever. Such channels stay direct.
  const gated = { ...CONFIG, gateway: { enabled: true } };
  const ts = {
    category: { id: 'c1', name: 'Спорт' },
    channel: { id: 'ch2', name: 'Спорт 2', url: 'http://provider/live/2.ts', attrs: {} },
  };

  const playlist = buildUserPlaylist(USER, {}, gated, entries(hlsEntry, ts));
  assert.match(playlist, /^https:\/\/iptv\.example\/c\/abc123\/ch1\.m3u8$/m);
  assert.match(playlist, /^http:\/\/provider\/live\/2\.ts$/m);
});
