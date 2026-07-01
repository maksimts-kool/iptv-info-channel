// Admin web config: login + JSON API to manage users, plans, incidents and
// settings. Merged from the former routes/admin.js (HTTP orchestration) and
// admin-domain.js (pure validation + view-model shaping). The pure functions
// stay exported and free of Express/I/O so they remain unit-tested in isolation
// (test/admin-domain.test.js).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
  Users, Plans, Settings, Incidents, Subscribers, NotifyLog,
} from '../data.js';
import { statusSummary, INCIDENT_SEVERITIES } from '../render/status.js';
import {
  daysLeft, accountStatus, formatPrice, formatDate, STATUS_META,
} from '../util.js';
import * as notify from '../notify.js';
import {
  generateForUser, generateAll, generationStatus, removeUserHls,
  syncWorldcupSettings, syncNotifySettings,
} from '../encode/channel.js';
import { getWorldCupModel } from '../render/worldcup.js';
import {
  requireAuth, requireCsrf, csrfToken, checkPassword, setSession, clearSession,
} from './auth.js';
import { log } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// http/ is one level under src/, same as the old routes/, so this still resolves
// to src/public/admin (the built admin UI is served from there).
const ADMIN_PUBLIC = path.join(__dirname, '..', 'public', 'admin');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ===========================================================================
// Pure view models + input validation (no Express, no I/O — unit-tested)
// ===========================================================================

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

// Compact view of one World Cup fixture for the admin preview list. Mirrors how
// the on-air slide renders a row (overlay.js wcFixtureRow): the kickoff time is
// only meaningful before a match finishes.
function worldcupFixtureView(fx) {
  const hasScore = fx.home.score !== null && fx.home.score !== undefined
    && fx.away.score !== null && fx.away.score !== undefined;
  return {
    id: fx.id,
    dateLabel: fx.dateLabel,
    time: fx.status.key === 'finished' ? '' : (fx.time || ''),
    stageLabel: fx.stageLabel,
    statusKey: fx.status.key,
    statusLabel: fx.status.label,
    home: { label: fx.home.label, score: fx.home.score ?? null, winner: !!fx.home.winner },
    away: { label: fx.away.label, score: fx.away.score ?? null, winner: !!fx.away.winner },
    hasScore,
  };
}

// View model for the admin World Cup card: the slide controls (enabled/seconds),
// whether a live-results token is configured, and a preview of the same model
// the channel renders (champion summary / not-started message / fixtures window).
export function worldcupSummaryJson(model, { enabled, seconds, tokenConfigured } = {}) {
  return {
    enabled: !!enabled,
    seconds,
    tokenConfigured: !!tokenConfigured,
    headline: model?.headline || '',
    updated: model?.updated || '',
    champion: model?.champion || null,
    notStarted: model?.notStarted || null,
    fixtures: (model?.fixtures || []).map(worldcupFixtureView),
  };
}

// ---- Input validation (returns { error } or the parsed value) ----
// Validate the World Cup slide settings (enable toggle + on-screen seconds).
export function validateWorldcupSettings(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has('enabled')) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    out.enabled = body.enabled;
  }
  if (!partial || has('seconds')) {
    const seconds = Number(body.seconds);
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 120) {
      return { error: 'seconds must be a whole number between 4 and 120' };
    }
    out.seconds = seconds;
  }
  return { value: out };
}

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

// ===========================================================================
// HTTP layer
// ===========================================================================

const router = express.Router();

// In-memory sliding-window rate limit for login attempts, to blunt password
// brute-forcing. Keyed per client IP (req.ip honors the configured trust proxy).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginHits = new Map();
function loginRateLimited(key) {
  const now = Date.now();
  const arr = (loginHits.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  arr.push(now);
  loginHits.set(key, arr);
  return arr.length > LOGIN_MAX_ATTEMPTS;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of loginHits) {
    const live = arr.filter((t) => now - t < LOGIN_WINDOW_MS);
    if (live.length) loginHits.set(k, live); else loginHits.delete(k);
  }
}, LOGIN_WINDOW_MS).unref();

// Fire-and-forget regeneration (don't block the API response on ffmpeg).
function regen(userOrId, reason) {
  Promise.resolve()
    .then(() => generateForUser(userOrId, { reason }))
    .catch((e) => { if (!e.aborted) log.error('admin', 'user regeneration failed', { reason, error: e.message }); });
}
function regenAll(reason) {
  generateAll({ reason })
    .catch((e) => log.error('admin', 'bulk regeneration failed', { reason, error: e.message }));
}
// Fire-and-forget notification dispatch (don't block / fail the API response).
function fireNotify(factory, label) {
  Promise.resolve().then(factory)
    .catch((e) => log.error('admin', label, { error: e.message }));
}

const VALID_PERIODS = ['', 'month', 'year'];

// ---------- Auth ----------
router.post('/login', express.urlencoded({ extended: false }), express.json(), (req, res) => {
  if (loginRateLimited(`login:${req.ip}`)) {
    log.warn('admin', 'login rate limited', { remote: req.ip });
    if (req.is('application/json')) return res.status(429).json({ error: 'too many attempts, try again later' });
    return res.redirect('/admin/login?error=rate');
  }
  const pw = req.body?.password;
  if (!checkPassword(pw)) {
    log.warn('admin', 'login failed', { remote: req.ip });
    if (req.is('application/json')) return res.status(401).json({ error: 'wrong password' });
    return res.redirect('/admin/login?error=1');
  }
  setSession(res);
  if (req.is('application/json')) return res.json({ ok: true });
  return res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// ---------- Single-page admin UI ----------
// Always serve the SPA shell (no server-side auth gate); the React app renders
// the login view itself when the API answers 401. The hashed assets are produced
// by the Vite build in frontend/ and copied into ADMIN_PUBLIC at docker build
// time — so on a bare host checkout (no build) index.html is absent, hence the
// guard below.
router.get('/', (req, res) => {
  const indexHtml = path.join(ADMIN_PUBLIC, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return res.status(200).type('html').send(
      '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">'
      + '<h1>Admin UI not built</h1><p>Build the Docker image (it runs the Vite build) '
      + 'or run <code>npm run dev</code> in <code>frontend/</code> for local development.</p>',
    );
  }
  return res.sendFile(indexHtml);
});
router.use('/static', express.static(ADMIN_PUBLIC));

// ---------- JSON API ----------
// requireCsrf sits after requireAuth: unauth -> 401, authed but forged -> 403.
router.use('/api', requireAuth, requireCsrf, express.json());

router.get('/api/state', (req, res) => {
  const incidents = Incidents.all();
  res.json({
    csrfToken: csrfToken(),
    publicBaseUrl: config.publicBaseUrl,
    expiringThresholdDays: config.expiringThresholdDays,
    statusSlideEnabled: config.statusSlide.enabled,
    worldcupSlide: { enabled: config.worldcupSlide.enabled, seconds: config.worldcupSlide.seconds },
    notify: { enabled: config.notify.enabled },
    settings: Settings.all(),
    plans: Plans.all().map(planJson),
    users: Users.all().map(decorateUser),
    subscribers: Subscribers.all().map((s) => ({
      user_id: s.user_id, email: s.email, options: s.options, verified: !!s.verified,
    })),
    incidents: incidents.map(incidentJson),
    status: statusSummary(incidents, { tz: config.timezone }),
  });
});

router.get('/api/generation-status', (req, res) => {
  res.json(generationStatus());
});

// Create user
router.post('/api/users', (req, res) => {
  const { username, plan_id, expires_at, active = true } = req.body || {};
  if (!username || !plan_id) return res.status(400).json({ error: 'username and plan_id required' });
  if (!Plans.get(plan_id)) return res.status(400).json({ error: 'unknown plan_id' });
  const u = Users.create({ username, plan_id, expires_at: expires_at || null, active });
  log.info('admin', 'user created', { user_id: u.id, username: u.username, plan_id });
  regen(u.id, 'admin user created');
  res.status(201).json(decorateUser(u));
});

// Update user (expiration change, plan change, rename, enable/disable)
router.patch('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = Users.get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const { username, plan_id, expires_at, active } = req.body || {};
  if (plan_id && !Plans.get(plan_id)) return res.status(400).json({ error: 'unknown plan_id' });
  const u = Users.update(id, { username, plan_id, expires_at, active });
  log.info('admin', 'user updated', { user_id: u.id, username: u.username });
  regen(u.id, 'admin user updated');
  // Renewal: the admin pushed the expiry to a later date — notify (mandatory).
  if (expires_at !== undefined && before.expires_at && u.expires_at && u.expires_at > before.expires_at) {
    fireNotify(() => notify.notifyRenewal(u), 'renewal notification failed');
  }
  res.json(decorateUser(u));
});

// Regenerate access token (invalidates old m3u link)
router.post('/api/users/:id/token', (req, res) => {
  const id = Number(req.params.id);
  if (!Users.get(id)) return res.status(404).json({ error: 'not found' });
  const u = Users.regenerateToken(id);
  log.info('admin', 'user access token regenerated', { user_id: u.id, username: u.username });
  regen(u.id, 'admin access token regenerated');
  res.json(decorateUser(u));
});

// Force-rebuild this user's stream now
router.post('/api/users/:id/regenerate', async (req, res) => {
  const id = Number(req.params.id);
  const u = Users.get(id);
  if (!u) return res.status(404).json({ error: 'not found' });
  try {
    log.info('admin', 'manual user regeneration requested', { user_id: id, username: u.username });
    await generateForUser(id, { reason: 'admin manual regeneration' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete user
router.delete('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Users.get(id)) return res.status(404).json({ error: 'not found' });
  Users.remove(id);
  removeUserHls(id);
  log.info('admin', 'user deleted', { user_id: id });
  res.json({ ok: true });
});

// Create plan -> rebuild streams because expired accounts show every plan.
router.post('/api/plans', (req, res) => {
  const { name, price_eur, billing_period = '', features = [] } = req.body || {};
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.status(400).json({ error: 'plan name required' });
  if (cleanName.length > 80) return res.status(400).json({ error: 'plan name must be 80 characters or less' });
  const price = parsePriceCents(price_eur);
  if (price.error) return res.status(400).json({ error: price.error });
  if (!VALID_PERIODS.includes(billing_period)) return res.status(400).json({ error: 'bad billing_period' });
  if (duplicatePlanName(Plans.all(), cleanName)) return res.status(409).json({ error: 'a plan with this name already exists' });
  const parsedFeatures = parseFeatures(features);
  if (parsedFeatures.error) return res.status(400).json({ error: parsedFeatures.error });

  const plan = Plans.create({
    name: cleanName,
    price_cents: price.cents,
    currency: 'EUR',
    billing_period,
    features: parsedFeatures.features,
  });
  log.info('admin', 'plan created', { plan_id: plan.id, name: plan.name });
  regenAll('admin plan created');
  res.status(201).json(planJson(plan));
});

// Update plan -> rebuild streams because active cards and expired plan grids use it.
router.patch('/api/plans/:id', (req, res) => {
  const id = req.params.id;
  const plan = Plans.get(id);
  if (!plan) return res.status(404).json({ error: 'not found' });
  const { price_eur, name, billing_period, features } = req.body || {};
  const updates = {};

  if (billing_period !== undefined) {
    if (!VALID_PERIODS.includes(billing_period)) return res.status(400).json({ error: 'bad billing_period' });
    updates.billing_period = billing_period;
  }
  if (price_eur !== undefined) {
    const price = parsePriceCents(price_eur);
    if (price.error) return res.status(400).json({ error: price.error });
    updates.price_cents = price.cents;
  }
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) return res.status(400).json({ error: 'plan name required' });
    if (cleanName.length > 80) return res.status(400).json({ error: 'plan name must be 80 characters or less' });
    if (duplicatePlanName(Plans.all(), cleanName, id)) return res.status(409).json({ error: 'a plan with this name already exists' });
    updates.name = cleanName;
  }
  if (features !== undefined) {
    const parsedFeatures = parseFeatures(features);
    if (parsedFeatures.error) return res.status(400).json({ error: parsedFeatures.error });
    updates.features = parsedFeatures.features;
  }

  const updated = Plans.update(id, updates);
  log.info('admin', 'plan updated', { plan_id: id, fields: Object.keys(updates) });
  regenAll('admin plan updated');
  res.json(planJson(updated));
});

// Delete only unused plans so existing users always keep a valid assignment.
router.delete('/api/plans/:id', (req, res) => {
  const id = req.params.id;
  const plan = Plans.get(id);
  if (!plan) return res.status(404).json({ error: 'not found' });
  const assignedUsers = Users.all().filter((user) => user.plan_id === id);
  if (assignedUsers.length) {
    return res.status(409).json({
      error: `plan is assigned to ${assignedUsers.length} user${assignedUsers.length === 1 ? '' : 's'}`,
    });
  }
  Plans.remove(id);
  log.info('admin', 'plan deleted', { plan_id: id, name: plan.name });
  regenAll('admin plan deleted');
  res.json({ ok: true });
});

// Update branding settings -> regenerate all
router.patch('/api/settings', (req, res) => {
  const { brand_name, tagline } = req.body || {};
  if (brand_name !== undefined) Settings.set('brand_name', brand_name);
  if (tagline !== undefined) Settings.set('tagline', tagline);
  log.info('admin', 'branding settings updated', {
    fields: [
      ...(brand_name !== undefined ? ['brand_name'] : []),
      ...(tagline !== undefined ? ['tagline'] : []),
    ],
  });
  regenAll('admin branding updated');
  res.json(Settings.all());
});

// ---------- Status board incidents ----------
router.post('/api/incidents', (req, res) => {
  const { error, value } = validateIncident(req.body || {});
  if (error) return res.status(400).json({ error });
  if (value.ends_on && value.ends_on < value.starts_on) {
    return res.status(400).json({ error: 'ends_on cannot be before starts_on' });
  }
  const inc = Incidents.create(value);
  log.info('admin', 'incident created', { incident_id: inc.id, severity: inc.severity });
  regenAll('admin incident created');
  fireNotify(() => notify.notifyServerStatus(inc, 'raised'), 'server-status notification failed');
  res.status(201).json(incidentJson(inc));
});

router.patch('/api/incidents/:id', (req, res) => {
  const existing = Incidents.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { error, value } = validateIncident(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  const effStart = value.starts_on ?? existing.starts_on;
  const effEnd = value.ends_on !== undefined ? value.ends_on : existing.ends_on;
  if (effEnd && effStart && effEnd < effStart) {
    return res.status(400).json({ error: 'ends_on cannot be before starts_on' });
  }
  const inc = Incidents.update(req.params.id, value);
  log.info('admin', 'incident updated', { incident_id: inc.id, fields: Object.keys(value) });
  regenAll('admin incident updated');
  // First time an ongoing incident gets an end date → "service restored" mail.
  if (!existing.ends_on && inc.ends_on) {
    fireNotify(() => notify.notifyServerStatus(inc, 'resolved'), 'server-status notification failed');
  }
  res.json(incidentJson(inc));
});

router.delete('/api/incidents/:id', (req, res) => {
  if (!Incidents.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  Incidents.remove(req.params.id);
  log.info('admin', 'incident deleted', { incident_id: req.params.id });
  regenAll('admin incident deleted');
  res.json({ ok: true });
});

// ---------- World Cup slide ----------
// Live preview of the global World Cup bracket slide plus its current settings.
// The model is built regardless of the enable toggle so admins can preview it
// while the slide is switched off; live teams/scores need a football API token.
async function worldcupResponse({ now = new Date(), force = false } = {}) {
  const model = await getWorldCupModel({ now, force });
  return worldcupSummaryJson(model, {
    enabled: config.worldcupSlide.enabled,
    seconds: config.worldcupSlide.seconds,
    tokenConfigured: Boolean(config.footballApi.token),
  });
}

router.get('/api/worldcup', async (req, res) => {
  try {
    res.json(await worldcupResponse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle the slide on/off and set its on-screen seconds. Persisted in Settings
// (env vars are the fallback) and applied to the live config; rebuilds all
// streams because the slide is global.
router.patch('/api/worldcup', (req, res) => {
  const { error, value } = validateWorldcupSettings(req.body || {});
  if (error) return res.status(400).json({ error });
  Settings.set('worldcup_enabled', value.enabled);
  Settings.set('worldcup_seconds', value.seconds);
  syncWorldcupSettings();
  log.info('admin', 'world cup slide settings updated', value);
  regenAll('admin world cup settings updated');
  res.json({ enabled: config.worldcupSlide.enabled, seconds: config.worldcupSlide.seconds });
});

// Force a re-fetch of live results now, then rebuild (only useful when enabled).
router.post('/api/worldcup/refresh', async (req, res) => {
  try {
    const payload = await worldcupResponse({ force: true });
    log.info('admin', 'world cup results refresh requested');
    if (config.worldcupSlide.enabled) regenAll('admin world cup results refreshed');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Email notifications ----------
function notificationsView() {
  const byUser = new Map(Subscribers.all().map((s) => [s.user_id, s]));
  return {
    enabled: config.notify.enabled,
    provider: config.notify.provider,
    dryRun: config.notify.dryRun,
    configured: config.notify.dryRun || Boolean(config.notify.apiKey && config.notify.from),
    subscribers: Users.all()
      .filter((u) => byUser.has(u.id))
      .map((u) => {
        const s = byUser.get(u.id);
        return {
          user_id: u.id, username: u.username, email: s.email,
          options: s.options, verified: !!s.verified, created_at: s.created_at,
        };
      }),
    log: NotifyLog.recent(30),
  };
}

router.get('/api/notifications', (req, res) => res.json(notificationsView()));

// Toggle the whole system. The QR appears/disappears on the intro slide, so this
// rebuilds all streams (like a branding change).
router.patch('/api/notifications', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  Settings.set('notify_enabled', enabled);
  syncNotifySettings();
  log.info('admin', 'notifications toggled', { enabled });
  regenAll('admin notifications toggled');
  res.json({ enabled: config.notify.enabled });
});

// Send a one-off test email; surfaces provider/config errors to the admin.
router.post('/api/notifications/test', async (req, res) => {
  try {
    await notify.sendTest(req.body?.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manually remove a user's subscriber.
router.delete('/api/users/:id/subscriber', (req, res) => {
  const id = Number(req.params.id);
  if (!Users.get(id)) return res.status(404).json({ error: 'not found' });
  Subscribers.remove(id);
  log.info('admin', 'subscriber removed', { user_id: id });
  res.json({ ok: true });
});

// Rebuild all streams
router.post('/api/regenerate-all', async (req, res) => {
  log.info('admin', 'manual bulk regeneration requested');
  const results = await generateAll({ reason: 'admin manual bulk regeneration' });
  res.json({ ok: true, results });
});

export default router;
