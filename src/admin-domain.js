// Pure validation + view-model shaping for the admin JSON API. No Express and
// no I/O, so it is unit-tested in isolation (test/admin-domain.test.js) — the
// route layer (routes/admin.js) is left to do only HTTP orchestration.
import { config } from './config.js';
import {
  daysLeft, accountStatus, formatPrice, formatDate, STATUS_META,
} from './util.js';
import { INCIDENT_SEVERITIES } from './status.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- View models (decorate stored records for the API response) ----
export function incidentJson(i) {
  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    starts_on: i.starts_on,
    ends_on: i.ends_on || null,
    starts_pretty: formatDate(i.starts_on),
    ends_pretty: i.ends_on ? formatDate(i.ends_on) : null,
    ongoing: !i.ends_on,
    note: i.note || '',
  };
}

export function planJson(plan) {
  return {
    id: plan.id,
    name: plan.name,
    price_cents: plan.price_cents,
    currency: plan.currency,
    billing_period: plan.billing_period || '',
    price: formatPrice(plan.price_cents, plan.currency),
    features: plan.features || [],
    sort: plan.sort,
  };
}

export function decorateUser(u) {
  const status = accountStatus(u, config.expiringThresholdDays);
  return {
    id: u.id,
    username: u.username,
    token: u.token,
    plan_id: u.plan_id,
    plan_name: u.plan_name,
    price: formatPrice(u.price_cents, u.currency),
    expires_at: u.expires_at,
    expires_pretty: formatDate(u.expires_at),
    days_left: daysLeft(u.expires_at),
    active: !!u.active,
    status,
    status_label: STATUS_META[status].label,
    status_color: STATUS_META[status].color,
    m3u_url: `${config.publicBaseUrl}/u/${u.token}/playlist.m3u`,
    hls_url: `${config.publicBaseUrl}/hls/${u.token}/index.m3u8`,
  };
}

// ---- Input validation (returns { error } or the parsed value) ----
// Parse a price entered in euros into integer cents. Shared by plan create/patch.
export function parsePriceCents(priceEur) {
  if (priceEur === '' || priceEur === null || priceEur === undefined) {
    return { error: 'bad price' };
  }
  const cents = Math.round(Number(priceEur) * 100);
  if (!Number.isFinite(cents) || cents < 0) return { error: 'bad price' };
  return { cents };
}

export function parseFeatures(value) {
  if (!Array.isArray(value)) return { error: 'features must be an array' };
  const features = value.map((feature) => String(feature).trim()).filter(Boolean);
  if (features.length > 12) return { error: 'a plan can have at most 12 features' };
  if (features.some((feature) => feature.length > 100)) {
    return { error: 'each feature must be 100 characters or less' };
  }
  return { features };
}

export function duplicatePlanName(plans, name, exceptId = null) {
  const normalized = name.trim().toLocaleLowerCase();
  return plans.some((plan) => (
    plan.id !== exceptId && plan.name.trim().toLocaleLowerCase() === normalized
  ));
}

// Shared incident field validation; returns { error } or { value } for a
// create (full) or patch (partial) request.
export function validateIncident(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has('title')) {
    const title = String(body.title || '').trim();
    if (!title) return { error: 'incident title required' };
    if (title.length > 100) return { error: 'title must be 100 characters or less' };
    out.title = title;
  }
  if (!partial || has('severity')) {
    if (!INCIDENT_SEVERITIES.includes(body.severity)) return { error: 'bad severity' };
    out.severity = body.severity;
  }
  if (!partial || has('starts_on')) {
    if (!DATE_RE.test(body.starts_on || '')) return { error: 'bad starts_on (YYYY-MM-DD)' };
    out.starts_on = body.starts_on;
  }
  if (has('ends_on')) {
    const end = body.ends_on ? String(body.ends_on) : null;
    if (end && !DATE_RE.test(end)) return { error: 'bad ends_on (YYYY-MM-DD)' };
    out.ends_on = end;
  } else if (!partial) {
    out.ends_on = null;
  }
  if (has('note')) {
    const note = String(body.note || '').trim();
    if (note.length > 280) return { error: 'note must be 280 characters or less' };
    out.note = note;
  } else if (!partial) {
    out.note = '';
  }
  return { value: out };
}
