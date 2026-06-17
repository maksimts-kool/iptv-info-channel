// Shared helpers: price formatting, date math, account status.

// Format integer cents as EUR "4,99 €" (comma decimal, EU style).
export function formatPrice(cents, currency = 'EUR') {
  const symbol = currency === 'EUR' ? '€' : currency;
  const value = (cents / 100).toFixed(2).replace('.', ',');
  return `${value} ${symbol}`;
}

// Human-readable period suffix for a plan: '/мес.', '/год', or ''.
export function periodLabel(period) {
  if (period === 'month') return '/мес.';
  if (period === 'year') return '/год';
  return '';
}

// Escape a string for safe interpolation into XML/SVG text or attributes.
export function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Intl.DateTimeFormat construction dominates the cost of these date helpers and
// the formatters are immutable, so memoize them by locale + options (timezone
// included). Shared with epg.js and logger.js.
const formatterCache = new Map();
export function dateFormatter(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

function datePartsInTimezone(date, timezone) {
  const parts = dateFormatter('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

// Convert a local wall-clock time in an IANA timezone to a real UTC instant.
export function localTimeToDate(year, month, day, hour, minute, second, timezone) {
  const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let result = new Date(wantedAsUtc);

  // Recalculate once to account for the timezone offset, including DST.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = dateFormatter('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(result);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const renderedAsUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    result = new Date(result.getTime() + (wantedAsUtc - renderedAsUtc));
  }
  return result;
}

// Parse YYYY-MM-DD as the final second of that calendar day in Tallinn.
export function parseExpiry(dateStr, timezone = process.env.TZ || 'Europe/Tallinn') {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return new Date(dateStr);
  return localTimeToDate(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    23,
    59,
    59,
    timezone,
  );
}

// Calendar days remaining in Tallinn. The expiry date itself returns 0.
export function daysLeft(
  dateStr,
  now = new Date(),
  timezone = process.env.TZ || 'Europe/Tallinn',
) {
  const expiryMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
  if (!expiryMatch) return null;
  const current = datePartsInTimezone(now, timezone);
  const expiryDay = Date.UTC(
    Number(expiryMatch[1]),
    Number(expiryMatch[2]) - 1,
    Number(expiryMatch[3]),
  );
  const currentDay = Date.UTC(
    Number(current.year),
    Number(current.month) - 1,
    Number(current.day),
  );
  return Math.round((expiryDay - currentDay) / (24 * 60 * 60 * 1000));
}

// Status: 'active' | 'expiring' | 'expired' | 'disabled'.
export function accountStatus(
  user,
  expiringThresholdDays = 7,
  now = new Date(),
  timezone = process.env.TZ || 'Europe/Tallinn',
) {
  if (!user.active) return 'disabled';
  const d = daysLeft(user.expires_at, now, timezone);
  if (d === null) return 'active';
  if (d < 0) return 'expired';
  if (d <= expiringThresholdDays) return 'expiring';
  return 'active';
}

export const STATUS_META = {
  active: { label: 'АКТИВЕН', color: '#16a34a' },
  expiring: { label: 'СКОРО ИСТЕКАЕТ', color: '#d97706' },
  expired: { label: 'ПРОСРОЧЕН', color: '#dc2626' },
  disabled: { label: 'ОТКЛЮЧЁН', color: '#6b7280' },
};

// Russian pluralization for "день": 1 день, 2 дня, 5 дней.
export function pluralDays(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b === 1) return 'день';
  if (b >= 2 && b <= 4) return 'дня';
  return 'дней';
}

// Human-friendly date "09 июн 2026".
export function formatDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
  if (!match) return '—';
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${match[3]} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

export function localDateString(now = new Date(), timezone = process.env.TZ || 'Europe/Tallinn') {
  const values = datePartsInTimezone(now, timezone);
  return `${values.year}-${values.month}-${values.day}`;
}
