import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountStatus, daysLeft, localDateString, parseExpiry,
} from '../src/util.js';

test('localDateString uses the configured Tallinn calendar date', () => {
  const date = new Date('2026-06-09T21:30:00Z');
  assert.equal(localDateString(date, 'Europe/Tallinn'), '2026-06-10');
});

test('expiry is the final second of the selected Tallinn date', () => {
  assert.equal(
    parseExpiry('2026-06-09', 'Europe/Tallinn').toISOString(),
    '2026-06-09T20:59:59.000Z',
  );
  assert.equal(
    parseExpiry('2026-01-09', 'Europe/Tallinn').toISOString(),
    '2026-01-09T21:59:59.000Z',
  );
});

test('account remains valid through 23:59 on its expiry date', () => {
  const user = { active: 1, expires_at: '2026-06-09' };

  assert.equal(
    accountStatus(user, 7, new Date('2026-06-09T20:59:59.000Z'), 'Europe/Tallinn'),
    'expiring',
  );
  assert.equal(
    daysLeft('2026-06-09', new Date('2026-06-09T20:59:59.000Z'), 'Europe/Tallinn'),
    0,
  );
});

test('account expires at midnight after its Tallinn expiry date', () => {
  const user = { active: 1, expires_at: '2026-06-09' };

  assert.equal(
    accountStatus(user, 7, new Date('2026-06-09T21:00:00.000Z'), 'Europe/Tallinn'),
    'expired',
  );
  assert.equal(
    daysLeft('2026-06-09', new Date('2026-06-09T21:00:00.000Z'), 'Europe/Tallinn'),
    -1,
  );
});
