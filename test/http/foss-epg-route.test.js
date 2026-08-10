import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createFossEpgRouter } from '../../src/http/stream.js';
import { MATCH_BLOCK_SEP, fossIdHash, fossUrlHash } from '../../src/epg/epgfoss.js';
import { buildUserPlaylist } from '../../src/http/stream.js';
import { INFO_CATEGORY_ID, INFO_CHANNEL_ID } from '../../src/playlist/model.js';

// The one catalog entry every customer always has: the info channel, which is
// what carries the FOSS attributes this suite is about.
const INFO_ENTRY = {
  category: { id: INFO_CATEGORY_ID, name: 'Информация' },
  channel: { id: INFO_CHANNEL_ID, name: '', attrs: {} },
};

const NOW = new Date('2026-06-13T12:00:00Z');
const USER = {
  id: 1,
  token: 'abc123',
  username: 'ivan',
  expires_at: '2026-06-30',
  active: 1,
};
const CONFIG = {
  publicBaseUrl: 'https://iptv.example',
  timezone: 'Europe/Tallinn',
  expiringThresholdDays: 7,
  epg: {
    enabled: true,
    daysAhead: 2,
    daysBehind: 1,
    foss: {
      enabled: true,
      providerId: 'infochannel',
      upstreamMatchUrl: '',
    },
  },
};

async function startServer(t) {
  const config = structuredClone(CONFIG);
  const app = express();
  app.use(createFossEpgRouter({
    config,
    Users: {
      all: () => [USER],
      getByToken: (token) => (token === USER.token ? USER : null),
    },
    Settings: { all: () => ({ brand_name: 'TestIPTV' }) },
    Incidents: { all: () => [] },
    now: () => NOW,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = base;
  return { base, config };
}

function assertPublicHeaders(response) {
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('cache-control'), /no-store/);
}

test('match endpoints return client-compatible envelopes', async (t) => {
  const { base } = await startServer(t);
  const hash = String(fossIdHash(USER));
  const requestBody = ['{}', '', `42-${hash}-0-0`].join(MATCH_BLOCK_SEP);

  const channels = await fetch(`${base}/m3u/match-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: requestBody,
  });
  assert.equal(channels.status, 200);
  assertPublicHeaders(channels);
  assert.deepEqual((await channels.text()).split(MATCH_BLOCK_SEP), [
    '{}',
    `42~infochannel~${hash}`,
    `infochannel~${base}/foss-epg/u/abc123/`,
  ]);

  const logos = await fetch(`${base}/m3u/match-logos`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: requestBody,
  });
  assert.equal(logos.status, 200);
  assertPublicHeaders(logos);
  assert.equal((await logos.text()).split(MATCH_BLOCK_SEP).length, 2);
});

test('match endpoint merges local and upstream provider results', async (t) => {
  const config = structuredClone(CONFIG);
  config.epg.foss.upstreamMatchUrl = 'https://central.example';
  let forwardedBody = '';
  const app = express();
  app.use(createFossEpgRouter({
    config,
    Users: {
      all: () => [USER],
      getByToken: (token) => (token === USER.token ? USER : null),
    },
    Settings: { all: () => ({ brand_name: 'TestIPTV' }) },
    Incidents: { all: () => [] },
    now: () => NOW,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://central.example/m3u/match-channels');
      forwardedBody = options.body;
      return new Response([
        '{}',
        '7~edem~100',
        'edem~https://epg.ottp.eu.org/edem/',
      ].join(MATCH_BLOCK_SEP));
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = base;

  const hash = String(fossIdHash(USER));
  const requestBody = ['{}', 'http://epg.it999.ru/edem.xml.gz', [
    `42-${hash}-0-0`,
    '7-123-456-789',
  ].join('\n')].join(MATCH_BLOCK_SEP);
  const response = await fetch(`${base}/m3u/match-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: requestBody,
  });

  assert.equal(response.status, 200);
  assert.equal(forwardedBody, requestBody);
  assert.deepEqual((await response.text()).split(MATCH_BLOCK_SEP), [
    '{}',
    `7~edem~100\n42~infochannel~${hash}`,
    `edem~https://epg.ottp.eu.org/edem/\ninfochannel~${base}/foss-epg/u/abc123/`,
  ]);
});

test('local match still succeeds when the upstream matcher is unavailable', async (t) => {
  const config = structuredClone(CONFIG);
  config.epg.foss.upstreamMatchUrl = 'https://central.example';
  const app = express();
  app.use(createFossEpgRouter({
    config,
    Users: {
      all: () => [USER],
      getByToken: (token) => (token === USER.token ? USER : null),
    },
    Settings: { all: () => ({ brand_name: 'TestIPTV' }) },
    Incidents: { all: () => [] },
    now: () => NOW,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = base;

  const hash = String(fossIdHash(USER));
  const requestBody = ['{}', '', `42-${hash}-0-0`].join(MATCH_BLOCK_SEP);
  const response = await fetch(`${base}/m3u/match-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: requestBody,
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.text()).split(MATCH_BLOCK_SEP), [
    '{}',
    `42~infochannel~${hash}`,
    `infochannel~${base}/foss-epg/u/abc123/`,
  ]);
});

test('direct JSON and logo endpoints form a complete static source', async (t) => {
  const { base, config } = await startServer(t);
  const hash = fossIdHash(USER);
  const playlist = buildUserPlaylist(USER, { brand_name: 'TestIPTV' }, config, [INFO_ENTRY]);
  const epgDirUrl = /foss-tvg="=infochannel::([^"]+)"/.exec(playlist)?.[1];
  const logoUrl = /tvg-logo="([^"]+)"/.exec(playlist)?.[1];
  const urlTvg = /url-tvg="([^"]+)"/.exec(playlist)?.[1];
  const providerBase = `${base}/foss-epg/u/abc123/`;
  // In `=` mode OTT-play appends "<hash>.json" to the advertised source with
  // nothing in between, so the playlist has to name the epg/ directory itself.
  assert.equal(epgDirUrl, `${providerBase}epg/`);
  assert.equal(logoUrl, `${providerBase}logo.svg`);

  const channelsResponse = await fetch(`${providerBase}channels.json`);
  assert.equal(channelsResponse.status, 200);
  assertPublicHeaders(channelsResponse);
  const channels = await channelsResponse.json();
  assert.ok(channels.data[String(hash)]);

  // The binding OTT-play actually performs: it hashes the playlist's own
  // `url-tvg` and only uses a provider that declares that hash. Publishing an
  // empty `url-hashes` (what this server used to do) means no EPG at all.
  assert.deepEqual(channels.meta['url-hashes'], [fossUrlHash(urlTvg)]);
  // The row also carries the channel icon, so no central logo match is needed.
  assert.equal(channels.data[String(hash)][0], `account-abc123¦${channels.meta['last-epg']}¦${logoUrl}`);

  // Exactly the request the player makes: the advertised source + "<hash>.json".
  const epgResponse = await fetch(`${epgDirUrl}${hash}.json`);
  assert.equal(epgResponse.status, 200);
  assertPublicHeaders(epgResponse);
  const epg = await epgResponse.json();
  assert.ok(epg.epg_data.length > 0);

  const logoResponse = await fetch(logoUrl);
  assert.equal(logoResponse.status, 200);
  assertPublicHeaders(logoResponse);
  assert.match(logoResponse.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await logoResponse.text(), /TestIPTV/);

  const wrongHash = await fetch(`${base}/foss-epg/u/abc123/epg/1.json`);
  assert.equal(wrongHash.status, 404);
});
