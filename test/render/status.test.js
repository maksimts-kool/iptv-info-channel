import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusSummary, formatUptime, SEVERITY, withProviderNotices, PROVIDER_STATE,
} from '../../src/render/status.js';

const TZ = 'Europe/Tallinn';
// A fixed "now": 2026-06-13 in Tallinn (21:00Z is still the 13th locally... use noon).
const NOW = new Date('2026-06-13T12:00:00Z');

test('no incidents → fully operational, 100% uptime, all-green strip', () => {
  const s = statusSummary([], { now: NOW, tz: TZ, days: 90 });
  assert.equal(s.state, 'operational');
  assert.equal(s.label, 'Все сервисы работают');
  assert.equal(s.color, SEVERITY.operational.color);
  assert.equal(s.uptimePct, 100);
  assert.equal(s.days.length, 90);
  assert.ok(s.days.every((d) => d.severity === 'operational'));
  assert.equal(s.activeIncidents.length, 0);
  // rightmost cell is today, leftmost is 89 days earlier
  assert.equal(s.days.at(-1).date, '2026-06-13');
  assert.equal(s.days[0].date, '2026-03-16');
});

test('an ended incident colours only the days it covered', () => {
  const incidents = [
    { id: 'a', severity: 'outage', starts_on: '2026-06-10', ends_on: '2026-06-11' },
  ];
  const s = statusSummary(incidents, { now: NOW, tz: TZ, days: 90 });
  // 2 outage days, not active today
  assert.equal(s.state, 'operational');
  assert.equal(s.activeIncidents.length, 0);
  const byDate = Object.fromEntries(s.days.map((d) => [d.date, d.severity]));
  assert.equal(byDate['2026-06-09'], 'operational');
  assert.equal(byDate['2026-06-10'], 'outage');
  assert.equal(byDate['2026-06-11'], 'outage');
  assert.equal(byDate['2026-06-12'], 'operational');
  assert.equal(s.uptimePct, Math.round((88 / 90) * 1000) / 10);
});

test('open-ended incident is active today and runs through today', () => {
  const incidents = [
    { id: 'a', severity: 'degraded', starts_on: '2026-06-12', ends_on: null },
  ];
  const s = statusSummary(incidents, { now: NOW, tz: TZ, days: 90 });
  assert.equal(s.state, 'degraded');
  assert.equal(s.label, 'Частичная деградация сервиса');
  assert.equal(s.activeIncidents.length, 1);
  const byDate = Object.fromEntries(s.days.map((d) => [d.date, d.severity]));
  assert.equal(byDate['2026-06-12'], 'degraded');
  assert.equal(byDate['2026-06-13'], 'degraded');
});

test('worst severity wins when incidents overlap on the same day', () => {
  const incidents = [
    { id: 'a', severity: 'degraded', starts_on: '2026-06-13', ends_on: null },
    { id: 'b', severity: 'outage', starts_on: '2026-06-13', ends_on: '2026-06-13' },
  ];
  const s = statusSummary(incidents, { now: NOW, tz: TZ, days: 90 });
  assert.equal(s.state, 'outage'); // outage outranks degraded for the headline
  assert.equal(s.days.at(-1).severity, 'outage');
});

test('future-dated incident does not affect past bars or today', () => {
  const incidents = [
    { id: 'a', severity: 'outage', starts_on: '2026-06-20', ends_on: '2026-06-21' },
  ];
  const s = statusSummary(incidents, { now: NOW, tz: TZ, days: 90 });
  assert.equal(s.state, 'operational');
  assert.equal(s.uptimePct, 100);
});

test('invalid incidents (bad severity / missing start) are ignored', () => {
  const incidents = [
    { id: 'a', severity: 'unknown', starts_on: '2026-06-13' },
    { id: 'b', severity: 'outage' },
  ];
  const s = statusSummary(incidents, { now: NOW, tz: TZ, days: 90 });
  assert.equal(s.state, 'operational');
  assert.equal(s.uptimePct, 100);
});

test('formatUptime uses whole numbers when clean, EU comma otherwise', () => {
  assert.equal(formatUptime(100), '100%');
  assert.equal(formatUptime(99.9), '99,9%');
});

test('provider notices turn an operational status blue and mark their day', () => {
  const s = withProviderNotices(statusSummary([], { now: NOW, tz: TZ }), [
    { id: '1', published_at: '2026-06-13T07:00:00Z', kind: 'outage', headline: 'Перебои', body: '' },
  ], { tz: TZ });
  assert.equal(s.state, 'provider');
  assert.equal(s.label, 'Перебои у провайдера');
  assert.equal(s.color, PROVIDER_STATE.color);
  assert.equal(s.uptimePct, 100);
  assert.equal(s.days.at(-1).color, PROVIDER_STATE.color);
  assert.equal(s.days.at(-2).color, SEVERITY.operational.color);
  assert.equal(s.providerNotices.length, 1);
});

test('our own incident outranks provider notices; none leaves the summary as is', () => {
  const incidents = [{ severity: 'degraded', starts_on: '2026-06-13' }];
  const base = statusSummary(incidents, { now: NOW, tz: TZ });
  const s = withProviderNotices(base, [
    { id: '1', published_at: '2026-06-13T07:00:00Z', kind: 'maintenance', headline: 'x', body: '' },
  ], { tz: TZ });
  assert.equal(s.state, 'degraded');
  assert.equal(s.color, SEVERITY.degraded.color);
  assert.equal(s.days.at(-1).color, SEVERITY.degraded.color);
  assert.deepEqual(withProviderNotices(base, [], { tz: TZ }), { ...base, providerNotices: [] });
});
