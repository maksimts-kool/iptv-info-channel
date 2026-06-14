import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserPlaylist } from '../src/playlist.js';
import { fossIdHash } from '../src/epgfoss.js';

const USER = { token: 'abc123', username: 'ivan' };
const CONFIG = {
  publicBaseUrl: 'https://iptv.example',
  epg: {
    enabled: true,
    foss: { enabled: true, providerId: 'infochannel' },
  },
};

test('playlist enters OTT-play static mode and avoids both match requests', () => {
  const playlist = buildUserPlaylist(USER, { brand_name: 'TestIPTV' }, CONFIG);
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
  const playlist = buildUserPlaylist(USER, {}, config);
  assert.doesNotMatch(playlist, /foss-tvg|tvg-source|tvg-logo/);
  assert.match(playlist, /url-tvg=/);
});
