import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config.js';
import {
  validateSubscription, buildProviderRequest, sendEmail, templates, expiryDue,
  subscribeUrlFor,
} from '../../src/notify/notify.js';
import { buildBrandSlide1Svg } from '../../src/render/overlay.js';

test('validateSubscription accepts a valid email and normalizes it', () => {
  const { value, error } = validateSubscription({ email: '  USER@Example.com ', options: { server: true } });
  assert.equal(error, undefined);
  assert.equal(value.email, 'user@example.com');
  // Renewal is mandatory and always forced on regardless of input.
  assert.deepEqual(value.options, { server: true, expiry: false, renewal: true });
});

test('validateSubscription rejects bad emails', () => {
  for (const email of ['', 'nope', 'a@b', 'a b@c.d', `${'x'.repeat(250)}@example.com`]) {
    assert.ok(validateSubscription({ email }).error, `should reject ${JSON.stringify(email)}`);
  }
});

test('buildProviderRequest shapes Brevo and Resend payloads', () => {
  const message = { to: 'c@d.e', subject: 'S', html: '<b>h</b>', text: 't' };
  config.notify.provider = 'brevo';
  config.notify.from = 'from@x.io';
  config.notify.fromName = 'Brand';
  config.notify.apiKey = 'key123';
  const brevo = buildProviderRequest(message);
  assert.match(brevo.url, /brevo/);
  assert.equal(brevo.headers['api-key'], 'key123');
  assert.deepEqual(brevo.body.to, [{ email: 'c@d.e' }]);
  assert.equal(brevo.body.htmlContent, '<b>h</b>');

  config.notify.provider = 'resend';
  const resend = buildProviderRequest(message);
  assert.match(resend.url, /resend/);
  assert.equal(resend.headers.authorization, 'Bearer key123');
  assert.equal(resend.body.from, 'Brand <from@x.io>');
  assert.deepEqual(resend.body.to, ['c@d.e']);
});

test('sendEmail dry-run does not hit the network', async () => {
  const prev = config.notify.dryRun;
  config.notify.dryRun = true;
  const res = await sendEmail({ to: 'a@b.c', subject: 's', html: 'h', text: 't' });
  assert.deepEqual(res, { dryRun: true });
  config.notify.dryRun = prev;
});

test('templates escape interpolated values (no XSS)', () => {
  const evil = '<script>alert(1)</script>';
  const msg = templates.expiry('Brand', { user: { username: evil, expires_at: '2026-07-05' } });
  assert.ok(!msg.html.includes('<script>'), 'username must be escaped in HTML');
  assert.ok(msg.html.includes('&lt;script&gt;'));
  assert.match(msg.subject, /скоро истекает/);
});

test('expiryDue fires once inside the threshold and dedups by expiry date', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  const user = { active: 1, expires_at: '2026-07-05' };            // 4 days left
  const opted = { options: { expiry: true }, verified: true, last_expiry_notice: null };
  assert.equal(expiryDue(user, opted, { now }), true);

  // Unverified address never gets notifications (double opt-in gate).
  assert.equal(expiryDue(user, { ...opted, verified: false }, { now }), false);

  // Already warned for this exact expiry → no resend.
  assert.equal(expiryDue(user, { ...opted, last_expiry_notice: '2026-07-05' }, { now }), false);

  // A short renewal that stays inside the window but changes the date re-arms
  // even when an old marker is present.
  assert.equal(expiryDue({ ...user, expires_at: '2026-07-07' }, { ...opted, last_expiry_notice: '2026-07-05' }, { now }), true);

  // Not opted in, or well outside the window → never due.
  assert.equal(expiryDue(user, { options: { expiry: false }, verified: true, last_expiry_notice: null }, { now }), false);
  assert.equal(expiryDue({ ...user, expires_at: '2026-12-31' }, opted, { now }), false);
});

test('verification template embeds the (escaped) verify link', () => {
  const msg = templates.verification('Brand', { url: 'http://h/sub/verify/tok123' });
  assert.match(msg.subject, /подтвердите адрес/i);
  assert.ok(msg.html.includes('http://h/sub/verify/tok123'));
  assert.ok(msg.text.includes('http://h/sub/verify/tok123'));
});

test('subscribeUrlFor uses the separate notify token, not the stream token', () => {
  const url = subscribeUrlFor({ token: 'STREAMTOK', notify_token: 'NOTIFYTOK' });
  assert.ok(url.endsWith('/sub/NOTIFYTOK'));
  assert.ok(!url.includes('STREAMTOK'));
});

test('buildBrandSlide1Svg adds a QR panel only when a subscribe URL is given', () => {
  const plain = buildBrandSlide1Svg({ brand_name: 'Acme' }, null);
  assert.ok(!plain.includes('Подписка на уведомления'));

  const withQr = buildBrandSlide1Svg({ brand_name: 'Acme' }, 'http://host/sub/abc123');
  assert.ok(withQr.includes('<rect'), 'QR modules render as rects');
  assert.ok(withQr.includes('Подписка на уведомления'));
});
