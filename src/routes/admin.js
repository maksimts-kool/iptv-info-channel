// Admin web config: login + JSON API to manage users, plans and settings.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
  Users, Plans, Settings, Incidents, Subscribers, NotifyLog,
} from '../db.js';
import { statusSummary } from '../status.js';
import * as notify from '../notify.js';
import {
  incidentJson, planJson, decorateUser,
  parsePriceCents, parseFeatures, duplicatePlanName, validateIncident,
  validateWorldcupSettings, worldcupSummaryJson,
} from '../admin-domain.js';
import {
  generateForUser, generateAll, generationStatus, removeUserHls,
  syncWorldcupSettings, syncNotifySettings,
} from '../channel.js';
import { getWorldCupModel } from '../worldcup.js';
import {
  requireAuth, requireAuthPage, checkPassword, setSession, clearSession,
} from '../middleware/auth.js';
import { log } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PUBLIC = path.join(__dirname, '..', 'public', 'admin');

const router = express.Router();

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

// ---------- Auth pages ----------
router.get('/login', (req, res) => res.sendFile(path.join(ADMIN_PUBLIC, 'login.html')));

router.post('/login', express.urlencoded({ extended: false }), express.json(), (req, res) => {
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

// ---------- Static UI (after auth gate for the page) ----------
router.get('/', requireAuthPage, (req, res) => res.sendFile(path.join(ADMIN_PUBLIC, 'index.html')));
router.use('/static', express.static(ADMIN_PUBLIC));

// ---------- JSON API ----------
router.use('/api', requireAuth, express.json());

router.get('/api/state', (req, res) => {
  const incidents = Incidents.all();
  res.json({
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
