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
  generateForUser, generateAll, generationStatus, removeUserHls, syncNotifySettings,
} from '../encode/channel.js';
import {
  requireAuth, requireCsrf, csrfToken, checkPassword, setSession, clearSession,
} from './auth.js';
import catalogRouter from './catalog.js';
import { renderUserPlaylist } from './stream.js';
import { Overrides, catalog } from '../playlist/catalog.js';
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

// `categoryNames` maps category id -> name (from the catalog). A plan's contents
// ARE its categories: `features` is the resolved list of names, kept under that
// key because it is what the on-screen plan cards render.
export function planJson(plan, categoryNames = new Map()) {
  const categoryIds = plan.category_ids || [];
  return {
    id: plan.id,
    name: plan.name,
    price_cents: plan.price_cents,
    currency: plan.currency,
    billing_period: plan.billing_period || '',
    price: formatPrice(plan.price_cents, plan.currency),
    category_ids: categoryIds,
    features: categoryIds.map((id) => categoryNames.get(id)).filter(Boolean),
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

// The category ids a plan grants. `known` is the set of ids that exist in the
// catalog; unknown ids are rejected rather than silently stored, so a stale
// admin tab can't create a plan that grants a deleted category.
export function parsePlanCategories(value, known = null) {
  if (!Array.isArray(value)) return { error: 'category_ids must be an array' };
  const ids = [...new Set(value.map((id) => String(id).trim()).filter(Boolean))];
  if (known) {
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) return { error: `unknown category: ${unknown[0]}` };
  }
  return { categoryIds: ids };
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

// Catalog lookups used when validating / presenting a plan's category package.
// The built-in Информация category is excluded: every customer has it
// unconditionally, so selling it in a plan would be meaningless.
function catalogCategories() {
  return catalog().categories.filter((c) => !c.builtin);
}
const knownCategoryIds = () => new Set(catalogCategories().map((c) => c.id));
const categoryNameMap = () => new Map(catalogCategories().map((c) => [c.id, c.name]));

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
// Channel-catalog surface (sources, categories, channels, per-customer access).
// Mounted inside /api so it inherits the auth + CSRF middleware above.
router.use('/api', catalogRouter);

router.get('/api/state', (req, res) => {
  const incidents = Incidents.all();
  const overrideCounts = Overrides.countByUser();
  const channels = catalog().channels;
  res.json({
    csrfToken: csrfToken(),
    publicBaseUrl: config.publicBaseUrl,
    expiringThresholdDays: config.expiringThresholdDays,
    statusSlideEnabled: config.statusSlide.enabled,
    notify: { enabled: config.notify.enabled },
    settings: Settings.all(),
    plans: Plans.all().map((p) => planJson(p, categoryNameMap())),
    // Headline catalog numbers only — the channel rows themselves are paged
    // through /api/catalog/channels, because a provider playlist can be tens of
    // thousands of rows and this payload loads on every screen.
    catalog: {
      sources: catalog().sources.length,
      categories: catalog().categories.length,
      channels: channels.filter((c) => !c.missing).length,
      enabled: channels.filter((c) => !c.missing && c.enabled !== false).length,
    },
    users: Users.all().map((u) => ({
      ...decorateUser(u),
      personal_overrides: overrideCounts.get(u.id) || 0,
    })),
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
  // Drop the customer's personal channel pins alongside the account, so a later
  // user id reuse can't inherit a stranger's exceptions.
  Overrides.reset(id);
  log.info('admin', 'user deleted', { user_id: id });
  res.json({ ok: true });
});

// The exact .m3u this customer's player receives — handy for support ("what do
// they actually see?") without having to open their capability URL.
router.get('/api/users/:id/playlist', (req, res) => {
  const user = Users.get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not found' });
  return res.json({ text: renderUserPlaylist(user) });
});

// Create plan. Rebuilds streams because expired accounts show every plan; the
// category list also changes what its customers receive in their .m3u, but that
// needs no rebuild (playlists are rendered per request).
router.post('/api/plans', (req, res) => {
  const { name, price_eur, billing_period = '', category_ids = [] } = req.body || {};
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.status(400).json({ error: 'plan name required' });
  if (cleanName.length > 80) return res.status(400).json({ error: 'plan name must be 80 characters or less' });
  const price = parsePriceCents(price_eur);
  if (price.error) return res.status(400).json({ error: price.error });
  if (!VALID_PERIODS.includes(billing_period)) return res.status(400).json({ error: 'bad billing_period' });
  if (duplicatePlanName(Plans.all(), cleanName)) return res.status(409).json({ error: 'a plan with this name already exists' });
  const parsed = parsePlanCategories(category_ids, knownCategoryIds());
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const plan = Plans.create({
    name: cleanName,
    price_cents: price.cents,
    currency: 'EUR',
    billing_period,
    category_ids: parsed.categoryIds,
  });
  log.info('admin', 'plan created', {
    plan_id: plan.id, name: plan.name, categories: parsed.categoryIds.length,
  });
  regenAll('admin plan created');
  res.status(201).json(planJson(plan, categoryNameMap()));
});

// Update plan -> rebuild streams because active cards and expired plan grids use it.
router.patch('/api/plans/:id', (req, res) => {
  const id = req.params.id;
  const plan = Plans.get(id);
  if (!plan) return res.status(404).json({ error: 'not found' });
  const { price_eur, name, billing_period, category_ids: categoryIds } = req.body || {};
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
  if (categoryIds !== undefined) {
    const parsed = parsePlanCategories(categoryIds, knownCategoryIds());
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    updates.category_ids = parsed.categoryIds;
  }

  const updated = Plans.update(id, updates);
  log.info('admin', 'plan updated', { plan_id: id, fields: Object.keys(updates) });
  regenAll('admin plan updated');
  res.json(planJson(updated, categoryNameMap()));
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

// Admin-managed subscriber for a user: add an address, change its topics, and
// optionally mark it verified without the double opt-in email (the admin vouches
// for the address). Same store as the public /sub flow — an unchanged, already
// verified address keeps its verified state; a new/changed address drops to
// unverified and either gets a verification link (default) or is marked verified
// straight away when `verified: true` is sent (no email at all).
router.put('/api/users/:id/subscriber', (req, res) => {
  const id = Number(req.params.id);
  const user = Users.get(id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const { error, value } = notify.validateSubscription(req.body || {});
  if (error) return res.status(400).json({ error });
  const markVerified = req.body?.verified === true;
  let sub = Subscribers.upsert(id, value);
  let sentVerification = false;
  if (markVerified) {
    if (!sub.verified) sub = Subscribers.markVerified(id);
  } else if (!sub.verified) {
    // Double opt-in, same as the public sign-up: mail the verification link.
    fireNotify(() => notify.sendVerification(user, sub), 'verification email failed');
    sentVerification = true;
  }
  log.info('admin', 'subscriber saved', { user_id: id, verified: sub.verified, markVerified });
  res.json({
    ok: true, email: sub.email, options: sub.options, verified: !!sub.verified, sentVerification,
  });
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
