import test from 'node:test';
import assert from 'node:assert/strict';
import { epgChannelId } from '../../src/epg/epg.js';
import {
  MATCH_BLOCK_SEP,
  fossIdHash,
  fossUrlHash,
  buildFossChannelsJson,
  buildFossEpgJson,
  parseMatchRequest,
  buildMatchChannelsResponse,
  mergeMatchChannelsResponses,
  EMPTY_CHANNEL_MATCH_RESPONSE,
  EMPTY_LOGO_MATCH_RESPONSE,
} from '../../src/epg/epgfoss.js';

const TZ = 'Europe/Tallinn';
const NOW = new Date('2026-06-13T12:00:00Z');
const USER = {
  token: 'abc123',
  username: 'ivan',
  expires_at: '2026-06-30',
  active: 1,
  plan_name: 'Базовый',
  price_cents: 499,
  currency: 'EUR',
  billing_period: 'month',
};
const EPG_URL = 'https://iptv.example/u/abc123/epg.xml';
const LOGO_URL = 'https://iptv.example/foss-epg/u/abc123/logo.svg';

const opts = (overrides = {}) => ({
  settings: { brand_name: 'TestIPTV' },
  incidents: [],
  now: NOW,
  tz: TZ,
  daysAhead: 2,
  daysBehind: 1,
  providerId: 'custom-provider',
  epgUrls: [EPG_URL],
  logoUrl: LOGO_URL,
  ...overrides,
});

test('FOSS id hash uses the playlist tvg-id', () => {
  assert.equal(epgChannelId(USER), 'account-abc123');
  assert.equal(fossIdHash(USER), 463191053);
});

// Pinned against the LIVE reference providers published by OTT-play's own
// converter (https://epg.ottp.eu.org/<id>/channels.json): the url hash is taken
// over the URL with the scheme cut off and is NOT case-folded, unlike the
// channel-id hash. Do not "normalize" either one — the player reproduces these
// byte-for-byte and a mismatch silently means no EPG.
test('url hashes reproduce the reference providers', () => {
  assert.equal(fossUrlHash('https://iptvx.one/EPG'), 2853413468);
  assert.equal(fossUrlHash('http://iptvx.one/EPG'), 2853413468);
  assert.equal(fossUrlHash('iptvx.one/EPG'), 2853413468);
  // Case-sensitive: lowercasing the path gives a different (wrong) hash.
  assert.notEqual(fossUrlHash('https://iptvx.one/epg'), 2853413468);
});

test('channels.json binds the provider to this playlist and carries the icon', () => {
  const json = buildFossChannelsJson(USER, opts());
  const idHash = String(fossIdHash(USER));
  assert.equal(json.meta.id, 'custom-provider');
  assert.ok(json.meta['last-epg'] > NOW.getTime() / 1000);
  // Without this the player has no reason to apply the provider to the playlist.
  assert.deepEqual(json.meta['url-hashes'], [fossUrlHash(EPG_URL)]);
  assert.deepEqual(Object.keys(json.data), [idHash]);
  assert.equal(json.data[idHash][0], `account-abc123¦${json.meta['last-epg']}¦${LOGO_URL}`);
  assert.equal(json.data[idHash][1], 'TestIPTV — ivan');
});

const currentOf = (json) => json.epg_data.find(
  (programme) => programme.time <= NOW.getTime() / 1000
    && programme.time_to > NOW.getTime() / 1000,
);

// OTT-play FOSS gets the SAME text as the XMLTV guide: `name` is the one-line
// subscription status, `descr` the detail block. `descr` used to be empty here,
// which left FOSS viewers with no account status at all.
test('EPG JSON carries the subscription status and its details', () => {
  const json = buildFossEpgJson(USER, opts());
  assert.equal(json.epg_data.length, 4);
  assert.ok(currentOf(json));
  for (const programme of json.epg_data) {
    assert.ok(programme.time_to > programme.time);
    assert.match(programme.name, /^✓ Подписка активна · ещё \d+ дн[а-я]+$/);
    assert.match(programme.descr, /Тариф: Базовый · 4,99 €\/мес\./);
    assert.match(programme.descr, /Действует до 30 июн 2026 · ещё \d+ дн[а-я]+/);
    assert.match(programme.descr, /Статус сервиса: ✓ Все сервисы работают/);
    assert.match(programme.descr, /Доступность за 90 дней: /);
  }
});

test('FOSS EPG folds an outage into the name and details it in descr', () => {
  const json = buildFossEpgJson(USER, opts({
    incidents: [{
      id: 'outage',
      severity: 'outage',
      title: 'CDN outage',
      starts_on: '2026-06-13',
      ends_on: null,
    }],
  }));
  const current = currentOf(json);
  assert.match(current.name, /^✕ Сбой сервиса · Подписка активна · ещё \d+ дн[а-я]+$/);
  assert.match(current.descr, /Статус сервиса: ✕ Сбой в работе сервиса/);
  assert.match(current.descr, /Сбой \(с 13 июн 2026, сейчас\): CDN outage/);
});

test('match request and response use the exact three-block envelope', () => {
  const hash = String(fossIdHash(USER));
  const body = ['{}', 'https://example.test/epg.xml', `42-${hash}-0-0~99-100`]
    .join(MATCH_BLOCK_SEP);
  const parsed = parseMatchRequest(body);
  assert.deepEqual(parsed.channels, [{
    key: '42',
    tvgIdHash: hash,
    tvgNameHash: '0',
    nameHash: '0',
  }]);

  const response = buildMatchChannelsResponse(
    parsed.channels,
    (channel) => (channel.tvgIdHash === hash ? { user: USER, idHash: hash } : null),
    () => 'https://example.test/foss-epg/u/abc123/',
    'custom-provider',
  );
  assert.deepEqual(response.split(MATCH_BLOCK_SEP), [
    '{}',
    `42~custom-provider~${hash}`,
    'custom-provider~https://example.test/foss-epg/u/abc123/',
  ]);
});

test('malformed and unmatched requests stay well formed', () => {
  assert.equal(parseMatchRequest('garbage'), null);
  const request = parseMatchRequest(['{}', '', '42-123-0-0'].join(MATCH_BLOCK_SEP));
  assert.equal(
    buildMatchChannelsResponse(request.channels, () => null, () => '', 'infochannel'),
    EMPTY_CHANNEL_MATCH_RESPONSE,
  );
  assert.equal(EMPTY_LOGO_MATCH_RESPONSE.split(MATCH_BLOCK_SEP).length, 2);
});

test('local matches merge with normal OTT-play matches and win by channel key', () => {
  const local = [
    '{}',
    '42~infochannel~2554912436',
    'infochannel~https://iptv.example/foss-epg/u/abc123/',
  ].join(MATCH_BLOCK_SEP);
  const upstream = [
    '{}',
    '7~edem~100\n42~wrong~999',
    'edem~https://epg.ottp.eu.org/edem/\nwrong~https://example.test/',
  ].join(MATCH_BLOCK_SEP);

  assert.deepEqual(mergeMatchChannelsResponses(local, upstream).split(MATCH_BLOCK_SEP), [
    '{}',
    '7~edem~100\n42~infochannel~2554912436',
    'edem~https://epg.ottp.eu.org/edem/\ninfochannel~https://iptv.example/foss-epg/u/abc123/',
  ]);
});
