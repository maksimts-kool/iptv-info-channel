// Pure validation + view-model helpers from the catalog admin API. Same split
// as test/http/admin-domain.test.js: these functions carry no Express and no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSource, validateCategory, validateChannelPatch,
  parseChannelQuery, personalRowJson, isLocked, channelJson, categoryJson,
} from '../../src/http/catalog.js';

test('validateSource requires a name and an http(s) URL', () => {
  assert.deepEqual(
    validateSource({ name: ' Провайдер ', url: 'https://p/list.m3u' }),
    { value: { name: 'Провайдер', url: 'https://p/list.m3u' } },
  );
  assert.equal(validateSource({ name: '', url: 'https://p' }).error, 'source name required');
  assert.equal(validateSource({ name: 'x', url: 'not a url' }).error, 'playlist URL is not valid');
  // Non-http schemes must never reach the fetcher.
  assert.equal(validateSource({ name: 'x', url: 'file:///etc/passwd' }).error, 'playlist URL must be http(s)');
});

test('validateSource partial patches touch only what was sent', () => {
  assert.deepEqual(validateSource({ enabled: false }, { partial: true }), { value: { enabled: false } });
  assert.equal(validateSource({ enabled: 'no' }, { partial: true }).error, 'enabled must be a boolean');
});

test('validateCategory trims the name and type-checks the toggle', () => {
  assert.deepEqual(validateCategory({ name: '  Спорт ' }), { value: { name: 'Спорт' } });
  assert.equal(validateCategory({ name: '   ' }).error, 'category name required');
  assert.equal(validateCategory({ name: 'x', enabled: 1 }).error, 'enabled must be a boolean');
});

test('validateChannelPatch rejects an empty patch', () => {
  assert.equal(validateChannelPatch({}).error, 'nothing to update');
  assert.deepEqual(
    validateChannelPatch({ name: ' НТВ ', enabled: false, category_id: 'c1' }),
    { value: { name: 'НТВ', enabled: false, category_id: 'c1' } },
  );
});

test('parseChannelQuery clamps paging and falls back to safe defaults', () => {
  assert.deepEqual(parseChannelQuery({}), {
    q: '', categoryId: '', sourceId: '', status: 'all', page: 1, pageSize: 50,
  });
  assert.equal(parseChannelQuery({ pageSize: '100000' }).pageSize, 500);
  assert.equal(parseChannelQuery({ page: '-3' }).page, 1);
  assert.equal(parseChannelQuery({ status: 'nonsense' }).status, 'all');
  assert.equal(parseChannelQuery({ status: 'disabled' }).status, 'disabled');
});

test('personalRowJson reports global value, pin and effective result', () => {
  assert.deepEqual(
    personalRowJson({ enabled: true }, undefined, {}),
    { global_enabled: true, override: null, effective: true },
  );
  assert.deepEqual(
    personalRowJson({ enabled: true }, false, {}),
    { global_enabled: true, override: false, effective: false },
  );
  // A locked account shows everything as off…
  assert.equal(personalRowJson({ enabled: true }, true, { locked: true }).effective, false);
  // …except the built-in info rows, which are forced on.
  assert.equal(personalRowJson({ enabled: true }, null, { locked: true, forced: true }).effective, true);
});

test('isLocked follows the account status, not the calendar directly', () => {
  const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const past = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  assert.equal(isLocked({ active: 1, expires_at: future }, 7), false);
  assert.equal(isLocked({ active: 1, expires_at: past }, 7), true, 'expired');
  assert.equal(isLocked({ active: 0, expires_at: future }, 7), true, 'manually disabled');
  assert.equal(isLocked({ active: 1, expires_at: null }, 7), false, 'no expiry = perpetual');
});

test('channelJson flags a channel the admin renamed away from upstream', () => {
  const base = {
    id: 'c', category_id: 'cat', source_id: 's', url: 'http://a', attrs: {}, enabled: true,
  };
  assert.equal(channelJson({ ...base, name: 'A', original_name: 'A' }).renamed, false);
  assert.equal(channelJson({ ...base, name: 'НТВ', original_name: 'NTV RAW' }).renamed, true);
});

test('categoryJson folds in the channel counts', () => {
  const counts = new Map([['c1', { total: 12, enabled: 9 }]]);
  const json = categoryJson({ id: 'c1', name: 'Спорт', sort: 3 }, counts);
  assert.equal(json.channels, 12);
  assert.equal(json.channels_enabled, 9);
  assert.equal(json.enabled, true);
  // An unknown category simply reports zero rather than throwing.
  assert.equal(categoryJson({ id: 'zz', name: 'X' }, counts).channels, 0);
});
