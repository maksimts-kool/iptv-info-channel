// Email notification system. The channel's intro slide shows a per-user QR code
// linking to /sub/:token, where a customer subscribes with their email. From
// then on they get mail on: server-status changes (opt-in), an expiring
// subscription (opt-in, once per expiry date), and renewals (mandatory).
//
// Mail goes over a third-party HTTP email API (HTTPS:443) — Brevo by default,
// Resend optional — because DigitalOcean blocks outbound SMTP ports. Everything
// for the feature (transport, templates, dispatch, validation) lives here so it
// stays in one place. `NOTIFY_DRY_RUN` logs instead of sending for local testing.
import { config } from '../config.js';
import {
  Users, Subscribers, Settings, NotifyLog,
} from '../data/store.js';
import {
  accountStatus, daysLeft, formatDate, pluralDays, xmlEscape,
} from '../core/util.js';
import { log } from '../core/logger.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function notifyEnabled() {
  return !!config.notify.enabled;
}

export function subscribeUrlFor(user) {
  // The notify token is separate from the stream token, so the on-screen QR can
  // be photographed without leaking stream access.
  return `${config.publicBaseUrl}/sub/${user.notify_token}`;
}

function brandName() {
  return Settings.all().brand_name || 'IPTV-сервис';
}

// Pure: validate/normalize a subscribe request body. Renewal is mandatory, so
// it is always forced on regardless of what the client sends.
export function validateSubscription(body = {}) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return { error: 'Введите корректный адрес электронной почты' };
  }
  const opt = body.options || {};
  return {
    value: { email, options: { server: !!opt.server, expiry: !!opt.expiry, renewal: true } },
  };
}

// ---- Transport ----
// Each provider maps a normalized { to, subject, html, text } message to its own
// HTTP request shape. Kept pure so the payload can be asserted in tests.
const PROVIDERS = {
  brevo: ({ to, subject, html, text }) => ({
    url: 'https://api.brevo.com/v3/smtp/email',
    headers: { 'api-key': config.notify.apiKey, 'content-type': 'application/json' },
    body: {
      sender: { email: config.notify.from, name: config.notify.fromName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    },
  }),
  resend: ({ to, subject, html, text }) => ({
    url: 'https://api.resend.com/emails',
    headers: { authorization: `Bearer ${config.notify.apiKey}`, 'content-type': 'application/json' },
    body: {
      from: config.notify.fromName ? `${config.notify.fromName} <${config.notify.from}>` : config.notify.from,
      to: [to],
      subject,
      html,
      text,
    },
  }),
};

export function buildProviderRequest(message) {
  const make = PROVIDERS[config.notify.provider] || PROVIDERS.brevo;
  return make(message);
}

export async function sendEmail(message) {
  if (config.notify.dryRun) {
    log.info('notify', 'dry-run: email not sent', { to: message.to, subject: message.subject });
    return { dryRun: true };
  }
  if (!config.notify.apiKey || !config.notify.from) {
    throw new Error('email provider not configured (set NOTIFY_API_KEY and NOTIFY_FROM)');
  }
  const req = buildProviderRequest(message);
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`email send failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return { ok: true };
}

// ---- Templates (Russian; every interpolated value is xmlEscape'd) ----
// Visual language mirrors the Ant Design admin UI: light theme, white cards on a
// #f5f5f5 page, primary #2563eb, Ant status colours. Layout is table-based with
// inline styles for email-client compatibility (no external CSS, no flexbox).
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const COLORS = {
  page: '#f5f5f5',
  card: '#ffffff',
  border: '#f0f0f0',
  heading: '#262626',
  text: '#595959',
  muted: '#8c8c8c',
  primary: '#2563eb',
  success: '#16a34a',
  error: '#dc2626',
  warning: '#d97706',
};

function layout(brand, heading, bodyHtml, { accent = COLORS.primary } = {}) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:${COLORS.page};font-family:${FONT}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;overflow:hidden">
        <tr><td style="height:4px;background:${accent};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:32px 32px 8px">
          <div style="font-size:12px;letter-spacing:2px;color:${COLORS.primary};text-transform:uppercase;font-weight:600">${xmlEscape(brand)}</div>
          <h1 style="font-size:24px;line-height:1.3;margin:12px 0 20px;color:${COLORS.heading};font-weight:600">${xmlEscape(heading)}</h1>
        </td></tr>
        <tr><td style="padding:0 32px 8px">${bodyHtml}</td></tr>
        <tr><td style="padding:20px 32px 28px">
          <div style="border-top:1px solid ${COLORS.border};padding-top:16px;font-size:12px;line-height:1.6;color:${COLORS.muted}">
            ${xmlEscape(brand)} · автоматическое уведомление, отвечать на него не нужно.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
const P = (t) => `<p style="color:${COLORS.text};font-size:15px;line-height:1.6;margin:0 0 14px">${t}</p>`;

// Email-safe primary button (table cell so Outlook renders the background).
const button = (label, url) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px"><tr><td bgcolor="${COLORS.primary}" style="border-radius:8px">
  <a href="${xmlEscape(url)}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px">${xmlEscape(label)}</a>
</td></tr></table>`;

// Ant-style callout: subtle tinted box with a coloured left accent bar.
const callout = (html, color = COLORS.primary) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#fafafa;border:1px solid ${COLORS.border};border-left:3px solid ${color};border-radius:8px"><tr><td style="padding:14px 16px;color:${COLORS.heading};font-size:15px;line-height:1.6">${html}</td></tr></table>`;

const list = (items) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${items.map((o) => `<tr><td style="padding:4px 0;color:${COLORS.text};font-size:15px;line-height:1.5"><span style="color:${COLORS.primary};font-weight:700">&nbsp;•&nbsp;</span>${xmlEscape(o)}</td></tr>`).join('')}</table>`;

export const templates = {
  // Double opt-in: the link the recipient must click to activate the address.
  verification(brand, { url }) {
    return {
      subject: `${brand}: подтвердите адрес для уведомлений`,
      html: layout(brand, 'Подтвердите адрес',
        P('Вы запросили уведомления. Подтвердите этот адрес, чтобы активировать подписку:')
        + button('Подтвердить адрес', url)
        + P(`Если кнопка не работает, откройте ссылку:<br><a href="${xmlEscape(url)}" style="color:${COLORS.primary};word-break:break-all">${xmlEscape(url)}</a>`)
        + P('Если это были не вы — просто проигнорируйте письмо, подписка не активируется.')),
      text: `Подтвердите адрес для уведомлений (${brand}): ${url}`,
    };
  },
  confirmation(brand, { options }) {
    const opts = [
      'Продление подписки',
      options.expiry ? 'Скоро истекает' : null,
      options.server ? 'Статус сервера' : null,
    ].filter(Boolean);
    return {
      subject: `${brand}: подписка на уведомления оформлена`,
      html: layout(brand, 'Вы подписаны на уведомления',
        P('Мы будем присылать письма по выбранным темам:')
        + list(opts)
        + P('Изменить темы или отписаться можно на той же странице, где вы оформили подписку.'),
        { accent: COLORS.success }),
      text: `Вы подписаны на уведомления (${brand}). Темы: ${opts.join(', ')}.`,
    };
  },
  expiry(brand, { user }) {
    const d = daysLeft(user.expires_at);
    const left = d === 0 ? 'сегодня' : `через ${d} ${pluralDays(d)}`;
    return {
      subject: `${brand}: подписка скоро истекает`,
      html: layout(brand, 'Подписка скоро истекает',
        P(`Здравствуйте, ${xmlEscape(user.username)}!`)
        + callout(`Подписка истекает <b style="color:${COLORS.warning}">${xmlEscape(left)}</b><br><span style="color:${COLORS.text};font-size:14px">Дата окончания: ${xmlEscape(formatDate(user.expires_at))}</span>`, COLORS.warning)
        + P('Продлите её, чтобы не потерять доступ.'),
        { accent: COLORS.warning }),
      text: `Подписка истекает ${left} (${formatDate(user.expires_at)}). Продлите, чтобы сохранить доступ.`,
    };
  },
  renewal(brand, { user }) {
    return {
      subject: `${brand}: подписка продлена`,
      html: layout(brand, 'Подписка продлена',
        P(`Здравствуйте, ${xmlEscape(user.username)}!`)
        + callout(`Новая дата окончания подписки:<br><b style="color:${COLORS.success}">${xmlEscape(formatDate(user.expires_at))}</b>`, COLORS.success)
        + P('Спасибо, что остаётесь с нами!'),
        { accent: COLORS.success }),
      text: `Ваша подписка продлена до ${formatDate(user.expires_at)}.`,
    };
  },
  serverStatus(brand, { phase, incident }) {
    const resolved = phase === 'resolved';
    const heading = resolved ? 'Сервис восстановлен' : 'Проблема в работе сервиса';
    const accent = resolved ? COLORS.success : COLORS.error;
    return {
      subject: `${brand}: ${resolved ? 'сервис восстановлен' : 'инцидент в работе сервиса'}`,
      html: layout(brand, heading,
        callout(`<b>${xmlEscape(incident.title)}</b>${incident.note ? `<br><span style="color:${COLORS.text};font-size:14px">${xmlEscape(incident.note)}</span>` : ''}`, accent),
        { accent }),
      text: `${heading}: ${incident.title}${incident.note ? ` — ${incident.note}` : ''}`,
    };
  },
  test(brand) {
    return {
      subject: `${brand}: тестовое письмо`,
      html: layout(brand, 'Тестовое письмо',
        P('Если вы видите это письмо, отправка уведомлений настроена правильно.')
        + callout(`<b style="color:${COLORS.success}">✓ Отправка уведомлений работает</b>`, COLORS.success)),
      text: 'Тестовое письмо: отправка уведомлений настроена правильно.',
    };
  },
};

// ---- Dispatch (each logs to NotifyLog and never throws at the caller) ----
async function dispatch(type, userId, to, message) {
  try {
    await sendEmail({ to, ...message });
    NotifyLog.add({ user_id: userId, email: to, type, ok: true });
    return true;
  } catch (e) {
    NotifyLog.add({ user_id: userId, email: to, type, ok: false, error: e.message });
    log.error('notify', 'email send failed', { type, to, error: e.message });
    return false;
  }
}

// Sent on subscribe / address change: the double opt-in verification link.
export function sendVerification(user, sub) {
  const url = `${config.publicBaseUrl}/sub/verify/${sub.verify_token}`;
  return dispatch('verification', user.id, sub.email, templates.verification(brandName(), { url }));
}

// Sent once the recipient has clicked the link (so the address is proven).
export function sendConfirmation(user, sub) {
  return dispatch('confirmation', user.id, sub.email, templates.confirmation(brandName(), { options: sub.options }));
}

// Mandatory renewal notice — sent whenever the admin pushes the expiry later.
export async function notifyRenewal(user) {
  if (!notifyEnabled()) return;
  const sub = Subscribers.byUser(user.id);
  if (!sub || !sub.verified) return;
  await dispatch('renewal', user.id, sub.email, templates.renewal(brandName(), { user }));
}

// Server-status change ('raised' | 'resolved') to everyone opted into it.
export async function notifyServerStatus(incident, phase) {
  if (!notifyEnabled()) return;
  const brand = brandName();
  for (const sub of Subscribers.all()) {
    if (!sub.verified || !sub.options.server) continue;
    if (!Users.get(sub.user_id)) continue;
    await dispatch('server', sub.user_id, sub.email, templates.serverStatus(brand, { phase, incident }));
  }
}

// Pure predicate: is this subscriber due an "expiring" email right now? True only
// for a verified address inside the threshold window and not already warned for
// this exact expiry date (a renewal changes expires_at, which re-arms it).
export function expiryDue(user, sub, { now = new Date(), thresholdDays = config.expiringThresholdDays } = {}) {
  if (!sub.verified || !sub.options.expiry || !user?.expires_at) return false;
  if (accountStatus(user, thresholdDays, now) !== 'expiring') return false;
  return sub.last_expiry_notice !== user.expires_at;
}

// Sweep all subscribers and send the once-per-expiry warning. Run by the daily
// cron after the stream rebuild; the dedup marker keeps it to a single email.
export async function expirySweep({ now = new Date() } = {}) {
  if (!notifyEnabled()) return { sent: 0 };
  const brand = brandName();
  let sent = 0;
  for (const sub of Subscribers.all()) {
    const user = Users.get(sub.user_id);
    if (!user || !expiryDue(user, sub, { now })) continue;
    if (await dispatch('expiry', sub.user_id, sub.email, templates.expiry(brand, { user }))) {
      Subscribers.setExpiryNotice(sub.user_id, user.expires_at);
      sent += 1;
    }
  }
  return { sent };
}

// Admin "send test email" — surfaces provider errors to the caller (unlike the
// fire-and-forget dispatch above) so misconfiguration is visible in the UI.
export async function sendTest(to) {
  const email = String(to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('bad email address');
  try {
    await sendEmail({ to: email, ...templates.test(brandName()) });
    NotifyLog.add({ user_id: null, email, type: 'test', ok: true });
  } catch (e) {
    NotifyLog.add({ user_id: null, email, type: 'test', ok: false, error: e.message });
    throw e;
  }
}
