// Shared number/date presentation for the admin UI.

// Thousands grouping, Russian style (narrow no-break space, never a comma).
//
// AntD's <Statistic> groups its own `value` but leaves `suffix` untouched, which
// is how "1,308 / 1310" happened: one half formatted, the other not. Everything
// that shows a count runs through this helper — pass it to <Statistic> as
// `formatter` AND use it to build the suffix, so both halves match.
export function count(value) {
  return Number(value || 0).toLocaleString('ru-RU');
}

// Relative "in 3 h" / "in 20 min" for a future epoch-ms instant; '—' when there
// isn't one. Used for a source's next scheduled refresh.
export function untilPretty(ms) {
  if (!ms) return '—';
  const diff = ms - Date.now();
  if (diff <= 0) return 'скоро';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `через ${minutes} мин.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `через ${hours} ч.`;
  return `через ${Math.round(hours / 24)} дн.`;
}

// "каждые 6 ч." / "каждые сутки" for a refresh interval in hours.
export function intervalLabel(hours) {
  if (!hours) return 'вручную';
  if (hours === 24) return 'раз в сутки';
  if (hours === 48) return 'раз в 2 суток';
  if (hours === 72) return 'раз в 3 суток';
  if (hours === 168) return 'раз в неделю';
  return `каждые ${hours} ч.`;
}
