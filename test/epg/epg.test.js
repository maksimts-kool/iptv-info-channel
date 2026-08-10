import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEpgXml, epgChannelId } from '../../src/epg/epg.js';

const TZ = 'Europe/Tallinn';
// Fixed "now": 2026-06-13 (noon UTC is still the 13th locally).
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
const SETTINGS = { brand_name: 'TestIPTV' };

function buildFor(incidents) {
  return buildEpgXml(USER, {
    settings: SETTINGS, incidents, now: NOW, tz: TZ, daysAhead: 2, daysBehind: 1,
  });
}

test('channel id is per-user and matches what the .m3u tvg-id uses', () => {
  assert.equal(epgChannelId(USER), 'account-abc123');
});

test('emits a well-formed XMLTV document linked to the user channel', () => {
  const xml = buildFor([]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<tv generator-info-name="iptv-info-channel">/);
  assert.match(xml, /<channel id="account-abc123">/);
  assert.match(xml, /<display-name>TestIPTV — ivan<\/display-name>/);
  assert.match(xml, /channel="account-abc123"/);
  assert.match(xml, /<\/tv>\n$/);
});

test('window spans daysBehind..daysAhead with local-midnight boundaries', () => {
  const xml = buildFor([]);
  // 1 day behind + today + 2 ahead = 4 programmes.
  assert.equal(xml.match(/<programme /g).length, 4);
  // First programme starts at local midnight 2026-06-12 (+0300 in summer).
  assert.match(xml, /start="20260612000000 \+0300"/);
  // Last programme stops at local midnight 2026-06-16.
  assert.match(xml, /stop="20260616000000 \+0300"/);
});

// The title is the ONE line a player shows next to the channel, so it must be
// the customer's own status — not the (usually boring) service headline.
test('a healthy day titles the programme with the subscription status', () => {
  const xml = buildFor([]);
  const titles = [...xml.matchAll(/<title[^>]*>([^<]*)<\/title>/g)].map((m) => m[1]);
  assert.equal(titles.length, 4);
  // expires 2026-06-30; on 2026-06-13 that is 17 days, all > threshold → active.
  assert.ok(titles.every((t) => /^✓ Подписка активна · ещё \d+ дн[а-я]+$/.test(t)), titles.join('|'));
  // The service headline is still there, in the detail block.
  assert.match(xml, /Статус сервиса: ✓ Все сервисы работают/);
});

test('the title carries the plan-relevant countdown and decrements over days', () => {
  const xml = buildFor([]);
  const left = [...xml.matchAll(/<title[^>]*>✓ Подписка активна · ещё (\d+) /g)]
    .map((m) => Number(m[1]));
  assert.equal(left.length, 4);
  // The day-behind (12th) shows one more day left than today (13th).
  assert.equal(left[0], left[1] + 1);
});

test('an active outage is folded into the title and detailed in desc', () => {
  const xml = buildFor([
    { id: 'x', severity: 'outage', title: 'Сбой CDN', starts_on: '2026-06-13', ends_on: null, note: 'чиним' },
  ]);
  // The "today" (2026-06-13) programme leads with the outage, then the account.
  assert.match(xml, /<title lang="ru">✕ Сбой сервиса · Подписка активна · ещё \d+ дн[а-я]+<\/title>/);
  assert.match(xml, /Статус сервиса: ✕ Сбой в работе сервиса/);
  assert.match(xml, /Сбой \(с 13 июн 2026, сейчас\): Сбой CDN — чиним/);
  // A day the outage does not cover keeps the plain account title.
  assert.match(xml, /<title lang="ru">✓ Подписка активна · ещё \d+ дн[а-я]+<\/title>/);
});

test('the expiry date is the sub-title and the plan is in the description', () => {
  const xml = buildFor([]);
  assert.match(xml, /<sub-title lang="ru">Действует до 30 июн 2026 · ещё \d+ дн[а-я]+<\/sub-title>/);
  assert.match(xml, /Тариф: Базовый · 4,99 €\/мес\./);
  assert.match(xml, /Доступность за 90 дней: /);
});

test('the last valid day and an open-ended account read correctly', () => {
  const lastDay = buildEpgXml(
    { ...USER, expires_at: '2026-06-13' },
    { settings: SETTINGS, incidents: [], now: NOW, tz: TZ, daysAhead: 0, daysBehind: 0 },
  );
  assert.match(lastDay, /<title lang="ru">⚠ Подписка истекает · последний день<\/title>/);

  const forever = buildEpgXml(
    { ...USER, expires_at: null },
    { settings: SETTINGS, incidents: [], now: NOW, tz: TZ, daysAhead: 0, daysBehind: 0 },
  );
  assert.match(forever, /<title lang="ru">✓ Подписка активна · бессрочно<\/title>/);
  assert.match(forever, /<sub-title lang="ru">Подписка бессрочная<\/sub-title>/);
});

test('a deactivated account says so instead of counting days', () => {
  const xml = buildEpgXml(
    { ...USER, active: 0 },
    { settings: SETTINGS, incidents: [], now: NOW, tz: TZ, daysAhead: 0, daysBehind: 0 },
  );
  assert.match(xml, /<title lang="ru">✕ Аккаунт отключён<\/title>/);
  assert.doesNotMatch(xml, /ещё \d+ дн/);
});

test('values are XML-escaped to keep the document valid', () => {
  const xml = buildEpgXml(
    { token: 't', username: 'a & b', expires_at: null, active: 1 },
    {
      settings: { brand_name: '<Brand>' },
      incidents: [{ id: 'i', severity: 'degraded', title: 'A & B "x"', starts_on: '2026-06-13', ends_on: null }],
      now: NOW, tz: TZ, daysAhead: 0, daysBehind: 0,
    },
  );
  assert.match(xml, /a &amp; b/);
  assert.match(xml, /&lt;Brand&gt;/);
  assert.match(xml, /A &amp; B &quot;x&quot;/);
  assert.doesNotMatch(xml, /[^&]& /); // no bare ampersands
});

test('expired subscription is reflected once the expiry date passes', () => {
  const xml = buildEpgXml(
    { token: 't', username: 'u', expires_at: '2026-06-10', active: 1 },
    { settings: SETTINGS, incidents: [], now: NOW, tz: TZ, daysAhead: 0, daysBehind: 0 },
  );
  assert.match(xml, /<title lang="ru">✕ Подписка истекла<\/title>/);
  assert.match(xml, /<sub-title lang="ru">Действует до 10 июн 2026 · истекла 3 дня назад<\/sub-title>/);
});
