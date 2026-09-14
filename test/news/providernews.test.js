// The feed fetch against a stub provider: session refresh on 401, the rotated
// cookie persisted, a failed fetch keeping the previous notices. Uses a
// throwaway DATA_DIR because the settings live in the JSON store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-news-'));
const { Settings } = await import('../../src/data/store.js');
const news = await import('../../src/news/providernews.js');

const FEED_URL = 'https://provider.example/v3/news?page=1';
const FEED = {
  data: {
    items: [
      {
        id: 1,
        date: '14.09.2026 13:06:44',
        html: '<p>🇷🇺 RU ⚠️ Технические работы! Часть телеканалов будет временно недоступна.</p>',
        isPublished: true,
      },
      { id: 2, date: '13.09.2026 10:00:00', html: '<p>Новый канал с 13 сентября!</p>', isPublished: true },
    ],
  },
};
const AFTER_PUBLISH = new Date('2026-09-14T12:00:00Z');

function stubProvider(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, cookie: init.headers.Cookie });
    const handler = routes.shift();
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

const json = (body, headers = []) => new Response(JSON.stringify(body), {
  status: 200, headers: [['content-type', 'application/json'], ...headers],
});

test('a 401 refreshes the session, retries and persists the rotated cookie', async () => {
  Settings.set('provider_news', { enabled: true, url: FEED_URL, cookie: 'access=old; refresh=r1' });
  const { fetchImpl, calls } = stubProvider([
    () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }),
    () => new Response('{}', { status: 200, headers: [['set-cookie', 'access=new; Path=/'], ['set-cookie', 'refresh=r2; Path=/']] }),
    () => json(FEED),
  ]);

  const { error } = await news.refreshProviderNews({ fetchImpl });
  assert.equal(error, null);
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.cookie]), [
    ['GET', FEED_URL, 'access=old; refresh=r1'],
    ['POST', 'https://provider.example/v3/auth/refresh', 'access=old; refresh=r1'],
    ['GET', FEED_URL, 'access=new; refresh=r2'],
  ]);
  assert.equal(Settings.all().provider_news.cookie, 'access=new; refresh=r2');

  const shown = news.currentProviderNotices(AFTER_PUBLISH);
  assert.deepEqual(shown.map((n) => n.headline), ['Технические работы']);

  const view = news.providerNewsView(AFTER_PUBLISH);
  assert.equal(view.cookie_set, true);
  assert.equal('cookie' in view, false);
  assert.equal(view.notices[0].active, true);
});

test('a failed fetch keeps the previous notices and reports the error', async () => {
  const { fetchImpl } = stubProvider([() => new Response('oops', { status: 502 })]);
  const { error } = await news.refreshProviderNews({ fetchImpl });
  assert.match(error, /502/);
  assert.equal(news.currentProviderNotices(AFTER_PUBLISH).length, 1);
  assert.equal(news.providerNewsView(AFTER_PUBLISH).auth_failed, false);
});

test('a rejected refresh is reported as an auth failure', async () => {
  const { fetchImpl } = stubProvider([
    () => new Response('', { status: 401 }),
    () => new Response('', { status: 401 }),
  ]);
  const { error } = await news.refreshProviderNews({ fetchImpl });
  assert.match(error, /session/);
  assert.equal(news.providerNewsView(AFTER_PUBLISH).auth_failed, true);
});

test('disabling hides the notices from the slide without deleting them', () => {
  news.updateProviderNewsSettings({ enabled: false });
  assert.deepEqual(news.currentProviderNotices(AFTER_PUBLISH), []);
  assert.equal(news.providerNewsView(AFTER_PUBLISH).notices.length, 1);
  // Switching the feed URL clears notices that belonged to the old feed.
  news.updateProviderNewsSettings({ enabled: true, url: 'https://other.example/news' });
  assert.equal(news.providerNewsView(AFTER_PUBLISH).notices.length, 0);
});
