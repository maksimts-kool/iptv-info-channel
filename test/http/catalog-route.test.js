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

const HLS_MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
  '#EXTINF:6.000,',
  'seg_001.ts',
  '#EXTINF:6.000,',
  'seg_002.ts',
].join('\n');

const MASTER_MANIFEST = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="ru",URI="audio/ru.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aud"',
  'v1/index.m3u8?token=abc',
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
  const adminRoutes = (await import('../../src/http/admin.js')).default;
  const streamRoutes = (await import('../../src/http/stream.js')).default;
  const { sessionValue, csrfToken } = await import('../../src/http/auth.js');

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
  // It also serves one HLS media playlist with RELATIVE segment names, which is
  // what the stream gateway has to rewrite before a player can use it.
  upstreamServer = http.createServer((r, res) => {
    // A master playlist one level up from its variant + audio rendition, like
    // most real providers: the player fetches it once and then only refreshes
    // the variant — which is why the gate has to own the variant URLs too.
    if (r.url === '/master/index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(MASTER_MANIFEST);
      return;
    }
    if (r.url.startsWith('/master/') || r.url.startsWith('/live/')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(HLS_MANIFEST);
      return;
    }
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
  assert.equal(body.totals.channels, 2); // the account + media channels
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
  assert.equal(body.totals.channels, 5); // 3 imported + the account and media channels
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

// Follow nothing: the gateway's answer IS the redirect, so the test has to see
// it rather than the provider's 404.
async function hop(url) {
  const res = await fetch(`${base}${url}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') };
}

async function get(url) {
  const res = await fetch(`${base}${url}`, { redirect: 'manual' });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
}

// A stand-in for the customer's encoded info loop (ffmpeg is absent here), so
// the gateway has something to cut a refused viewer over to.
function writeInfoLoop(userId) {
  const dir = path.join(DATA_DIR, 'hls', String(userId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:6.000000,', 'seg_000.ts', '#EXTINF:6.000000,', 'seg_001.ts', '#EXT-X-ENDLIST', '',
  ].join('\n'));
  for (const f of ['seg_000.ts', 'seg_001.ts']) fs.writeFileSync(path.join(dir, f), 'ts');
}

test('the stream gateway serves the provider manifest, rewritten, per request', async () => {
  const upstreamOrigin = new URL(upstreamUrl).origin;
  const hls = await req('POST', '/admin/api/catalog/channels', {
    name: 'HLS Channel', url: `${upstreamOrigin}/live/1.m3u8`, category_id: ids.sport,
  });
  assert.equal(hls.status, 201);
  ids.hls = hls.body.id;

  const enabled = await req('PATCH', '/admin/api/gateway', { enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);

  const infoStream = `https://iptv.example/hls/${ids.token}/index.m3u8`;

  // The playlist hands the player our gate link for the HLS channel — and
  // leaves the raw-TS ones pointing straight at the provider, because gating
  // those would need a cross-protocol redirect no Android player will follow.
  // The link carries the downloading client's device tag, and ends in .m3u8 on
  // purpose: ExoPlayer picks its media source from the URL extension, so an
  // extensionless one plays a black screen.
  const gated = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  const published = gated.text.match(
    new RegExp(`^https://iptv\\.example(/c/${ids.token}/[A-Za-z0-9_-]+/${ids.hls}\\.m3u8)$`, 'm'),
  );
  assert.ok(published, 'the HLS channel is published as a tagged gate link');
  const gate = published[1];
  assert.match(gated.text, /^http:\/\/provider\/2\.ts$/m);
  assert.ok(!gated.text.includes(`${upstreamOrigin}/live/1.m3u8`), 'the provider URL is not exposed');

  // Entitled: the manifest itself, with every relative URI resolved against the
  // provider — no redirect anywhere in the answer.
  const manifest = await get(gate);
  assert.equal(manifest.status, 200);
  assert.match(manifest.type, /mpegurl/);
  assert.ok(manifest.text.includes(`${upstreamOrigin}/live/seg_001.ts`));
  assert.ok(manifest.text.includes(`URI="${upstreamOrigin}/live/key.bin"`), 'the key URI is absolutised too');
  assert.doesNotMatch(manifest.text, /^seg_001\.ts$/m, 'no relative URI is left behind');

  // Take the channel away while that player is watching. Its copy of the
  // playlist is stale, but it is not bounced with a redirect (a different live
  // stream's sequence numbers would just stall it): the very next refresh
  // CONTINUES the same stream — the provider's last window, a discontinuity,
  // then the customer's own info card, with the encryption switched off at the
  // cut.
  writeInfoLoop(ids.user);
  await req('PATCH', `/admin/api/users/${ids.user}/channels`, { channels: { [ids.hls]: false } });
  const cut = await get(gate);
  assert.equal(cut.status, 200);
  assert.ok(cut.text.includes(`${upstreamOrigin}/live/seg_002.ts`), "the provider's last window is kept");
  assert.match(
    cut.text,
    new RegExp(`#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6\\.000000,\nhttps://iptv\\.example/hls/${ids.token}/seg_000\\.ts\\?s=\\d+`),
  );
  // Somebody tuning in now is simply sent to the card.
  assert.deepEqual(await hop(`/c/${ids.token}/tune1/${ids.hls}.m3u8`), { status: 302, location: infoStream });

  // Giving it back does not flip the watching player back mid-stream (it stays
  // on the card until it tunes in again); a fresh tune-in plays the channel.
  await req('POST', `/admin/api/users/${ids.user}/channels/reset`);
  assert.match((await get(gate)).text, /\/hls\//);
  const again = await get(`/c/${ids.token}/tune2/${ids.hls}.m3u8`);
  assert.equal(again.status, 200);
  assert.ok(again.text.includes(`${upstreamOrigin}/live/seg_001.ts`));

  // An expired subscription closes every channel the same way.
  const future = (await req('GET', '/admin/api/state')).body.users
    .find((u) => u.id === ids.user).expires_at;
  await req('PATCH', `/admin/api/users/${ids.user}`, { expires_at: '2000-01-01' });
  assert.deepEqual(await hop(`/c/${ids.token}/tune3/${ids.hls}.m3u8`), { status: 302, location: infoStream });
  assert.match((await get(`/c/${ids.token}/tune2/${ids.hls}.m3u8`)).text, /\/hls\//, 'mid-view: cut over');
  await req('PATCH', `/admin/api/users/${ids.user}`, { expires_at: future });

  // Playlists issued before the extension, and before the device tag, existed
  // must keep working.
  assert.equal((await get(`/c/${ids.token}/${ids.hls}`)).status, 200);
  assert.equal((await get(`/c/${ids.token}/${ids.hls}.m3u8`)).status, 200);

  assert.equal((await hop(`/c/unknown-token/${ids.hls}.m3u8`)).status, 404);
  // A channel id that no longer exists is a lapsed link, not a crash.
  assert.deepEqual(await hop(`/c/${ids.token}/gone`), { status: 302, location: infoStream });

  // Switching the gateway off returns new playlists to direct URLs, but the
  // links already sitting in customers' players keep working.
  await req('PATCH', '/admin/api/gateway', { enabled: false });
  const direct = await req('GET', `/u/${ids.token}/playlist.m3u`, null, { raw: true });
  assert.ok(direct.text.includes(`${upstreamOrigin}/live/1.m3u8`));
  assert.equal((await get(gate)).status, 200);
});

test('a dead provider is reported as a bad gateway, not as a hung request', async () => {
  await req('PATCH', '/admin/api/gateway', { enabled: true });
  const dead = await req('POST', '/admin/api/catalog/channels', {
    name: 'Dead HLS', url: 'http://127.0.0.1:1/live/none.m3u8', category_id: ids.sport,
  });
  assert.equal((await get(`/c/${ids.token}/${dead.body.id}`)).status, 502);
  await req('DELETE', `/admin/api/catalog/channels/${dead.body.id}`);
  await req('PATCH', '/admin/api/gateway', { enabled: false });
});

test('a master playlist hands out its variants through the gate, so a revocation lands mid-view', async () => {
  await req('PATCH', '/admin/api/gateway', { enabled: true });
  const origin = new URL(upstreamUrl).origin;
  const created = await req('POST', '/admin/api/catalog/channels', {
    name: 'Master HLS', url: `${origin}/master/index.m3u8`, category_id: ids.sport,
  });
  const id = created.body.id;
  writeInfoLoop(ids.user);

  const master = await get(`/c/${ids.token}/tvA/${id}.m3u8`);
  assert.equal(master.status, 200);
  assert.ok(!master.text.includes(`${origin}/master/v1`), 'no direct variant URL is handed out');
  const variants = master.text.match(/https:\/\/iptv\.example\/c\/[^\s"]+\.m3u8/g);
  assert.equal(variants.length, 2, 'the variant and the audio rendition are both gated');
  const variant = variants.find((u) => !master.text.includes(`URI="${u}"`)).replace('https://iptv.example', '');

  const playing = await get(variant);
  assert.equal(playing.status, 200);
  assert.ok(playing.text.includes(`${origin}/master/v1/seg_001.ts`), 'segments still come from the provider');

  // The signature binds the URL: the gate is not a fetch-anything proxy.
  const parts = variant.split('/');
  parts[5] = 'A'.repeat(parts[5].length);
  assert.equal((await get(parts.join('/'))).status, 404);
  const forged = Buffer.from('http://127.0.0.1:1/x.m3u8').toString('base64url');
  assert.equal((await get(`${variant.split('/').slice(0, 6).join('/')}/${forged}.m3u8`)).status, 404);

  // Revoked while watching: the variant refresh — which used to go straight to
  // the provider — is where the viewer now sees their info card.
  await req('PATCH', `/admin/api/users/${ids.user}/channels`, { channels: { [id]: false } });
  const cut = await get(variant);
  assert.equal(cut.status, 200);
  assert.match(cut.text, new RegExp(`/hls/${ids.token}/seg_000\\.ts`));

  // Re-opening the channel goes through the master again and starts clean.
  await req('POST', `/admin/api/users/${ids.user}/channels/reset`);
  await get(`/c/${ids.token}/tvA/${id}.m3u8`);
  assert.ok((await get(variant)).text.includes(`${origin}/master/v1/seg_001.ts`));
  await req('PATCH', '/admin/api/gateway', { enabled: false });
});

test('the device limit admits the first devices and sends the next to the notice', async () => {
  await req('PATCH', '/admin/api/gateway', { enabled: true });
  const plan = await req('POST', '/admin/api/plans', {
    name: 'Один экран', price_eur: 3, category_ids: [ids.sport], max_devices: 1,
  });
  assert.equal(plan.status, 201);
  assert.equal(plan.body.max_devices, 1);
  const user = await req('POST', '/admin/api/users', {
    username: 'one-screen', plan_id: plan.body.id,
    expires_at: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
  });
  const { token } = user.body;
  writeInfoLoop(user.body.id);
  const notice = 'https://iptv.example/notice/devices/index.m3u8';
  const tv = `/c/${token}/tv/${ids.hls}.m3u8`;
  const phone = `/c/${token}/phone/${ids.hls}.m3u8`;

  assert.equal((await get(tv)).status, 200);
  // The TV keeps its slot on every refresh; the phone tuning in is turned away.
  assert.equal((await get(tv)).status, 200);
  assert.deepEqual(await hop(phone), { status: 302, location: notice });

  const state = (await req('GET', '/admin/api/state')).body.users.find((u) => u.id === user.body.id);
  assert.equal(state.device_limit, 1);
  assert.equal(state.devices_active, 1);
  const list = await req('GET', `/admin/api/users/${user.body.id}/devices`);
  assert.equal(list.body.limit, 1);
  // The TV holds the slot; the turned-away phone is listed (so the admin sees
  // the attempt) but not counted.
  assert.deepEqual(list.body.devices.map((d) => d.allowed), [true, false]);
  const all = await req('GET', '/admin/api/devices');
  const mine = all.body.clients.find((c) => c.user_id === user.body.id);
  assert.equal(mine.limit, 1);
  assert.equal(mine.devices.length, 2);

  // Freeing the slots drops both; the TV reclaims its slot on its next refresh.
  assert.equal((await req('POST', `/admin/api/users/${user.body.id}/devices/reset`, {})).status, 200);
  assert.equal((await req('GET', `/admin/api/users/${user.body.id}/devices`)).body.devices.length, 0);
  assert.equal((await get(tv)).status, 200);

  // A personal override beats the plan.
  assert.equal((await req('PATCH', `/admin/api/users/${user.body.id}`, { max_devices: 2 })).body.device_limit, 2);
  assert.equal((await get(phone)).status, 200);

  // Back to the plan's limit while both watch: the later device is cut over to
  // the notice mid-view (not bounced), the first one keeps playing.
  assert.equal((await req('PATCH', `/admin/api/users/${user.body.id}`, { max_devices: null })).body.device_limit, 1);
  const cut = await get(phone);
  assert.equal(cut.status, 200);
  assert.ok(cut.text.includes(`${new URL(upstreamUrl).origin}/live/seg_002.ts`));
  assert.equal((await get(tv)).status, 200);
  assert.doesNotMatch((await get(tv)).text, /#EXT-X-DISCONTINUITY/);

  // Bad values are refused, not stored.
  assert.equal((await req('PATCH', `/admin/api/plans/${plan.body.id}`, { max_devices: -1 })).status, 400);
  assert.equal((await req('PATCH', `/admin/api/users/${user.body.id}`, { max_devices: 'x' })).status, 400);

  await req('DELETE', `/admin/api/users/${user.body.id}`);
  await req('DELETE', `/admin/api/plans/${plan.body.id}`);
  await req('PATCH', '/admin/api/gateway', { enabled: false });
});

test('a source carries an auto-refresh schedule through the API', async () => {
  const before = (await req('GET', '/admin/api/catalog')).body.sources
    .find((s) => s.id === ids.source);
  // On by default, daily, with a next run already scheduled from the import.
  assert.equal(before.auto_refresh, true);
  assert.equal(before.interval_hours, 24);
  assert.ok(before.next_sync_ms > Date.now());

  const patched = await req('PATCH', `/admin/api/catalog/sources/${ids.source}`, {
    interval_hours: 6,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.interval_hours, 6);
  // The next run moves in with the shorter interval.
  assert.ok(patched.body.next_sync_ms < before.next_sync_ms);

  // Switching auto-refresh off stops scheduling it at all.
  const off = await req('PATCH', `/admin/api/catalog/sources/${ids.source}`, {
    auto_refresh: false,
  });
  assert.equal(off.body.next_sync_ms, null);

  // An interval the UI doesn't offer is refused rather than stored.
  const bad = await req('PATCH', `/admin/api/catalog/sources/${ids.source}`, {
    interval_hours: 5,
  });
  assert.equal(bad.status, 400);

  await req('PATCH', `/admin/api/catalog/sources/${ids.source}`, {
    auto_refresh: true, interval_hours: 24,
  });
});

test('recording a payment dates the subscription from the plan period', async () => {
  await req('PATCH', `/admin/api/plans/${ids.plan}`, { billing_period: 'month' });
  // Start from a known, still-valid date.
  await req('PATCH', `/admin/api/users/${ids.user}`, { expires_at: '2099-03-15' });

  // An empty body means "one more of whatever the plan is billed in".
  const one = await req('POST', `/admin/api/users/${ids.user}/payment`, {});
  assert.equal(one.status, 200);
  assert.equal(one.body.period, 'month');
  assert.equal(one.body.count, 1);
  assert.equal(one.body.previous_expires_at, '2099-03-15');
  assert.equal(one.body.user.expires_at, '2099-04-15');

  // Paid time stacks: three more months on top of the new date.
  const three = await req('POST', `/admin/api/users/${ids.user}/payment`, { count: 3 });
  assert.equal(three.body.user.expires_at, '2099-07-15');

  assert.equal((await req('POST', `/admin/api/users/${ids.user}/payment`, { count: 0 })).status, 400);
  assert.equal((await req('POST', `/admin/api/users/${ids.user}/payment`, { period: 'week' })).status, 400);
  assert.equal((await req('POST', '/admin/api/users/999999/payment', {})).status, 404);
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

test('the gateway passes a provider URL through without re-encoding it', async () => {
  // The `<url>|User-Agent=…` suffix is a real IPTV convention, and percent-
  // encoding the pipe (what a naive redirect helper does) turns it into a 404.
  const created = await req('POST', '/admin/api/catalog/channels', {
    name: 'Pipe', url: 'http://provider/9.ts|User-Agent=VLC&Referer=http://x/',
    category_id: ids.sport,
  });
  assert.equal(created.status, 201);

  const user = await req('POST', '/admin/api/users', {
    username: 'pipe-watcher',
    plan_id: ids.plan,
    expires_at: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10),
  });

  const hopped = await hop(`/c/${user.body.token}/${created.body.id}`);
  assert.deepEqual(hopped, {
    status: 302, location: 'http://provider/9.ts|User-Agent=VLC&Referer=http://x/',
  });

  await req('DELETE', `/admin/api/users/${user.body.id}`);
  await req('DELETE', `/admin/api/catalog/channels/${created.body.id}`);
});

// ---------------------------------------------------------------------------
// The media channel (Информация -> «Медиа»)
// ---------------------------------------------------------------------------

// A finished loop on disk, as media/build.js leaves it — the encode itself is
// covered by test/encode/media-args.test.js and needs ffmpeg + fonts.
function fakeMediaLoop() {
  const dir = path.join(DATA_DIR, 'hls', '_media');
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < 8; i += 1) {
    lines.push('#EXTINF:6.000000,', `seg_${String(i).padStart(3, '0')}.ts`);
    fs.writeFileSync(path.join(dir, `seg_${String(i).padStart(3, '0')}.ts`), 'ts');
  }
  lines.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(dir, 'index.m3u8'), lines.join('\n'));
  return dir;
}

test('the media channel joins every playlist once its loop exists — even an expired one', async () => {
  const user = await req('POST', '/admin/api/users', {
    username: 'media-viewer',
    plan_id: ids.plan,
    expires_at: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10),
  });
  ids.mediaUser = user.body.id;
  ids.mediaToken = user.body.token;
  const mediaUrl = `${'https://iptv.example'}/m/${ids.mediaToken}/index.m3u8`;

  const before = await req('GET', `/u/${ids.mediaToken}/playlist.m3u`, null, { raw: true });
  assert.ok(!before.text.includes('/m/'), 'nothing to play yet, so not listed');

  fakeMediaLoop();
  const listed = await req('GET', `/u/${ids.mediaToken}/playlist.m3u`, null, { raw: true });
  assert.match(listed.text, /group-title="Информация",Медиа\n/);
  assert.ok(listed.text.includes(mediaUrl));

  const live = await req('GET', `/m/${ids.mediaToken}/index.m3u8`, null, { raw: true });
  assert.equal(live.status, 200);
  assert.match(live.text, /#EXT-X-MEDIA-SEQUENCE:/);
  assert.doesNotMatch(live.text, /#EXT-X-ENDLIST/, 'served as a live channel');
  assert.equal((await req('GET', `/m/${ids.mediaToken}/seg_000.ts`, null, { raw: true })).status, 200);
  assert.equal((await req('GET', '/m/not-a-token/index.m3u8', null, { raw: true })).status, 404);
  assert.equal((await req('GET', `/m/${ids.mediaToken}/..%2Fdb.json`, null, { raw: true })).status, 400);

  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  await req('PATCH', `/admin/api/users/${ids.mediaUser}`, { expires_at: yesterday });
  const expired = await req('GET', `/u/${ids.mediaToken}/playlist.m3u`, null, { raw: true });
  assert.equal(expired.text.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 2);
  assert.ok(expired.text.includes(mediaUrl), 'expired customers keep it, with the account card');
});

test('switching the media channel off hides it and sends open players to the card', async () => {
  const off = await req('PATCH', '/admin/api/media/channel', { enabled: false, name: 'Новости сервиса' });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.channel, { id: 'info-media', name: 'Новости сервиса', enabled: false });

  const playlist = await req('GET', `/u/${ids.mediaToken}/playlist.m3u`, null, { raw: true });
  assert.ok(!playlist.text.includes('/m/'));
  const hopped = await hop(`/m/${ids.mediaToken}/index.m3u8`);
  assert.equal(hopped.status, 302);
  assert.match(hopped.location, /\/hls\/[^/]+\/index\.m3u8$/);

  await req('PATCH', '/admin/api/media/channel', { enabled: true });
  const back = await req('GET', `/u/${ids.mediaToken}/playlist.m3u`, null, { raw: true });
  assert.match(back.text, /,Новости сервиса\n/);
  assert.equal((await req('PATCH', '/admin/api/media/channel', { name: '  ' })).status, 400);
});

test('the admin adds, edits, reorders and deletes media slides', async () => {
  const added = await req('POST', '/admin/api/media/items', { type: 'text', markdown: '# Привет', seconds: 20 });
  assert.equal(added.status, 200);
  const text = added.body.items.at(-1);
  assert.equal(text.type, 'text');
  assert.equal(text.seconds, 20);
  assert.equal(text.scroll_speed, 40);

  assert.equal((await req('POST', '/admin/api/media/items', { type: 'text', markdown: '' })).status, 400);
  assert.equal((await req('POST', '/admin/api/media/items', { type: 'video' })).status, 400);
  assert.equal((await req('PATCH', `/admin/api/media/items/${text.id}`, { seconds: 0 })).status, 400);
  const edited = await req('PATCH', `/admin/api/media/items/${text.id}`, { markdown: '# Пока', scroll_speed: 80 });
  assert.equal(edited.body.items.find((i) => i.id === text.id).markdown, '# Пока');

  // A real multipart upload of a small PNG.
  const sharp = (await import('sharp')).default;
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#336699' },
  }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'картинка.png');
  form.append('caption', 'Подпись');
  const uploaded = await fetch(`${base}/admin/api/media/upload`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: form,
  });
  assert.equal(uploaded.status, 200);
  const image = (await uploaded.json()).items.at(-1);
  assert.equal(image.type, 'image');
  assert.equal(image.caption, 'Подпись');
  assert.equal(image.original_name, 'картинка.png');
  const filesDir = path.join(DATA_DIR, 'media', 'files');
  assert.equal(fs.readdirSync(filesDir).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'media', 'incoming')), [], 'the raw upload is gone');
  assert.equal((await req('GET', `/admin/api/media/items/${image.id}/thumb`, null, { raw: true })).status, 200);

  // Not an accepted type, and not really an image.
  const pdf = new FormData();
  pdf.append('file', new Blob(['%PDF'], { type: 'application/pdf' }), 'doc.pdf');
  const refused = await fetch(`${base}/admin/api/media/upload`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: pdf,
  });
  assert.equal(refused.status, 415);
  const fake = new FormData();
  fake.append('file', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
  const broken = await fetch(`${base}/admin/api/media/upload`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: fake,
  });
  assert.equal(broken.status, 400);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'media', 'incoming')), []);

  // An upload without the CSRF header is refused like every other mutation.
  const noCsrf = await fetch(`${base}/admin/api/media/upload`, { method: 'POST', headers: { cookie }, body: form });
  assert.equal(noCsrf.status, 403);

  const order = await req('PUT', '/admin/api/media/order', { ids: [image.id, text.id] });
  assert.deepEqual(order.body.items.map((i) => i.id), [image.id, text.id]);
  assert.equal((await req('PUT', '/admin/api/media/order', { ids: [image.id] })).status, 400);

  // Deleting a slide deletes its file from disk.
  const removed = await req('DELETE', `/admin/api/media/items/${image.id}`);
  assert.deepEqual(removed.body.items.map((i) => i.id), [text.id]);
  assert.deepEqual(fs.readdirSync(filesDir), []);
  await req('DELETE', `/admin/api/media/items/${text.id}`);
  assert.equal((await req('DELETE', `/admin/api/media/items/${text.id}`)).status, 404);
  await req('DELETE', `/admin/api/users/${ids.mediaUser}`);
});
