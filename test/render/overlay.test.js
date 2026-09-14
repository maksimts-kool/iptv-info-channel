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

const NOTICE = {
  id: '1',
  published_at: '2026-09-14T10:06:44.000Z',
  kind: 'maintenance',
  headline: 'Технические работы',
  body: 'Часть телеканалов <архив> & DVR будет временно недоступна в течение нескольких часов в связи с плановой заменой архивных серверов. Обратите внимание: архивы на затрагиваемых каналах будут формироваться заново с момента завершения работ, это займёт время.',
};

test('status slide mixes provider notices into the event list, in blue', async () => {
  const { buildStatusSlideSvg } = await import('../../src/render/overlay.js');
  const { statusSummary, withProviderNotices } = await import('../../src/render/status.js');
  const now = new Date('2026-09-14T12:00:00Z');
  const summary = statusSummary([], { now, tz: 'Europe/Tallinn' });

  const plain = buildStatusSlideSvg(summary, { brand_name: 'IPTV Test' });
  assert.equal(buildStatusSlideSvg(withProviderNotices(summary, [], { tz: 'Europe/Tallinn' }), { brand_name: 'IPTV Test' }), plain);

  const svg = buildStatusSlideSvg(withProviderNotices(summary, [
    NOTICE,
    { id: '2', published_at: '2026-09-14T08:00:00.000Z', kind: 'outage', headline: 'Перебои', body: 'x' },
  ], { tz: 'Europe/Tallinn' }), { brand_name: 'IPTV Test' });
  // Blue status instead of the green "all working".
  assert.match(svg, />Технические работы у провайдера</);
  assert.doesNotMatch(svg, />Все сервисы работают</);
  assert.match(svg, />Провайдер</);
  assert.match(svg, /#2563eb/);
  assert.match(svg, />Провайдер · 14 сен 2026 · 13:06</);
  assert.match(svg, /&lt;архив&gt; &amp; DVR/);
  assert.match(svg, />Перебои</);
});

test('our own incident keeps the headline and shares the list with the provider', async () => {
  const { buildStatusSlideSvg } = await import('../../src/render/overlay.js');
  const { statusSummary, withProviderNotices } = await import('../../src/render/status.js');
  const now = new Date('2026-09-14T12:00:00Z');
  const incidents = [
    { title: 'Сбой <EPG>', severity: 'outage', starts_on: '2026-09-14', note: 'Чиним' },
    { title: 'Медленно', severity: 'degraded', starts_on: '2026-09-13', note: 'Смотрим' },
    { title: 'Ещё', severity: 'degraded', starts_on: '2026-09-12', note: 'Тоже' },
  ];
  const svg = buildStatusSlideSvg(
    withProviderNotices(statusSummary(incidents, { now, tz: 'Europe/Tallinn' }), [NOTICE], { tz: 'Europe/Tallinn' }),
    { brand_name: 'IPTV Test' },
  );
  assert.match(svg, />Сбой в работе сервиса</);
  assert.match(svg, /Сбой &lt;EPG&gt;/);
  // The provider notice always keeps a card, even when incidents fill the list:
  // it displaces the second incident, so two events are left for the footer.
  assert.match(svg, />Технические работы</);
  assert.doesNotMatch(svg, />Медленно</);
  assert.match(svg, /Ещё событий: 2/);
});

test('wrapText wraps on words and ellipsizes the overflow', async () => {
  const { wrapText } = await import('../../src/render/overlay.js');
  assert.deepEqual(wrapText('aaa bbb ccc', 7, 3), ['aaa bbb', 'ccc']);
  const lines = wrapText('one two three four five six', 9, 2);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'one two');
  assert.ok(lines[1].endsWith('…') && lines[1].length <= 9, lines[1]);
});
