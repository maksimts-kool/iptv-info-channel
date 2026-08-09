// End-to-end pass over the catalog: import an upstream playlist through the
// admin API, curate it, personalise one customer, and check the .m3u each
// customer's player actually downloads — including the expiry gate.
//
// Runs against the real routers with a throwaway DATA_DIR, so it also proves the
// two JSON stores (db.json + catalog.json) and the router wiring hold together.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-route-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://iptv.example';
process.env.EPG_FOSS_ENABLED = 'false';
// Creating/updating a user kicks off a fire-and-forget ffmpeg encode of the info
// channel. That is not what this suite is testing, so point the encoder at a
// binary that does not exist: the job fails instantly (the admin route already
// swallows it) instead of burning CPU and racing the teardown.
process.env.FFMPEG_PATH = 'ffmpeg-absent-in-tests';

const UPSTREAM = [
  '#EXTM3U url-tvg="http://provider/epg.xml"',
  '#EXTINF:-1 tvg-id="s1" tvg-logo="http://p/1.png" group-title="Спорт",Sport 1',
  'http://provider/1.ts',
  '#EXTINF:-1 tvg-id="s2" group-title="Спорт",Sport 2',
  'http://provider/2.ts',
  '#EXTINF:-1 tvg-id="n1" group-title="Новости",News 1',
  'http://provider/3.ts',
].join('\n');

let app;
let server;
let base;
let cookie;
let csrf;
let upstreamServer;
let upstreamUrl;

async function req(method, url, body, { raw = false } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const adminRoutes = (await import('../src/http/admin.js')).default;
  const streamRoutes = (await import('../src/http/stream.js')).default;
  const { sessionValue, csrfToken } = await import('../src/http/auth.js');

  app = express();
  app.use(cookieParser());
  app.use('/admin', adminRoutes);
  app.use('/', streamRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `admin_session=${sessionValue()}`;
  csrf = csrfToken();

  // A local stand-in for the provider, so the import path is exercised for real.
  upstreamServer = http.createServer((r, res) => {
    res.writeHead(200, { 'content-type': 'application/x-mpegurl' });
    res.end(UPSTREAM);
  });
  upstreamServer.listen(0);
  await new Promise((r) => upstreamServer.once('listening', r));
  upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}/list.m3u`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstreamServer.close(r));
  // Best effort: a background encode job may still hold a handle in here on
  // Windows, and a failed cleanup must not fail the suite.
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* temp dir */ }
});

// Ids discovered as the suite walks through the flow.
const ids = {};

test('a fresh catalog has only the built-in Информация category', async () => {
  const { status, body } = await req('GET', '/admin/api/catalog');
  assert.equal(status, 200);
  assert.deepEqual(body.categories.map((c) => c.name), ['Информация']);
  assert.equal(body.categories[0].builtin, true);
  assert.equal(body.totals.channels, 1);
});

test('adding and refreshing a source imports the upstream channels', async () => {
  const created = await req('POST', '/admin/api/catalog/sources', {
    name: 'Провайдер', url: upstreamUrl,
  });
  assert.equal(created.status, 201);
  ids.source = created.body.id;

  const refreshed = await req('POST', `/admin/api/catalog/sources/${ids.source}/refresh`);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.stats.added, 3);

  const { body } = await req('GET', '/admin/api/catalog');
  assert.deepEqual(body.categories.map((c) => c.name), ['Информация', 'Спорт', 'Новости']);
  assert.equal(body.totals.channels, 4); // 3 imported + the info channel
  // The provider's own guide is remembered for pass-through.
  assert.equal(body.sources[0].epg_url, 'http://provider/epg.xml');

  ids.sport = body.categories.find((c) => c.name === 'Спорт').id;
  ids.news = body.categories.find((c) => c.name === 'Новости').id;
});

test('a bad source URL is reported, not swallowed', async () => {
  const created = await req('POST', '/admin/api/catalog/sources', {
    name: 'Мёртвый', url: 'http://127.0.0.1:1/none.m3u',
  });
  const refreshed = await req('POST', `/admin/api/catalog/sources/${created.body.id}/refresh`);
  assert.equal(refreshed.status, 502);

  const { body } = await req('GET', '/admin/api/catalog');
  assert.ok(body.sources.find((s) => s.id === created.body.id).last_error);
  await req('DELETE', `/admin/api/catalog/sources/${created.body.id}`);
});

test('the info category cannot be switched off or deleted', async () => {
  const { body } = await req('GET', '/admin/api/catalog');
  const info = body.categories.find((c) => c.builtin);
  assert.equal((await req('PATCH', `/admin/api/catalog/categories/${info.id}`, { name: 'Инфо', enabled: false })).status, 400);
  assert.equal((await req('DELETE', `/admin/api/catalog/categories/${info.id}`)).status, 400);
});

test('a plan grants categories, and its contents read back as their names', async () => {
  const plans = (await req('GET', '/admin/api/state')).body.plans;
  ids.plan = plans[0].id;

  const updated = await req('PATCH', `/admin/api/plans/${ids.plan}`, {
    category_ids: [ids.sport, ids.news],
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.category_ids, [ids.sport, ids.news]);
  // What the info channel prints as "what you get".
  assert.deepEqual(updated.body.features, ['Спорт', 'Новости']);

  // A stale tab can't grant a category that doesn't exist.
  const bad = await req('PATCH', `/admin/api/plans/${ids.plan}`, { category_ids: ['nope'] });
  assert.equal(bad.status, 400);
});

test('a customer receives the categories their plan grants', async () => {
  const created = await req('POST', '/admin/api/users', {
    username: 'ivan',
    plan_id: ids.plan,
    expires_at: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10),
  });
  assert.equal(created.status, 201);
  ids.user = created.body.id;
  ids.token = created.body.token;

  const { status, text } = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.equal(status, 200);
  assert.match(text, /group-title="Информация"/);
  assert.match(text, /group-title="Спорт",Sport 1/);
  assert.match(text, /group-title="Новости",News 1/);
  // Our EPG first, the provider's appended.
  assert.match(text, /url-tvg="https:\/\/iptv\.example\/u\/[^"]+\/epg\.xml,http:\/\/provider\/epg\.xml"/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 4);
});

test('renaming a channel and moving it between categories shows up in the .m3u', async () => {
  const list = await req('GET', `/admin/api/catalog/channels?category=${ids.sport}`);
  const sport1 = list.body.rows.find((c) => c.name === 'Sport 1');
  ids.sport1 = sport1.id;

  await req('PATCH', `/admin/api/catalog/channels/${sport1.id}`, {
    name: 'Спорт Первый', category_id: ids.news,
  });

  const { text } = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.match(text, /group-title="Новости",Спорт Первый/);
  assert.doesNotMatch(text, /Sport 1/);
});

test('disabling a category globally removes it from every customer', async () => {
  await req('PATCH', `/admin/api/catalog/categories/${ids.news}`, { enabled: false });
  const { text } = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.doesNotMatch(text, /group-title="Новости"/);
  assert.match(text, /group-title="Спорт",Sport 2/);
  await req('PATCH', `/admin/api/catalog/categories/${ids.news}`, { enabled: true });
});

test('a plan with no categories leaves its customers with Информация alone', async () => {
  const created = await req('POST', '/admin/api/plans', {
    name: 'Пустой', price_eur: 1, category_ids: [],
  });
  assert.equal(created.status, 201);
  const user = await req('POST', '/admin/api/users', {
    username: 'empty-plan',
    plan_id: created.body.id,
    expires_at: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10),
  });

  const { text } = await req('GET', `/u/${user.body.token}/playlist.m3u`, null, { raw: true });
  assert.equal(text.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 1);
  assert.match(text, /group-title="Информация"/);

  // Moving them onto the real plan fills the playlist immediately.
  await req('PATCH', `/admin/api/users/${user.body.id}`, { plan_id: ids.plan });
  const after = await req('GET', `/u/${user.body.token}/playlist.m3u`, null, { raw: true });
  assert.equal(after.text.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 4);

  await req('DELETE', `/admin/api/users/${user.body.id}`);
});

test('narrowing the plan removes a category from every customer on it', async () => {
  await req('PATCH', `/admin/api/plans/${ids.plan}`, { category_ids: [ids.news] });
  const { text } = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.doesNotMatch(text, /group-title="Спорт"/);
  assert.match(text, /group-title="Новости"/);
  await req('PATCH', `/admin/api/plans/${ids.plan}`, { category_ids: [ids.sport, ids.news] });
});

test('a per-customer override hides a category for that customer only', async () => {
  const other = await req('POST', '/admin/api/users', {
    username: 'petr',
    plan_id: ids.plan,
    expires_at: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10),
  });

  const patched = await req('PATCH', `/admin/api/users/${ids.user}/channels`, {
    categories: { [ids.sport]: false },
  });
  assert.equal(patched.status, 200);

  const mine = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.doesNotMatch(mine.text, /group-title="Спорт"/);

  const theirs = await req('GET', `/u/${other.body.token}/playlist.m3u`, null, { raw: true });
  assert.match(theirs.text, /group-title="Спорт",Sport 2/, 'other customers are untouched');

  // …and the client list surfaces that this customer is personalised.
  const state = await req('GET', '/admin/api/state');
  assert.equal(state.body.users.find((u) => u.id === ids.user).personal_overrides, 1);

  await req('POST', `/admin/api/users/${ids.user}/channels/reset`);
  const back = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.match(back.text, /group-title="Спорт"/);
});

test('a globally disabled channel can still be granted to one customer', async () => {
  await req('PATCH', `/admin/api/catalog/channels/${ids.sport1}`, { enabled: false });
  const without = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.doesNotMatch(without.text, /Спорт Первый/);

  await req('PATCH', `/admin/api/users/${ids.user}/channels`, {
    channels: { [ids.sport1]: true },
  });
  const withIt = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.match(withIt.text, /Спорт Первый/);

  await req('POST', `/admin/api/users/${ids.user}/channels/reset`);
  await req('PATCH', `/admin/api/catalog/channels/${ids.sport1}`, { enabled: true });
});

test('an expired subscription collapses the playlist to Информация, and renewal restores it', async () => {
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  await req('PATCH', `/admin/api/users/${ids.user}`, { expires_at: yesterday });

  const locked = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.equal(locked.text.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 1);
  assert.match(locked.text, /group-title="Информация"/);

  // The admin view agrees, and the personal settings are still on file.
  const view = await req('GET', `/admin/api/users/${ids.user}/channels`);
  assert.equal(view.body.locked, true);
  assert.equal(view.body.visibleCount, 1);

  const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await req('PATCH', `/admin/api/users/${ids.user}`, { expires_at: future });
  const renewed = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.equal(renewed.text.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 4);
});

test('deactivating a customer locks the playlist the same way', async () => {
  await req('PATCH', `/admin/api/users/${ids.user}`, { active: false });
  const locked = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.equal(locked.text.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 1);
  await req('PATCH', `/admin/api/users/${ids.user}`, { active: true });
});

test('bulk disable over the current filter takes a whole category off air', async () => {
  const res = await req('POST', '/admin/api/catalog/channels/bulk', {
    enabled: false, filter: { category: ids.sport },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.changed >= 1);

  const { text } = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.doesNotMatch(text, /Sport 2/);

  await req('POST', '/admin/api/catalog/channels/bulk', {
    enabled: true, filter: { category: ids.sport },
  });
});

test('a refresh after an upstream change keeps the admin edits', async () => {
  await req('POST', `/admin/api/catalog/sources/${ids.source}/refresh`);
  const { text } = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  // Still renamed and still living in Новости after re-importing the same file.
  assert.match(text, /group-title="Новости",Спорт Первый/);
});

test('the admin sees which categories a plan sells and flags the unsold ones', async () => {
  const { body } = await req('GET', '/admin/api/catalog');
  const sport = body.categories.find((c) => c.id === ids.sport);
  assert.equal(sport.plans, 1, 'one plan grants Спорт');
  // The seeded second plan grants nothing, so it is reported as empty.
  assert.ok(body.totals.emptyPlans >= 1);
});

test('deleting a category removes it from the plans that granted it', async () => {
  const created = await req('POST', '/admin/api/catalog/categories', { name: 'Временная' });
  const tempId = created.body.id;
  await req('PATCH', `/admin/api/plans/${ids.plan}`, {
    category_ids: [ids.sport, ids.news, tempId],
  });

  await req('DELETE', `/admin/api/catalog/categories/${tempId}`);

  const plan = (await req('GET', '/admin/api/state')).body.plans.find((p) => p.id === ids.plan);
  assert.deepEqual(plan.category_ids, [ids.sport, ids.news], 'the dead id is gone');
  // …and the customer's playlist is unaffected.
  const { text } = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.equal(text.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 4);
});

test("the per-customer view separates 'not in the plan' from 'switched off'", async () => {
  await req('PATCH', `/admin/api/plans/${ids.plan}`, { category_ids: [ids.sport] });
  const { body } = await req('GET', `/admin/api/users/${ids.user}/channels`);

  const sport = body.categories.find((c) => c.id === ids.sport);
  const news = body.categories.find((c) => c.id === ids.news);
  assert.deepEqual(
    { in_plan: sport.in_plan, effective: sport.effective },
    { in_plan: true, effective: true },
  );
  assert.deepEqual(
    { in_plan: news.in_plan, global_enabled: news.global_enabled, effective: news.effective },
    { in_plan: false, global_enabled: true, effective: false },
    'enabled catalog-wide, simply not sold to this plan',
  );
  assert.equal(body.plan.id, ids.plan);
  assert.deepEqual(body.plan.categories, [ids.sport]);

  await req('PATCH', `/admin/api/plans/${ids.plan}`, { category_ids: [ids.sport, ids.news] });
});

test('mutating catalog calls are rejected without a CSRF token', async () => {
  const saved = csrf;
  csrf = '';
  const res = await req('POST', '/admin/api/catalog/sources', { name: 'x', url: 'http://a/b.m3u' });
  assert.equal(res.status, 403);
  csrf = saved;
});

test('the catalog API is not reachable without a session', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await req('GET', '/admin/api/catalog')).status, 401);
  cookie = saved;
});

test('deleting a customer drops their personal overrides', async () => {
  await req('PATCH', `/admin/api/users/${ids.user}/channels`, { categories: { [ids.sport]: false } });
  await req('DELETE', `/admin/api/users/${ids.user}`);
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
  assert.equal(raw.overrides[String(ids.user)], undefined);
});
