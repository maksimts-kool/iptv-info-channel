// Builds the per-user XMLTV programme guide (EPG) advertised via `url-tvg` in
// the .m3u. There is no real "schedule" — the channel is a looping info card —
// so the guide is synthesised: one programme per calendar day whose TITLE is the
// service-status headline for that day (operational / degraded / outage) and
// whose SUB-TITLE + DESC carry the viewer's own subscription status. Players
// surface the "now" programme in their channel list and info bar, so this turns
// the EPG into an at-a-glance "is everything OK?" board. Pure logic, no I/O.
import {
  localTimeToDate, accountStatus, daysLeft, formatDate, pluralDays, STATUS_META,
} from './util.js';
import { severityForDay, statusSummary, formatUptime, SEVERITY } from './status.js';

// Stable XMLTV channel id, also used as the .m3u `tvg-id` so players link the
// two. Per-user (the guide carries that user's account status).
export function epgChannelId(user) {
  return `account-${user.token}`;
}

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// "+0300" / "-0500" offset of `instant` in `tz`, derived from the wall clock
// (DST-correct) rather than a fixed assumption.
function tzOffset(instant, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
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

// Service-status title for a day's worst severity (the headline the request is
// about: "everything good" / "degraded" / "error").
const SERVICE_TITLE = {
  operational: '✓ Все сервисы работают',
  degraded: '⚠ Частичная деградация сервиса',
  outage: '✕ Сбой в работе сервиса',
};

// Short "as of this day" account line for the sub-title.
function accountLine(user, instant, tz, expiringThresholdDays) {
  const status = accountStatus(user, expiringThresholdDays, instant, tz);
  const label = STATUS_META[status].label;
  if (status === 'disabled') return `Аккаунт: ${label}`;
  if (status === 'expired') return `Подписка: ${label}`;
  const left = daysLeft(user.expires_at, instant, tz);
  if (left === null) return `Подписка: ${label} · бессрочно`;
  return `Подписка: ${label} · осталось ${left} ${pluralDays(left)}`;
}

// Semantic daily records shared by the XMLTV and OTT-play JSON renderers.
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

  const days = window.map((date) => {
    const next = nextDay(date);
    const severity = severityForDay(incidents, date, todayStr);
    const noon = dayNoon(date, tz);
    const account = accountLine(user, noon, tz, expiringThresholdDays);

    const incidentLines = incidents
      .filter((inc) => inc && SEVERITY[inc.severity] && inc.starts_on
        && inc.starts_on <= date && date <= (inc.ends_on || todayStr))
      .map((inc) => {
        const span = inc.ends_on ? `${formatDate(inc.starts_on)}–${formatDate(inc.ends_on)}`
          : `с ${formatDate(inc.starts_on)}, сейчас`;
        const note = inc.note ? ` — ${inc.note}` : '';
        return `${SEVERITY[inc.severity].label} (${span}): ${inc.title}${note}`;
      });

    return {
      date,
      next,
      severity,
      title: SERVICE_TITLE[severity],
      account,
      uptimeLine: `Доступность за 90 дней: ${formatUptime(summary.uptimePct)}`,
      incidentLines,
      startXmltv: dayStartXmltv(date, tz),
      stopXmltv: dayStartXmltv(next, tz),
      startUnix: dayStartUnix(date, tz),
      stopUnix: dayStartUnix(next, tz),
    };
  });

  return { summary, todayStr, days };
}

// Build the full XMLTV document for one user.
export function buildEpgXml(user, opts = {}) {
  const { settings = {} } = opts;
  const brand = settings.brand_name || 'Мой IPTV-сервис';
  const channelId = epgChannelId(user);
  const channelName = `${brand} — ${user.username}`;
  const { days } = eachEpgDay(user, opts);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="iptv-info-channel">',
    `  <channel id="${xmlEscape(channelId)}">`,
    `    <display-name>${xmlEscape(channelName)}</display-name>`,
    `    <display-name>${xmlEscape(brand)}</display-name>`,
    '  </channel>',
  ];

  for (const day of days) {
    const desc = [day.account, day.uptimeLine, ...day.incidentLines].join('\n');
    lines.push(
      `  <programme start="${day.startXmltv}" stop="${day.stopXmltv}" channel="${xmlEscape(channelId)}">`,
      `    <title lang="ru">${xmlEscape(day.title)}</title>`,
      `    <sub-title lang="ru">${xmlEscape(day.account)}</sub-title>`,
      `    <desc lang="ru">${xmlEscape(desc)}</desc>`,
      '    <category lang="ru">Статус сервиса</category>',
      '  </programme>',
    );
  }

  lines.push('</tv>', '');
  return lines.join('\n');
}
