import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceTracker, deviceKey, deviceTag } from '../../src/playlist/devices.js';

const T0 = 1_000_000;

test('the first devices get the slots and a newcomer is turned away', () => {
  const t = new DeviceTracker({ idleMs: 60_000 });
  assert.equal(t.admit(1, 'tv', 2, {}, T0).allowed, true);
  assert.equal(t.admit(1, 'phone', 2, {}, T0 + 1).allowed, true);
  assert.deepEqual(t.admit(1, 'tablet', 2, {}, T0 + 2), { allowed: false, active: 2, limit: 2 });
  // Devices already watching keep their slot on every refresh.
  assert.equal(t.admit(1, 'tv', 2, {}, T0 + 3).allowed, true);
  assert.equal(t.admit(1, 'phone', 2, {}, T0 + 4).allowed, true);
});

test('a refused device holds no slot, and a closed one frees its slot after the idle window', () => {
  const t = new DeviceTracker({ idleMs: 60_000 });
  t.admit(1, 'tv', 1, {}, T0);
  for (let i = 1; i <= 5; i += 1) assert.equal(t.admit(1, 'phone', 1, {}, T0 + i * 1000).allowed, false);
  assert.equal(t.count(1, T0 + 5000), 1);
  // The TV stops polling; a minute later the phone gets in.
  assert.equal(t.admit(1, 'phone', 1, {}, T0 + 60_001).allowed, true);
  assert.equal(t.admit(1, 'tv', 1, {}, T0 + 60_002).allowed, false);
});

test('a turned-away newcomer is listed (but never counted) until it idles out', () => {
  const t = new DeviceTracker({ idleMs: 60_000 });
  t.admit(1, 'tv', 1, { channel: 'A' }, T0);
  t.admit(1, 'phone', 1, { channel: 'B' }, T0 + 1000);
  t.admit(1, 'tv', 1, { channel: 'A' }, T0 + 2000);
  assert.deepEqual(t.list(1, 1, T0 + 3000).map((d) => [d.channel, d.allowed]), [['A', true], ['B', false]]);
  assert.equal(t.count(1, T0 + 3000), 1);
  // Gets in once the TV is gone, and is no longer listed as refused.
  assert.equal(t.admit(1, 'phone', 1, { channel: 'B' }, T0 + 62_001).allowed, true);
  assert.deepEqual(t.list(1, 1, T0 + 62_002).map((d) => [d.channel, d.allowed]), [['B', true]]);
  // A refusal nobody retries ages out like any device.
  t.admit(1, 'tablet', 1, {}, T0 + 62_003);
  assert.equal(t.list(1, 1, T0 + 62_004).length, 2);
  assert.equal(t.list(1, 1, T0 + 200_000).length, 0);
});

test('lowering the limit keeps the earliest devices and refuses the latest', () => {
  const t = new DeviceTracker({ idleMs: 60_000 });
  t.admit(1, 'a', 3, {}, T0);
  t.admit(1, 'b', 3, {}, T0 + 1);
  t.admit(1, 'c', 3, {}, T0 + 2);
  assert.equal(t.admit(1, 'c', 2, {}, T0 + 3).allowed, false);
  assert.equal(t.admit(1, 'a', 2, {}, T0 + 4).allowed, true);
  assert.equal(t.admit(1, 'b', 2, {}, T0 + 5).allowed, true);
  assert.deepEqual(t.list(1, 2, T0 + 6).map((d) => d.allowed), [true, true, false]);
});

test('0 means no limit, and customers never share slots', () => {
  const t = new DeviceTracker();
  for (let i = 0; i < 20; i += 1) assert.equal(t.admit(1, `d${i}`, 0, {}, T0).allowed, true);
  assert.equal(t.admit(2, 'tv', 1, {}, T0).allowed, true);
  assert.equal(t.count(1, T0), 20);
  t.forget(1);
  assert.equal(t.count(1, T0), 0);
  assert.equal(t.count(2, T0), 1);
});

test('a device is the client IP plus the playlist tag, not the per-request User-Agent', () => {
  const tag = deviceTag('TiviMate/5.0 (Android TV)');
  assert.equal(tag, deviceTag('TiviMate/5.0 (Android TV)'), 'stable across re-downloads');
  assert.match(tag, /^[A-Za-z0-9_-]{10}$/);
  // One app probing with okhttp and then playing with ExoPlayer is one device…
  assert.equal(
    deviceKey({ ip: '1.2.3.4', tag, userAgent: 'okhttp/4.12' }),
    deviceKey({ ip: '1.2.3.4', tag, userAgent: 'ExoPlayerLib/2.19' }),
  );
  // …the same playlist file opened in another household is another…
  assert.notEqual(deviceKey({ ip: '1.2.3.4', tag }), deviceKey({ ip: '5.6.7.8', tag }));
  // …and an untagged (older) link falls back to the User-Agent.
  assert.notEqual(
    deviceKey({ ip: '1.2.3.4', userAgent: 'VLC' }),
    deviceKey({ ip: '1.2.3.4', userAgent: 'Kodi' }),
  );
});
