// Admin web config: login + JSON API to manage users, plans and settings.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { Users, Plans, Settings } from '../db.js';
import {
  daysLeft, accountStatus, formatPrice, formatDate, STATUS_META,
} from '../util.js';
import {
  generateForUser, generateAll, generationStatus, removeUserHls,
} from '../channel.js';
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
    .catch((e) => log.error('admin', 'user regeneration failed', { reason, error: e.message }));
}
function regenAll(reason) {
  generateAll({ reason })
    .catch((e) => log.error('admin', 'bulk regeneration failed', { reason, error: e.message }));
}

const VALID_PERIODS = ['', 'month', 'year'];

function planJson(plan) {
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

function parseFeatures(value) {
  if (!Array.isArray(value)) return { error: 'features must be an array' };
  const features = value.map((feature) => String(feature).trim()).filter(Boolean);
  if (features.length > 12) return { error: 'a plan can have at most 12 features' };
  if (features.some((feature) => feature.length > 100)) {
    return { error: 'each feature must be 100 characters or less' };
  }
  return { features };
}

function duplicatePlanName(name, exceptId = null) {
  const normalized = name.trim().toLocaleLowerCase();
  return Plans.all().some((plan) => (
    plan.id !== exceptId && plan.name.trim().toLocaleLowerCase() === normalized
  ));
}

function decorateUser(u) {
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
  res.json({
    publicBaseUrl: config.publicBaseUrl,
    expiringThresholdDays: config.expiringThresholdDays,
    settings: Settings.all(),
    plans: Plans.all().map(planJson),
    users: Users.all().map(decorateUser),
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
  if (!Users.get(id)) return res.status(404).json({ error: 'not found' });
  const { username, plan_id, expires_at, active } = req.body || {};
  if (plan_id && !Plans.get(plan_id)) return res.status(400).json({ error: 'unknown plan_id' });
  const u = Users.update(id, { username, plan_id, expires_at, active });
  log.info('admin', 'user updated', { user_id: u.id, username: u.username });
  regen(u.id, 'admin user updated');
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
  const cents = Math.round(Number(price_eur) * 100);
  if (!cleanName) return res.status(400).json({ error: 'plan name required' });
  if (cleanName.length > 80) return res.status(400).json({ error: 'plan name must be 80 characters or less' });
  if (price_eur === '' || price_eur === null || price_eur === undefined || !Number.isFinite(cents) || cents < 0) {
    return res.status(400).json({ error: 'bad price' });
  }
  if (!VALID_PERIODS.includes(billing_period)) return res.status(400).json({ error: 'bad billing_period' });
  if (duplicatePlanName(cleanName)) return res.status(409).json({ error: 'a plan with this name already exists' });
  const parsedFeatures = parseFeatures(features);
  if (parsedFeatures.error) return res.status(400).json({ error: parsedFeatures.error });

  const plan = Plans.create({
    name: cleanName,
    price_cents: cents,
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
    const cents = Math.round(Number(price_eur) * 100);
    if (price_eur === '' || price_eur === null || !Number.isFinite(cents) || cents < 0) {
      return res.status(400).json({ error: 'bad price' });
    }
    updates.price_cents = cents;
  }
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) return res.status(400).json({ error: 'plan name required' });
    if (cleanName.length > 80) return res.status(400).json({ error: 'plan name must be 80 characters or less' });
    if (duplicatePlanName(cleanName, id)) return res.status(409).json({ error: 'a plan with this name already exists' });
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

// Rebuild all streams
router.post('/api/regenerate-all', async (req, res) => {
  log.info('admin', 'manual bulk regeneration requested');
  const results = await generateAll({ reason: 'admin manual bulk regeneration' });
  res.json({ ok: true, results });
});

export default router;
