import test from 'node:test';
import assert from 'node:assert/strict';
import { epgChannelId } from '../src/epg.js';
import {
  MATCH_BLOCK_SEP,
  fossIdHash,
  findUserByIdHash,
  buildFossChannelsJson,
  buildFossEpgJson,
  parseMatchRequest,
  buildMatchChannelsResponse,
  EMPTY_CHANNEL_MATCH_RESPONSE,
  EMPTY_LOGO_MATCH_RESPONSE,
} from '../src/epgfoss.js';

const TZ = 'Europe/Tallinn';
const NOW = new Date('2026-06-13T12:00:00Z');
const USER = {
  token: 'abc123',
  username: 'ivan',
  expires_at: '2026-06-30',
  active: 1,
};
const opts = (overrides = {}) => ({
  settings: { brand_name: 'TestIPTV' },
  incidents: [],
  now: NOW,
  tz: TZ,
  daysAhead: 2,
  daysBehind: 1,
  providerId: 'custom-provider',
  ...overrides,
});

test('FOSS id hash uses the playlist tvg-id', () => {
  assert.equal(epgChannelId(USER), 'account-abc123');
  assert.equal(fossIdHash(USER), 463191053);
});

test('findUserByIdHash reverses a decimal uint32 hash', () => {
  const users = [USER, { ...USER, token: 'other' }];
  assert.equal(findUserByIdHash(users, String(fossIdHash(USER))), USER);
  assert.equal(findUserByIdHash(users, 'not-a-number'), null);
  assert.equal(findUserByIdHash(users, '4294967296'), null);
});

test('channels.json contains a future top programme and broken-bar metadata', () => {
  const json = buildFossChannelsJson(USER, opts());
  const idHash = String(fossIdHash(USER));
  assert.equal(json.meta.id, 'custom-provider');
  assert.ok(json.meta['last-epg'] > NOW.getTime() / 1000);
  assert.deepEqual(Object.keys(json.data), [idHash]);
  assert.match(json.data[idHash][0], /^account-abc123¦\d+¦$/);
  assert.equal(json.data[idHash][1], 'TestIPTV — ivan');
});

test('EPG JSON covers the current day and future window in unix seconds', () => {
  const json = buildFossEpgJson(USER, opts());
  assert.equal(json.epg_data.length, 4);
  assert.ok(json.epg_data.some(
    (programme) => programme.time <= NOW.getTime() / 1000
      && programme.time_to > NOW.getTime() / 1000,
  ));
  for (const programme of json.epg_data) {
    assert.ok(programme.time_to > programme.time);
    assert.match(programme.name, /^Подписка: /);
    assert.match(programme.descr, /Все сервисы работают/);
  }
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
