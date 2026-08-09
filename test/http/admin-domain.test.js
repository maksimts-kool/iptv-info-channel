import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePriceCents,
  parsePlanCategories,
  duplicatePlanName,
  validateIncident,  planJson,
  incidentJson,
  decorateUser,
  validatePayment,
  paymentExpiry,
  planCategoryDiff,
} from '../../src/http/admin.js';

test('validatePayment defaults to one of the plan billing period', () => {
  assert.deepEqual(validatePayment({}, { billing_period: 'month' }).value,
    { count: 1, period: 'month', from: 'expiry' });
  assert.deepEqual(validatePayment({ count: 3 }, { billing_period: 'year' }).value,
    { count: 3, period: 'year', from: 'expiry' });
  // A plan with no billing period is billed monthly.
  assert.equal(validatePayment({}, { billing_period: '' }).value.period, 'month');
  assert.equal(validatePayment({}, null).value.period, 'month');
  // An explicit period overrides the plan.
  assert.equal(validatePayment({ period: 'day' }, { billing_period: 'month' }).value.period, 'day');
});

test('validatePayment rejects nonsense counts and periods', () => {
  assert.match(validatePayment({ count: 0 }).error, /between 1 and/);
  assert.match(validatePayment({ count: 2.5 }).error, /between 1 and/);
  assert.match(validatePayment({ count: 999 }).error, /between 1 and/);
  assert.match(validatePayment({ period: 'week' }).error, /period must be one of/);
  assert.match(validatePayment({ from: 'yesterday' }).error, /from must be/);
});

test('paymentExpiry stacks paid time on top of an unexpired subscription', () => {
  const today = '2026-08-10';
  // Renewing early keeps the remaining days.
  assert.equal(
    paymentExpiry({ expires_at: '2026-09-01' }, { period: 'month', count: 1 }, today),
    '2026-10-01',
  );
  // A lapsed account restarts from today, not from the date it lapsed on.
  assert.equal(
    paymentExpiry({ expires_at: '2026-05-01' }, { period: 'month', count: 1 }, today),
    '2026-09-10',
  );
  // An open-ended account gets its first date from today.
  assert.equal(
    paymentExpiry({ expires_at: null }, { period: 'year', count: 1 }, today),
    '2027-08-10',
  );
  // …and 'today' forces that even when time is left.
  assert.equal(
    paymentExpiry({ expires_at: '2026-12-01' }, { period: 'month', count: 1, from: 'today' }, today),
    '2026-09-10',
  );
});

test('planCategoryDiff reports what a plan edit gave and took away', () => {
  assert.deepEqual(planCategoryDiff(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] });
  assert.deepEqual(planCategoryDiff(['a'], ['a']), { added: [], removed: [] });
  assert.deepEqual(planCategoryDiff([], ['a']), { added: ['a'], removed: [] });
});

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

test('parsePlanCategories de-duplicates and rejects unknown categories', () => {
  const known = new Set(['c1', 'c2']);
  assert.deepEqual(parsePlanCategories([' c1 ', 'c2', 'c1', ''], known), { categoryIds: ['c1', 'c2'] });
  assert.deepEqual(parsePlanCategories([]), { categoryIds: [] });
  assert.equal(parsePlanCategories('nope').error, 'category_ids must be an array');
  // A stale admin tab must not be able to grant a category that no longer exists.
  assert.equal(parsePlanCategories(['c1', 'gone'], known).error, 'unknown category: gone');
  // Without a known-set the ids pass through (the store tolerates stale ids).
  assert.deepEqual(parsePlanCategories(['whatever']), { categoryIds: ['whatever'] });
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

test('planJson resolves the plan package to category names', () => {
  const names = new Map([['c1', 'Спорт'], ['c2', 'Новости']]);
  const json = planJson({
    id: 'pro', name: 'Про', price_cents: 699, currency: 'EUR', billing_period: 'month',
    category_ids: ['c1', 'c2'], sort: 2,
  }, names);
  assert.equal(json.price, '6,99 €');
  assert.equal(json.billing_period, 'month');
  assert.deepEqual(json.category_ids, ['c1', 'c2']);
  // `features` is what the on-screen plan cards render — the category names.
  assert.deepEqual(json.features, ['Спорт', 'Новости']);
});

test('planJson drops category ids whose category is gone', () => {
  const json = planJson({ id: 'p', name: 'P', price_cents: 0, category_ids: ['c1', 'stale'] },
    new Map([['c1', 'Спорт']]));
  assert.deepEqual(json.features, ['Спорт'], 'no blank bullet for the missing one');
  assert.deepEqual(json.category_ids, ['c1', 'stale'], 'the raw list is preserved');
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
