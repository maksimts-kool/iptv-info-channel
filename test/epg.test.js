import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEpgXml, epgChannelId } from '../src/epg/epg.js';

const TZ = 'Europe/Tallinn';
// Fixed "now": 2026-06-13 (noon UTC is still the 13th locally).
const NOW = new Date('2026-06-13T12:00:00Z');
const USER = { token: 'abc123', username: 'ivan', expires_at: '2026-06-30', active: 1 };
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

test('no incidents → every day shows the operational headline', () => {
  const xml = buildFor([]);
  const titles = [...xml.matchAll(/<title[^>]*>([^<]*)<\/title>/g)].map((m) => m[1]);
  assert.equal(titles.length, 4);
  assert.ok(titles.every((t) => t.includes('Все сервисы работают')));
});

test('an active outage colours the title and lists the incident in desc', () => {
  const xml = buildFor([
    { id: 'x', severity: 'outage', title: 'Сбой CDN', starts_on: '2026-06-13', ends_on: null, note: 'чиним' },
  ]);
  // The "today" (2026-06-13) programme is the outage one.
  assert.match(xml, /<title lang="ru">✕ Сбой в работе сервиса<\/title>/);
  assert.match(xml, /Сбой \(с 13 июн 2026, сейчас\): Сбой CDN — чиним/);
});

test('subscription status appears as sub-title and decrements over days', () => {
  const xml = buildFor([]);
  // expires 2026-06-30; on 2026-06-13 that is 17 days, all > threshold → active.
  assert.match(xml, /<sub-title lang="ru">Подписка: АКТИВЕН · осталось \d+ дн[а-я]+<\/sub-title>/);
  // The day-behind (12th) shows one more day left than today (13th).
  const subs = [...xml.matchAll(/<sub-title[^>]*>Подписка: \S+ · осталось (\d+) /g)]
    .map((m) => Number(m[1]));
  assert.equal(subs.length, 4);
  assert.equal(subs[0], subs[1] + 1);
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
  assert.match(xml, /<sub-title lang="ru">Подписка: ПРОСРОЧЕН<\/sub-title>/);
});
