import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u } from '../src/playlist/m3u.js';
import {
  INFO_CATEGORY_ID, INFO_CHANNEL_ID,
  ensureBuiltins, mergeSourceChannels, resolveUserChannels,
  effectiveEnabled, categoryEnabledFor, channelKey, categoryKey, channelCounts,
} from '../src/playlist/model.js';

let counter = 0;
const makeId = () => `id${++counter}`;
const emptyState = () => ensureBuiltins({ categories: [], channels: [], overrides: {} });

const PLAYLIST = [
  '#EXTM3U url-tvg="http://p/epg.xml"',
  '#EXTINF:-1 tvg-id="s1" group-title="Спорт",Sport 1',
  'http://p/1.ts',
  '#EXTINF:-1 tvg-id="s2" group-title="Спорт",Sport 2',
  'http://p/2.ts',
  '#EXTINF:-1 tvg-id="n1" group-title="Новости",News 1',
  'http://p/3.ts',
].join('\n');

function seeded() {
  counter = 0;
  const state = emptyState();
  const stats = mergeSourceChannels(state, 'src1', parseM3u(PLAYLIST), { makeId });
  return { state, stats };
}

test('ensureBuiltins creates the info category and channel exactly once', () => {
  const state = emptyState();
  ensureBuiltins(state);
  assert.equal(state.categories.filter((c) => c.id === INFO_CATEGORY_ID).length, 1);
  assert.equal(state.channels.filter((c) => c.id === INFO_CHANNEL_ID).length, 1);
  assert.equal(state.categories[0].builtin, true);
});

test('merging an upstream playlist creates categories and channels', () => {
  const { state, stats } = seeded();
  assert.deepEqual(stats, { added: 3, updated: 0, missing: 0, restored: 0 });
  // Информация plus the two imported groups.
  assert.deepEqual(
    state.categories.map((c) => c.name),
    ['Информация', 'Спорт', 'Новости'],
  );
  assert.equal(state.channels.filter((c) => c.source_id === 'src1').length, 3);
});

test('two sources publishing the same group name share one category', () => {
  const { state } = seeded();
  mergeSourceChannels(state, 'src2', parseM3u([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="s9" group-title="спорт",Sport 9',
    'http://q/9.ts',
  ].join('\n')), { makeId });

  assert.equal(state.categories.filter((c) => categoryKey(c.name) === 'спорт').length, 1);
});

test('a refresh keeps admin edits but takes the new upstream URL', () => {
  const { state } = seeded();
  const sport1 = state.channels.find((c) => c.attrs['tvg-id'] === 's1');
  sport1.name = 'Спорт Первый';
  sport1.enabled = false;
  sport1.category_id = state.categories.find((c) => c.name === 'Новости').id;

  const stats = mergeSourceChannels(state, 'src1', parseM3u([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="s1" group-title="Спорт",SPORT ONE RENAMED UPSTREAM',
    'http://p/rotated-token/1.ts',
    '#EXTINF:-1 tvg-id="s2" group-title="Спорт",Sport 2',
    'http://p/2.ts',
    '#EXTINF:-1 tvg-id="n1" group-title="Новости",News 1',
    'http://p/3.ts',
  ].join('\n')), { makeId });

  assert.equal(stats.added, 0);
  assert.equal(stats.updated, 3);
  const after = state.channels.find((c) => c.attrs['tvg-id'] === 's1');
  assert.equal(after.name, 'Спорт Первый', 'admin rename survives');
  assert.equal(after.enabled, false, 'admin disable survives');
  assert.equal(after.category_id, state.categories.find((c) => c.name === 'Новости').id);
  assert.equal(after.url, 'http://p/rotated-token/1.ts', 'the playable URL is refreshed');
  assert.equal(after.original_name, 'SPORT ONE RENAMED UPSTREAM');
});

test('channels that vanish upstream are flagged missing, not deleted, and come back', () => {
  const { state } = seeded();
  const shrunk = ['#EXTM3U', '#EXTINF:-1 tvg-id="s1" group-title="Спорт",Sport 1', 'http://p/1.ts'].join('\n');

  const gone = mergeSourceChannels(state, 'src1', parseM3u(shrunk), { makeId });
  assert.equal(gone.missing, 2);
  assert.equal(state.channels.filter((c) => c.source_id === 'src1').length, 3, 'rows are kept');
  assert.equal(state.channels.find((c) => c.attrs['tvg-id'] === 'n1').missing, true);

  const back = mergeSourceChannels(state, 'src1', parseM3u(PLAYLIST), { makeId });
  assert.equal(back.restored, 2);
  assert.equal(state.channels.find((c) => c.attrs['tvg-id'] === 'n1').missing, false);
});

test('channelKey prefers tvg-id so a rotated stream URL is still the same channel', () => {
  const a = { attrs: { 'tvg-id': 'x' }, url: 'http://a/1.ts' };
  const b = { attrs: { 'tvg-id': 'x' }, url: 'http://a/TOKEN2/1.ts' };
  assert.equal(channelKey('s', a), channelKey('s', b));
  // …and falls back to the URL when the provider ships no tvg-id.
  assert.equal(channelKey('s', { attrs: {}, url: 'http://a/1.ts' }), 's|url:http://a/1.ts');
  // Two providers carrying the same channel stay distinct.
  assert.notEqual(channelKey('s1', a), channelKey('s2', a));
});

test('effectiveEnabled: a per-customer pin overrides the global value both ways', () => {
  assert.equal(effectiveEnabled({ enabled: true }, undefined), true);
  assert.equal(effectiveEnabled({ enabled: false }, undefined), false);
  assert.equal(effectiveEnabled({ enabled: true }, false), false, 'pin can take a channel away');
  assert.equal(effectiveEnabled({ enabled: false }, true), true, 'pin can grant a hidden channel');
});

test('categoryEnabledFor: pin beats the kill switch, which beats the plan', () => {
  const cat = { id: 'c1', enabled: true };
  const inPlan = new Set(['c1']);
  const notInPlan = new Set(['other']);

  assert.equal(categoryEnabledFor(cat, undefined, inPlan), true);
  assert.equal(categoryEnabledFor(cat, undefined, notInPlan), false, 'not sold to this plan');
  assert.equal(categoryEnabledFor(cat, true, notInPlan), true, 'pin grants beyond the plan');
  assert.equal(categoryEnabledFor(cat, false, inPlan), false, 'pin takes away from the plan');
  // The global kill switch outranks the plan but not an explicit pin.
  assert.equal(categoryEnabledFor({ id: 'c1', enabled: false }, undefined, inPlan), false);
  assert.equal(categoryEnabledFor({ id: 'c1', enabled: false }, true, inPlan), true);
  // No plan supplied = unrestricted (admin previews).
  assert.equal(categoryEnabledFor(cat, undefined, null), true);
});

test('resolveUserChannels returns every enabled channel when no plan restricts it', () => {
  const { state } = seeded();
  const names = resolveUserChannels(state).map((e) => e.channel.name);
  assert.deepEqual(names, ['', 'Sport 1', 'Sport 2', 'News 1']);
  // The info channel leads the list (its category sorts first).
  assert.equal(resolveUserChannels(state)[0].channel.id, INFO_CHANNEL_ID);
});

test('a customer only receives the categories their plan grants', () => {
  const { state } = seeded();
  const sport = state.categories.find((c) => c.name === 'Спорт');

  const names = resolveUserChannels(state, {
    planCategories: new Set([sport.id]),
  }).map((e) => e.channel.name);
  assert.deepEqual(names, ['', 'Sport 1', 'Sport 2'], 'news is not in the plan');
});

test('a plan granting nothing leaves the customer with Информация alone', () => {
  const { state } = seeded();
  const entries = resolveUserChannels(state, { planCategories: new Set() });
  assert.deepEqual(entries.map((e) => e.channel.id), [INFO_CHANNEL_ID]);
});

test('changing the plan changes the playlist with no other edit', () => {
  const { state } = seeded();
  const sport = state.categories.find((c) => c.name === 'Спорт');
  const news = state.categories.find((c) => c.name === 'Новости');

  const cheap = resolveUserChannels(state, { planCategories: new Set([news.id]) });
  const full = resolveUserChannels(state, { planCategories: new Set([sport.id, news.id]) });
  assert.deepEqual(cheap.map((e) => e.channel.name), ['', 'News 1']);
  assert.deepEqual(full.map((e) => e.channel.name), ['', 'Sport 1', 'Sport 2', 'News 1']);
});

test('a personal pin is an exception on top of the plan, in both directions', () => {
  const { state } = seeded();
  const sport = state.categories.find((c) => c.name === 'Спорт');
  const news = state.categories.find((c) => c.name === 'Новости');
  const planCategories = new Set([sport.id]); // paying for sport only

  const bonus = resolveUserChannels(state, {
    planCategories,
    overrides: { categories: { [news.id]: true } },
  });
  assert.deepEqual(bonus.map((e) => e.channel.name), ['', 'Sport 1', 'Sport 2', 'News 1']);

  const trimmed = resolveUserChannels(state, {
    planCategories,
    overrides: { categories: { [sport.id]: false } },
  });
  assert.deepEqual(trimmed.map((e) => e.channel.name), ['']);
});

test('the global kill switch hides a category even from a plan that grants it', () => {
  const { state } = seeded();
  const sport = state.categories.find((c) => c.name === 'Спорт');
  sport.enabled = false;
  const names = resolveUserChannels(state, {
    planCategories: new Set([sport.id]),
  }).map((e) => e.channel.name);
  assert.deepEqual(names, ['']);
});

test('a globally disabled category hides its channels', () => {
  const { state } = seeded();
  state.categories.find((c) => c.name === 'Спорт').enabled = false;
  const names = resolveUserChannels(state).map((e) => e.channel.name);
  assert.deepEqual(names, ['', 'News 1']);
});

test('per-customer overrides subtract and grant without touching other customers', () => {
  const { state } = seeded();
  const sport = state.categories.find((c) => c.name === 'Спорт');
  const news = state.categories.find((c) => c.name === 'Новости');
  news.enabled = false; // globally off

  const vip = resolveUserChannels(state, {
    overrides: { categories: { [news.id]: true } },
  }).map((e) => e.channel.name);
  assert.deepEqual(vip, ['', 'Sport 1', 'Sport 2', 'News 1'], 'granted the hidden category');

  const trimmed = resolveUserChannels(state, {
    overrides: { categories: { [sport.id]: false } },
  }).map((e) => e.channel.name);
  assert.deepEqual(trimmed, [''], 'lost sport, never had news');

  // The catalog itself is untouched by either resolution.
  assert.equal(sport.enabled, true);
});

test('a single channel can be withheld from one customer', () => {
  const { state } = seeded();
  const sport2 = state.channels.find((c) => c.name === 'Sport 2');
  const names = resolveUserChannels(state, {
    overrides: { channels: { [sport2.id]: false } },
  }).map((e) => e.channel.name);
  assert.deepEqual(names, ['', 'Sport 1', 'News 1']);
});

test('a locked account keeps only Информация, whatever its plan or overrides say', () => {
  const { state } = seeded();
  const sport = state.categories.find((c) => c.name === 'Спорт');
  const entries = resolveUserChannels(state, {
    locked: true,
    planCategories: new Set(state.categories.map((c) => c.id)),
    overrides: { categories: { [sport.id]: true } },
  });
  assert.deepEqual(entries.map((e) => e.channel.id), [INFO_CHANNEL_ID]);
  assert.equal(entries[0].category.id, INFO_CATEGORY_ID);
});

test('unlocking restores the plan\'s categories with no write in between', () => {
  const { state } = seeded();
  const sport = state.categories.find((c) => c.name === 'Спорт');
  const plan = { planCategories: new Set([sport.id]) };
  assert.equal(resolveUserChannels(state, { ...plan, locked: true }).length, 1);
  assert.equal(resolveUserChannels(state, { ...plan, locked: false }).length, 3);
});

test('missing channels never reach a customer', () => {
  const { state } = seeded();
  state.channels.find((c) => c.name === 'Sport 1').missing = true;
  const names = resolveUserChannels(state).map((e) => e.channel.name);
  assert.deepEqual(names, ['', 'Sport 2', 'News 1']);
});

test('channelCounts totals per category and ignores missing rows', () => {
  const { state } = seeded();
  const sport = state.categories.find((c) => c.name === 'Спорт');
  state.channels.find((c) => c.name === 'Sport 2').enabled = false;
  state.channels.find((c) => c.name === 'News 1').missing = true;

  const counts = channelCounts(state);
  assert.deepEqual(counts.get(sport.id), { total: 2, enabled: 1 });
  assert.equal(counts.has(state.categories.find((c) => c.name === 'Новости').id), false);
});

test('duplicate lines in one upstream file are imported once', () => {
  counter = 0;
  const state = emptyState();
  const stats = mergeSourceChannels(state, 'src1', parseM3u([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="d1" group-title="A",Dup',
    'http://p/d.ts',
    '#EXTINF:-1 tvg-id="d1" group-title="A",Dup again',
    'http://p/d.ts',
  ].join('\n')), { makeId });
  assert.equal(stats.added, 1);
});
