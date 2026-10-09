import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config.js';
import {
  validateSubscription, buildProviderRequest, sendEmail, templates, expiryDue,
  subscribeUrlFor, capNames, contentChangeSummary, validateNewsletter, newsletterRecipients,
} from '../../src/notify/notify.js';
import { buildBrandSlide1Svg } from '../../src/render/overlay.js';

test('validateSubscription accepts a valid email and normalizes it', () => {
  const { value, error } = validateSubscription({ email: '  USER@Example.com ', options: { server: true } });
  assert.equal(error, undefined);
  assert.equal(value.email, 'user@example.com');
  // Renewal is mandatory and always forced on regardless of input.
  assert.deepEqual(value.options, {
    server: true, expiry: false, content: false, news: false, renewal: true,
  });
});

test('capNames keeps a long list readable', () => {
  assert.deepEqual(capNames(['a', 'b']), ['a', 'b']);
  const capped = capNames(Array.from({ length: 20 }, (_, i) => `ch${i}`));
  assert.equal(capped.length, 13);
  assert.equal(capped.at(-1), '…и ещё 8 позиций');
});

test('contentChangeSummary reports null when nothing changed', () => {
  assert.equal(contentChangeSummary({}), null);
  assert.equal(contentChangeSummary({ addedCategories: [], removedChannels: [] }), null);
  assert.deepEqual(contentChangeSummary({ addedCategories: ['Спорт'] }), {
    addedCategories: ['Спорт'], removedCategories: [], addedChannels: [], removedChannels: [],
  });
});

test('contentChange template names both directions of a mixed change', () => {
  const message = templates.contentChange('Бренд', {
    user: { username: 'Алиса' },
    planName: 'Про',
    change: {
      addedCategories: ['Спорт'], removedCategories: [],
      addedChannels: [], removedChannels: ['НТВ'],
    },
  });
  assert.match(message.subject, /изменения в списке каналов/);
  assert.match(message.html, /Список каналов изменился/);
  assert.match(message.html, /Спорт/);
  assert.match(message.html, /НТВ/);
  assert.match(message.text, /Добавлены категории: Спорт/);
  assert.match(message.text, /Убраны каналы: НТВ/);
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

test('a newsletter needs a subject and a body; the audience is optional', () => {
  assert.match(validateNewsletter({ body: 'x' }).error, /тему/);
  assert.match(validateNewsletter({ subject: 'Тема' }).error, /текст/);
  assert.match(validateNewsletter({ subject: 'x'.repeat(151), body: 'x' }).error, /150/);
  const { value } = validateNewsletter({
    subject: '  Плановые   работы ', body: 'Строка\r\nвторая\r\n\r\nНовый абзац', important: 'yes',
  });
  assert.equal(value.subject, 'Плановые работы');
  assert.equal(value.body, 'Строка\nвторая\n\nНовый абзац');
  assert.equal(value.important, false, 'only a real true marks it important');
  assert.equal(value.audience, null, 'no audience = everyone opted in');
  const aimed = validateNewsletter({ subject: 'a', body: 'b', audience: { users: ['3', 3, 'x'], plans: ['pro'] } });
  assert.deepEqual(aimed.value.audience, { users: [3], plans: ['pro'] });
});

test('a newsletter reaches verified, opted-in subscribers in the audience only', () => {
  const users = [
    { id: 1, plan_id: 'pro' }, { id: 2, plan_id: 'std' }, { id: 3, plan_id: 'std' }, { id: 4, plan_id: 'std' },
  ];
  const sub = (user_id, extra = {}) => ({
    user_id, email: `u${user_id}@x.io`, verified: true, options: { news: true }, ...extra,
  });
  const subscribers = [
    sub(1), sub(2), sub(3, { verified: false }), sub(4, { options: { news: false } }), sub(99),
  ];
  const ids = (audience) => newsletterRecipients(audience, users, subscribers).map((r) => r.user.id);
  assert.deepEqual(ids(null), [1, 2], 'unverified, opted-out and deleted customers are skipped');
  assert.deepEqual(ids({ users: [], plans: ['pro'] }), [1]);
  assert.deepEqual(ids({ users: [2, 3], plans: [] }), [2]);
  assert.deepEqual(ids({ users: [], plans: [] }), [], 'an empty group is nobody, not everybody');
});

test('the newsletter email escapes the text and keeps its paragraphs', () => {
  const mail = templates.newsletter('Бренд', { subject: 'Новости <b>', body: 'Первый\nабзац\n\n<script>x</script>', important: true });
  assert.match(mail.subject, /^Бренд: Важно — Новости <b>$/);
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('Первый<br>абзац'));
  assert.ok(mail.html.includes('&lt;script&gt;'));
  assert.match(mail.text, /^ВАЖНО\. Новости <b>/);
});
