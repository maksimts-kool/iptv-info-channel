import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountStatus, addPeriod, daysLeft, localDateString, parseExpiry,
} from '../../src/core/util.js';

test('addPeriod does the month arithmetic a subscription needs', () => {
  assert.equal(addPeriod('2026-08-10', 'month', 1), '2026-09-10');
  assert.equal(addPeriod('2026-08-10', 'month', 3), '2026-11-10');
  assert.equal(addPeriod('2026-08-10', 'year', 1), '2027-08-10');
  assert.equal(addPeriod('2026-08-10', 'day', 14), '2026-08-24');
  // A plan with no billing period is still sold by the month.
  assert.equal(addPeriod('2026-08-10', '', 1), '2026-09-10');
  // Crossing a year boundary.
  assert.equal(addPeriod('2026-12-15', 'month', 2), '2027-02-15');
});

test('addPeriod clamps to the last day when the target month is shorter', () => {
  assert.equal(addPeriod('2026-01-31', 'month', 1), '2026-02-28');
  assert.equal(addPeriod('2028-01-31', 'month', 1), '2028-02-29'); // leap year
  assert.equal(addPeriod('2026-08-31', 'month', 1), '2026-09-30');
  assert.equal(addPeriod('2028-02-29', 'year', 1), '2029-02-28');
});

test('addPeriod rejects input it cannot interpret', () => {
  assert.equal(addPeriod('', 'month', 1), null);
  assert.equal(addPeriod('10.08.2026', 'month', 1), null);
  assert.equal(addPeriod('2026-08-10', 'month', 1.5), null);
});

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
