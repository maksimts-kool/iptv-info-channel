import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePriceCents,
  parseFeatures,
  duplicatePlanName,
  validateIncident,
  planJson,
  incidentJson,
  decorateUser,
} from '../src/admin-domain.js';

test('parsePriceCents converts euros to integer cents', () => {
  assert.deepEqual(parsePriceCents('4.99'), { cents: 499 });
  assert.deepEqual(parsePriceCents('0'), { cents: 0 });
  assert.deepEqual(parsePriceCents(7), { cents: 700 });
  // Rounds to the nearest cent.
  assert.deepEqual(parsePriceCents('4.005'), { cents: 401 });
});

test('parsePriceCents rejects empty, non-numeric and negative prices', () => {
  for (const bad of ['', null, undefined, 'abc', '-1', NaN]) {
    assert.deepEqual(parsePriceCents(bad), { error: 'bad price' }, String(bad));
  }
});

test('parseFeatures trims, drops blanks and enforces limits', () => {
  assert.deepEqual(parseFeatures(['  a ', '', 'b']), { features: ['a', 'b'] });
  assert.deepEqual(parseFeatures('nope').error, 'features must be an array');
  assert.equal(parseFeatures(Array(13).fill('x')).error, 'a plan can have at most 12 features');
  assert.equal(parseFeatures(['x'.repeat(101)]).error, 'each feature must be 100 characters or less');
});

test('duplicatePlanName matches case-insensitively and honours exceptId', () => {
  const plans = [{ id: 'pro', name: 'Про' }, { id: 'std', name: ' Стандарт ' }];
  assert.equal(duplicatePlanName(plans, 'про'), true);
  assert.equal(duplicatePlanName(plans, 'СТАНДАРТ'), true);
  assert.equal(duplicatePlanName(plans, 'Новый'), false);
  // Editing a plan to its own (case-different) name is not a duplicate.
  assert.equal(duplicatePlanName(plans, 'ПРО', 'pro'), false);
});

test('validateIncident accepts a full valid incident', () => {
  assert.deepEqual(
    validateIncident({ title: ' CDN ', severity: 'outage', starts_on: '2026-06-17' }),
    { value: { title: 'CDN', severity: 'outage', starts_on: '2026-06-17', ends_on: null, note: '' } },
  );
});

test('validateIncident rejects bad fields', () => {
  assert.equal(validateIncident({ severity: 'outage', starts_on: '2026-06-17' }).error, 'incident title required');
  assert.equal(validateIncident({ title: 'x', severity: 'meltdown', starts_on: '2026-06-17' }).error, 'bad severity');
  assert.equal(validateIncident({ title: 'x', severity: 'outage', starts_on: 'nope' }).error, 'bad starts_on (YYYY-MM-DD)');
  assert.equal(
    validateIncident({ title: 'x', severity: 'outage', starts_on: '2026-06-17', ends_on: 'bad' }).error,
    'bad ends_on (YYYY-MM-DD)',
  );
});

test('validateIncident partial mode only touches provided fields', () => {
  assert.deepEqual(validateIncident({ note: ' hi ' }, { partial: true }), { value: { note: 'hi' } });
  // Severity, if present, is still validated in partial mode.
  assert.equal(validateIncident({ severity: 'nope' }, { partial: true }).error, 'bad severity');
  // A partial patch that sets no known fields validates to an empty change set.
  assert.deepEqual(validateIncident({}, { partial: true }), { value: {} });
});

test('planJson shapes a stored plan for the API', () => {
  const json = planJson({
    id: 'pro', name: 'Про', price_cents: 699, currency: 'EUR', billing_period: 'month',
    features: ['a'], sort: 2,
  });
  assert.equal(json.price, '6,99 €');
  assert.equal(json.billing_period, 'month');
  assert.deepEqual(json.features, ['a']);
});

test('incidentJson exposes ongoing state and pretty dates', () => {
  const open = incidentJson({ id: '1', title: 'x', severity: 'outage', starts_on: '2026-06-17', ends_on: null });
  assert.equal(open.ongoing, true);
  assert.equal(open.ends_pretty, null);
  const closed = incidentJson({ id: '2', title: 'y', severity: 'degraded', starts_on: '2026-06-01', ends_on: '2026-06-02' });
  assert.equal(closed.ongoing, false);
  assert.match(closed.ends_pretty, /2026/);
});

test('decorateUser builds status + playlist URLs', () => {
  const user = {
    id: 1, username: 'ivan', token: 'abc123', plan_id: 'pro', plan_name: 'Про',
    price_cents: 699, currency: 'EUR', expires_at: '2099-01-01', active: 1,
  };
  const json = decorateUser(user);
  assert.equal(json.status, 'active');
  assert.equal(json.status_label, 'АКТИВЕН');
  assert.equal(json.price, '6,99 €');
  assert.match(json.m3u_url, /\/u\/abc123\/playlist\.m3u$/);
  assert.match(json.hls_url, /\/hls\/abc123\/index\.m3u8$/);
});
