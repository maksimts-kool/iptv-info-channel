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
  assert.match(
    playlist,
    /foss-tvg="=infochannel::https:\/\/iptv\.example\/foss-epg\/u\/abc123\/"/,
  );
  assert.match(playlist, /tvg-source="=infochannel"/);
  assert.match(
    playlist,
    /tvg-logo="https:\/\/iptv\.example\/foss-epg\/u\/abc123\/logo\.svg"/,
  );

  // This is the URL assembled by the shipped OTT-play M3U provider in static mode.
  const directEpgUrl = `https://iptv.example/foss-epg/u/abc123/epg/${fossIdHash(USER)}.json`;
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
