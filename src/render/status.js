// Derives the service-status summary (Better Stack–style 90-day uptime strip)
// from a list of manually-created incidents. Pure logic, no I/O — unit tested.
import { localDateString } from '../util.js';

// Incident states, worst-last. "operational" is implicit (no incident covers
// the day); only 'degraded' and 'outage' are ever stored. Colours match the
// account STATUS_META palette in util.js.
export const SEVERITY = {
  operational: { rank: 0, color: '#16a34a', label: 'Работает' },
  degraded: { rank: 1, color: '#d97706', label: 'Деградация' },
  outage: { rank: 2, color: '#dc2626', label: 'Сбой' },
};

// The severities an incident can actually be stored as ("operational" is the
// implicit no-incident state). Used to validate incident input.
export const INCIDENT_SEVERITIES = Object.keys(SEVERITY).filter((s) => s !== 'operational');

// Headline shown above the strip for the current overall state.
const STATE_HEADLINE = {
  operational: 'Все сервисы работают',
  degraded: 'Частичная деградация сервиса',
  outage: 'Сбой в работе сервиса',
};

export function severityRank(severity) {
  return SEVERITY[severity]?.rank ?? 0;
}

// The `days` calendar dates ending at (and including) `todayStr`, oldest first.
// Plain calendar arithmetic on an already-localized date string — no timezone
// shift needed once "today" is known.
function calendarWindow(todayStr, days) {
  const [y, m, d] = todayStr.split('-').map(Number);
  const todayUtc = Date.UTC(y, m - 1, d);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(todayUtc - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

// Worst severity among incidents covering calendar day `dayStr`.
export function severityForDay(incidents, dayStr, todayStr) {
  let worst = 'operational';
  for (const inc of incidents) {
    const end = inc.ends_on || todayStr; // open-ended incidents run through today
    if (inc.starts_on <= dayStr && dayStr <= end) {
      if (severityRank(inc.severity) > severityRank(worst)) worst = inc.severity;
    }
  }
  return worst;
}

// Summarize incidents into { state, label, color, uptimePct, days[], activeIncidents }.
export function statusSummary(
  incidents = [],
  { now = new Date(), tz = process.env.TZ || 'Europe/Tallinn', days = 90 } = {},
) {
  const todayStr = localDateString(now, tz);
  const valid = incidents.filter(
    (inc) => inc && SEVERITY[inc.severity] && inc.starts_on,
  );

  const window = calendarWindow(todayStr, days);
  let operationalDays = 0;
  const dayCells = window.map((date) => {
    const severity = severityForDay(valid, date, todayStr);
    if (severity === 'operational') operationalDays += 1;
    return { date, severity, color: SEVERITY[severity].color };
  });

  // Incidents covering "today" drive the headline (open-ended = still active).
  const activeIncidents = valid.filter(
    (inc) => inc.starts_on <= todayStr && todayStr <= (inc.ends_on || todayStr),
  );
  const state = activeIncidents.reduce(
    (worst, inc) => (severityRank(inc.severity) > severityRank(worst) ? inc.severity : worst),
    'operational',
  );

  const uptimePct = Math.round((operationalDays / days) * 1000) / 10;

  return {
    state,
    label: STATE_HEADLINE[state],
    color: SEVERITY[state].color,
    uptimePct,
    days: dayCells,
    activeIncidents,
  };
}

// Format an uptime fraction for display: "100%", "99,9%" (EU comma decimal).
export function formatUptime(pct) {
  const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(1).replace('.', ',');
  return `${text}%`;
}
