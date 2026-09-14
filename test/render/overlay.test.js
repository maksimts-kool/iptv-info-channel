import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBodySvg, buildExpiredPlansSvg } from '../../src/render/overlay.js';

const expiredUser = {
  username: 'Expired customer',
  plan_id: 'standard',
  expires_at: '2020-01-01',
  active: 1,
};

const plans = [
  {
    id: 'standard',
    name: 'Standard',
    price_cents: 499,
    currency: 'EUR',
    features: ['Estonian channels', 'Family channels'],
  },
  {
    id: 'sport',
    name: 'Sport',
    price_cents: 699,
    currency: 'EUR',
    features: ['Sport channels'],
  },
  {
    id: 'premium',
    name: 'Premium',
    price_cents: 999,
    currency: 'EUR',
    features: ['Movie channels'],
  },
  {
    id: 'max',
    name: 'Max',
    price_cents: 1299,
    currency: 'EUR',
    features: ['All channel groups'],
  },
];

test('expired body shows every available plan and its features', () => {
  const svg = buildBodySvg(expiredUser, plans, { brand_name: 'IPTV Test' });

  assert.match(svg, /ПОДПИСКА ИСТЕКЛА/);
  for (const plan of plans) {
    assert.match(svg, new RegExp(`>${plan.name}<`));
    assert.match(svg, new RegExp(`>${plan.features[0]}<`));
  }
});

test('active body remains the account details card', () => {
  const svg = buildBodySvg(
    { ...expiredUser, expires_at: '2099-01-01', plan_name: 'Standard', price_cents: 499, currency: 'EUR' },
    plans,
    { brand_name: 'IPTV Test' },
  );

  assert.match(svg, />АККАУНТ</);
  assert.doesNotMatch(svg, /ПОДПИСКА ИСТЕКЛА/);
});

test('plan feature text is escaped in the expired slide', () => {
  const svg = buildExpiredPlansSvg(expiredUser, [
    { ...plans[0], features: ['Sports & <Movies>'] },
  ]);

  assert.match(svg, /Sports &amp; &lt;Movies&gt;/);
  assert.doesNotMatch(svg, /Sports & <Movies>/);
});

test('status slide adds the blue provider block only when notices are present', async () => {
  const { buildStatusSlideSvg } = await import('../../src/render/overlay.js');
  const { statusSummary } = await import('../../src/render/status.js');
  const summary = statusSummary([], { now: new Date('2026-09-14T12:00:00Z'), tz: 'Europe/Tallinn' });

  const plain = buildStatusSlideSvg(summary, { brand_name: 'IPTV Test' });
  assert.doesNotMatch(plain, /ИНФОРМАЦИЯ ОТ ПРОВАЙДЕРА/);
  assert.equal(buildStatusSlideSvg({ ...summary, providerNotices: [] }, { brand_name: 'IPTV Test' }), plain);

  const svg = buildStatusSlideSvg({
    ...summary,
    providerNotices: [
      {
        id: '1',
        published_at: '2026-09-14T10:06:44.000Z',
        kind: 'maintenance',
        headline: 'Технические работы',
        body: 'Часть телеканалов <архив> & DVR будет временно недоступна в течение нескольких часов в связи с плановой заменой архивных серверов. Обратите внимание: архивы на затрагиваемых каналах будут формироваться заново с момента завершения работ, это займёт время.',
      },
      { id: '2', published_at: '2026-09-14T08:00:00.000Z', kind: 'outage', headline: 'Перебои', body: 'x' },
    ],
  }, { brand_name: 'IPTV Test' });
  assert.match(svg, /ИНФОРМАЦИЯ ОТ ПРОВАЙДЕРА/);
  assert.match(svg, />Технические работы</);
  assert.match(svg, /#2563eb/);
  assert.match(svg, /\+1 ещё · 14 сен 2026 · 13:06/);
  assert.match(svg, /&lt;архив&gt; &amp; DVR/);
  // Our own board is still there.
  assert.match(svg, />Все сервисы работают</);
});

test('wrapText wraps on words and ellipsizes the overflow', async () => {
  const { wrapText } = await import('../../src/render/overlay.js');
  assert.deepEqual(wrapText('aaa bbb ccc', 7, 3), ['aaa bbb', 'ccc']);
  const lines = wrapText('one two three four five six', 9, 2);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'one two');
  assert.ok(lines[1].endsWith('…') && lines[1].length <= 9, lines[1]);
});
