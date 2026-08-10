// Builds the per-user XMLTV programme guide (EPG) advertised via `url-tvg` in
// the .m3u. There is no real "schedule" — the channel is a looping info card —
// so the guide is synthesised: one programme per calendar day.
//
// A player (Televizo, OTT-play FOSS) shows exactly ONE line of this next to the
// channel: the programme TITLE. That line is the whole point of the info
// channel, so it carries the viewer's own subscription status ("✓ Подписка
// активна · ещё 89 дней"), and the day's service state is folded in only when
// something is actually wrong — an incident must never be hidden, but "all
// good" must never crowd out the customer's own status either. The longer
// SUB-TITLE + DESC, which players show once the programme is opened, carry the
// expiry date, the plan, the service headline, 90-day uptime and any incident
// notes. Pure logic, no I/O.
import {
  localTimeToDate, accountStatus, daysLeft, formatDate, formatPrice, periodLabel,
  pluralDays, dateFormatter, xmlEscape,
} from '../core/util.js';
import { severityForDay, statusSummary, formatUptime, SEVERITY } from '../render/status.js';

// Re-exported so EPG renderers (epgfoss.js) can share the same escaper.
export { xmlEscape };

// Stable XMLTV channel id, also used as the .m3u `tvg-id` so players link the
// two. Per-user (the guide carries that user's account status).
export function epgChannelId(user) {
  return `account-${user.token}`;
}

// "+0300" / "-0500" offset of `instant` in `tz`, derived from the wall clock
// (DST-correct) rather than a fixed assumption.
function tzOffset(instant, tz) {
  const parts = dateFormatter('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
  const min = Math.round((asUtc - instant.getTime()) / 60000);
  const sign = min >= 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

// Local-midnight instant starting `dateStr` in `tz`.
function dayStart(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localTimeToDate(y, m, d, 0, 0, 0, tz);
}

// XMLTV timestamp "YYYYMMDDHHMMSS +0300" for local midnight starting `dateStr`.
function dayStartXmltv(dateStr, tz) {
  return `${dateStr.replace(/-/g, '')}000000 ${tzOffset(dayStart(dateStr, tz), tz)}`;
}

// Unix seconds of local midnight starting `dateStr` in `tz`.
export function dayStartUnix(dateStr, tz) {
  return Math.floor(dayStart(dateStr, tz).getTime() / 1000);
}

// Local-noon instant of a calendar day — a safe sample point for "as of this
// day" status (away from any midnight DST/expiry boundary).
function dayNoon(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localTimeToDate(y, m, d, 12, 0, 0, tz);
}

// The calendar date one day after `dateStr`.
function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + 86400000).toISOString().slice(0, 10);
}

// Calendar date strings from `behind` days before through `ahead` days after the
// day containing `now`, oldest first. Plain UTC arithmetic on the already-
// localized "today" string.
function dayWindow(todayStr, behind, ahead) {
  const [y, m, d] = todayStr.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  const out = [];
  for (let i = -behind; i <= ahead; i += 1) {
    out.push(new Date(base + i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

// Service-status headline for a day's worst severity (the full sentence used in
// the description; the title uses the short form below).
const SERVICE_TITLE = {
  operational: '✓ Все сервисы работают',
  degraded: '⚠ Частичная деградация сервиса',
  outage: '✕ Сбой в работе сервиса',
};

// Compact service prefix for the one-line title. `operational` has none on
// purpose — a healthy service is the normal case and must not eat the row.
const SERVICE_SHORT = {
  degraded: '⚠ Перебои в работе',
  outage: '✕ Сбой сервиса',
};

const ACCOUNT_TITLE = {
  active: { icon: '✓', text: 'Подписка активна' },
  expiring: { icon: '⚠', text: 'Подписка истекает' },
  expired: { icon: '✕', text: 'Подписка истекла' },
  disabled: { icon: '✕', text: 'Аккаунт отключён' },
};

// "ещё 4 дня" / "последний день" / "бессрочно" / "истекла 3 дня назад".
function remainingText(left) {
  if (left === null) return 'бессрочно';
  if (left === 0) return 'последний день';
  if (left < 0) return `истекла ${-left} ${pluralDays(left)} назад`;
  return `ещё ${left} ${pluralDays(left)}`;
}

// The customer's own status "as of this day", short enough for a channel-list
// row. `left` is sampled at that day's local noon so it decrements across the
// guide instead of showing today's number on every day.
function accountShort(user, instant, tz, expiringThresholdDays) {
  const status = accountStatus(user, expiringThresholdDays, instant, tz);
  const left = daysLeft(user.expires_at, instant, tz);
  const { icon, text } = ACCOUNT_TITLE[status];
  // An expired or deactivated account says all it needs to in the label itself.
  const suffix = status === 'expired' || status === 'disabled' ? '' : ` · ${remainingText(left)}`;
  return { status, left, icon, text: `${text}${suffix}` };
}

// The plan the customer is on, with its price — the second thing they look for
// after "when does this run out".
function planLine(user) {
  if (!user.plan_name) return null;
  const price = user.price_cents
    ? ` · ${formatPrice(user.price_cents, user.currency)}${periodLabel(user.billing_period)}`
    : '';
  return `Тариф: ${user.plan_name}${price}`;
}

// The concrete expiry date, used as the XMLTV sub-title (players show it right
// under the title) — the title only carries the relative "ещё N дней".
function expiryLine(user, account) {
  if (account.status === 'disabled') return 'Аккаунт отключён администратором';
  if (!user.expires_at) return 'Подписка бессрочная';
  return `Действует до ${formatDate(user.expires_at)} · ${remainingText(account.left)}`;
}

// Semantic daily records shared by the XMLTV and OTT-play JSON renderers. Each
// record carries the day's calendar bounds (`date`/`next`) and rendered status
// text; each renderer formats those bounds into its own timestamp shape
// (`dayStartXmltv` vs. `dayStartUnix`) so neither pays for the other's format.
//
// `title` (one line) and `desc` (the detail block) are built HERE rather than in
// each renderer, so the XMLTV guide and the FOSS JSON guide can never drift into
// telling the same customer two different things.
export function eachEpgDay(
  user,
  {
    incidents = [],
    now = new Date(),
    tz = process.env.TZ || 'Europe/Tallinn',
    daysAhead = 7,
    daysBehind = 1,
    expiringThresholdDays = 7,
  } = {},
) {
  const summary = statusSummary(incidents, { now, tz });
  const todayStr = summary.days.at(-1).date; // statusSummary's window ends "today"
  const window = dayWindow(todayStr, daysBehind, daysAhead);
  const uptimeLine = `Доступность за 90 дней: ${formatUptime(summary.uptimePct)}`;

  const plan = planLine(user);

  const days = window.map((date) => {
    const next = nextDay(date);
    const severity = severityForDay(incidents, date, todayStr);
    const noon = dayNoon(date, tz);
    const account = accountShort(user, noon, tz, expiringThresholdDays);
    const expiry = expiryLine(user, account);

    const incidentLines = incidents
      .filter((inc) => inc && SEVERITY[inc.severity] && inc.starts_on
        && inc.starts_on <= date && date <= (inc.ends_on || todayStr))
      .map((inc) => {
        const span = (() => {
          if (!inc.ends_on) return `с ${formatDate(inc.starts_on)}, сейчас`;
          if (inc.ends_on === inc.starts_on) return formatDate(inc.starts_on);
          return `${formatDate(inc.starts_on)}–${formatDate(inc.ends_on)}`;
        })();
        const note = inc.note ? ` — ${inc.note}` : '';
        return `${SEVERITY[inc.severity].label} (${span}): ${inc.title}${note}`;
      });

    const service = SERVICE_TITLE[severity];
    // One line, account first; the service state only elbows in when it is not
    // "operational", so an incident is still impossible to miss.
    const title = severity === 'operational'
      ? `${account.icon} ${account.text}`
      : `${SERVICE_SHORT[severity]} · ${account.text}`;
    const desc = [
      plan,
      expiry,
      `Статус сервиса: ${service}`,
      uptimeLine,
      ...incidentLines,
    ].filter(Boolean).join('\n');

    return {
      date, next, severity, account, title, service, expiry, uptimeLine, incidentLines, desc,
    };
  });

  return { summary, todayStr, tz, days };
}

// Build the full XMLTV document for one user.
export function buildEpgXml(user, opts = {}) {
  const { settings = {} } = opts;
  const brand = settings.brand_name || 'Мой IPTV-сервис';
  const channelId = epgChannelId(user);
  const channelName = `${brand} — ${user.username}`;
  const { days, tz } = eachEpgDay(user, opts);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="iptv-info-channel">',
    `  <channel id="${xmlEscape(channelId)}">`,
    `    <display-name>${xmlEscape(channelName)}</display-name>`,
    `    <display-name>${xmlEscape(brand)}</display-name>`,
    '  </channel>',
  ];

  for (const day of days) {
    lines.push(
      `  <programme start="${dayStartXmltv(day.date, tz)}" stop="${dayStartXmltv(day.next, tz)}" channel="${xmlEscape(channelId)}">`,
      `    <title lang="ru">${xmlEscape(day.title)}</title>`,
      `    <sub-title lang="ru">${xmlEscape(day.expiry)}</sub-title>`,
      `    <desc lang="ru">${xmlEscape(day.desc)}</desc>`,
      '    <category lang="ru">Статус подписки</category>',
      '  </programme>',
    );
  }

  lines.push('</tv>', '');
  return lines.join('\n');
}
