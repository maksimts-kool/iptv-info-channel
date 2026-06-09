import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBodySvg, buildExpiredPlansSvg } from '../src/overlay.js';

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
