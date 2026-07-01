// Lightweight JSON-file data store (no native deps). Holds plans, users, settings.
// Adequate for an info-channel's data volume; writes are atomic (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { config } from './config.js';
import { log } from './logger.js';
import { INCIDENT_SEVERITIES } from './render/status.js';

const DB_FILE = path.join(config.dataDir, 'db.json');

// URL-safe token without ambiguous characters.
const makeToken = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 16);
const makeIncidentId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 10);

function nowIso() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function defaultData() {
  return {
    seq: 0,
    plans: [
      {
        id: 'standard',
        name: 'Стандарт',
        price_cents: 499,
        currency: 'EUR',
        sort: 1,
        features: ['Эстонские каналы', 'Базовый пакет каналов'],
      },
      {
        id: 'pro',
        name: 'Про',
        price_cents: 699,
        currency: 'EUR',
        sort: 2,
        features: ['Спортивные каналы', 'Эстонские каналы', 'Расширенный пакет каналов'],
      },
    ],
    users: [],
    incidents: [],
    settings: { brand_name: 'Мой IPTV-сервис', tagline: 'Информационный канал аккаунта' },
  };
}

let data;
function load() {
  if (fs.existsSync(DB_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      const backup = `${DB_FILE}.corrupt-${Date.now()}`;
      fs.renameSync(DB_FILE, backup);
      log.error('database', 'db.json was corrupt; starting with fresh data', {
        backup,
        error: e.message,
      });
      data = defaultData();
      save();
    }
  } else {
    data = defaultData();
    save();
  }
  // Ensure defaults exist after upgrades.
  data.plans ||= [];
  data.users ||= [];
  data.incidents ||= [];
  data.subscribers ||= [];
  data.notify_log ||= [];
  data.seq ||= 0;
  data.settings ||= {};
  if (data.settings.brand_name === undefined) data.settings.brand_name = 'Мой IPTV-сервис';
  if (data.settings.tagline === undefined) data.settings.tagline = 'Информационный канал аккаунта';
  for (const [index, plan] of data.plans.entries()) {
    if (!Array.isArray(plan.features)) plan.features = [];
    if (!Number.isFinite(plan.sort)) plan.sort = index + 1;
    if (plan.billing_period === undefined) plan.billing_period = '';
  }
  // Backfill the notification token (separate from the stream token so the
  // on-screen sign-up QR never exposes stream access).
  let changed = false;
  for (const u of data.users) {
    if (!u.notify_token) { u.notify_token = makeToken(); changed = true; }
  }
  // Subscribers predating email verification are grandfathered as verified (they
  // went through the earlier confirm step); new ones default to unverified.
  for (const s of data.subscribers) {
    if (s.verified === undefined) { s.verified = true; s.verify_token = null; changed = true; }
  }
  if (changed) save();
}

function save() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

load();

// Merge plan fields onto a user record (mimics the old SQL join). Pass a
// prebuilt `planById` map when decorating many users to keep the join O(n+m).
function decorate(u, planById) {
  if (!u) return u;
  const plan = (planById ? planById.get(u.plan_id) : data.plans.find((p) => p.id === u.plan_id)) || {};
  return {
    ...u,
    plan_name: plan.name ?? u.plan_id,
    price_cents: plan.price_cents ?? 0,
    currency: plan.currency ?? 'EUR',
    billing_period: plan.billing_period ?? '',
  };
}

function cleanFeatures(features) {
  if (!Array.isArray(features)) return [];
  return features
    .map((feature) => String(feature).trim())
    .filter(Boolean);
}

function makePlanId(name) {
  const base = String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'plan';

  let id = base;
  let suffix = 2;
  while (data.plans.some((plan) => plan.id === id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

// ---- Plans ----
export const Plans = {
  all: () => [...data.plans].sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name)),
  get: (id) => data.plans.find((p) => p.id === id) || null,
  create: ({ name, price_cents, currency = 'EUR', billing_period = '', features = [] }) => {
    const p = {
      id: makePlanId(name),
      name,
      price_cents,
      currency,
      billing_period,
      features: cleanFeatures(features),
      sort: data.plans.reduce((max, plan) => Math.max(max, Number(plan.sort) || 0), 0) + 1,
    };
    data.plans.push(p);
    save();
    return p;
  },
  update: (id, fields) => {
    const p = data.plans.find((x) => x.id === id);
    if (!p) return null;
    for (const key of ['name', 'price_cents', 'currency', 'billing_period', 'sort']) {
      if (fields[key] !== undefined) p[key] = fields[key];
    }
    if (fields.features !== undefined) p.features = cleanFeatures(fields.features);
    save();
    return p;
  },
  remove: (id) => {
    const index = data.plans.findIndex((plan) => plan.id === id);
    if (index === -1) return false;
    data.plans.splice(index, 1);
    save();
    return true;
  },
};

// ---- Users ----
export const Users = {
  all: () => {
    const planById = new Map(data.plans.map((p) => [p.id, p]));
    return [...data.users]
      .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()))
      .map((u) => decorate(u, planById));
  },
  get: (id) => decorate(data.users.find((u) => u.id === Number(id))),
  getByToken: (token) => decorate(data.users.find((u) => u.token === token)),
  getByNotifyToken: (token) => decorate(data.users.find((u) => u.notify_token === token)),
  create: ({ username, plan_id, expires_at, active = 1, token }) => {
    const id = ++data.seq;
    const u = {
      id,
      username,
      token: token || makeToken(),
      notify_token: makeToken(),
      plan_id,
      expires_at: expires_at || null,
      active: active ? 1 : 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    data.users.push(u);
    save();
    return decorate(u);
  },
  update: (id, fields) => {
    const u = data.users.find((x) => x.id === Number(id));
    if (!u) return null;
    for (const k of ['username', 'plan_id', 'expires_at']) {
      if (fields[k] !== undefined) u[k] = fields[k];
    }
    if (fields.active !== undefined) u.active = fields.active ? 1 : 0;
    u.updated_at = nowIso();
    save();
    return decorate(u);
  },
  regenerateToken: (id) => {
    const u = data.users.find((x) => x.id === Number(id));
    if (!u) return null;
    u.token = makeToken();
    u.updated_at = nowIso();
    save();
    return decorate(u);
  },
  remove: (id) => {
    const numId = Number(id);
    const i = data.users.findIndex((x) => x.id === numId);
    if (i === -1) return;
    data.users.splice(i, 1);
    // Drop the user's notification subscriber row alongside the account.
    const si = data.subscribers.findIndex((s) => s.user_id === numId);
    if (si !== -1) data.subscribers.splice(si, 1);
    save();
  },
};

// ---- Notification subscribers (one per user; keyed by user_id) ----
// Renewal notices are mandatory, so that option is always forced on.
function cleanOptions(options = {}) {
  return { server: !!options.server, expiry: !!options.expiry, renewal: true };
}

export const Subscribers = {
  all: () => data.subscribers.map((s) => ({ ...s })),
  byUser: (userId) => {
    const s = data.subscribers.find((x) => x.user_id === Number(userId));
    return s ? { ...s } : null;
  },
  upsert: (userId, { email, options }) => {
    const id = Number(userId);
    let s = data.subscribers.find((x) => x.user_id === id);
    if (s) {
      const emailChanged = s.email !== email;
      s.email = email;
      s.options = cleanOptions(options);
      s.updated_at = nowIso();
      // A new/changed address must re-prove control: drop to unverified, mint a
      // fresh verification token, and re-arm the expiry warning.
      if (emailChanged) {
        s.verified = false;
        s.verify_token = makeToken();
        s.last_expiry_notice = null;
      }
    } else {
      s = {
        user_id: id,
        email,
        options: cleanOptions(options),
        verified: false,
        verify_token: makeToken(),
        created_at: nowIso(),
        updated_at: nowIso(),
        last_expiry_notice: null,
      };
      data.subscribers.push(s);
    }
    save();
    return { ...s };
  },
  verifyByToken: (token) => {
    const s = data.subscribers.find((x) => x.verify_token === token);
    return s ? { ...s } : null;
  },
  markVerified: (userId) => {
    const s = data.subscribers.find((x) => x.user_id === Number(userId));
    if (!s) return null;
    s.verified = true;
    s.verify_token = null;
    s.updated_at = nowIso();
    save();
    return { ...s };
  },
  setExpiryNotice: (userId, value) => {
    const s = data.subscribers.find((x) => x.user_id === Number(userId));
    if (!s) return;
    s.last_expiry_notice = value;
    save();
  },
  remove: (userId) => {
    const i = data.subscribers.findIndex((x) => x.user_id === Number(userId));
    if (i !== -1) { data.subscribers.splice(i, 1); save(); }
  },
};

// ---- Notification send log (capped newest-last ring buffer) ----
const NOTIFY_LOG_MAX = 100;
export const NotifyLog = {
  recent: (n = 30) => data.notify_log.slice(-n).reverse(),
  add: (entry) => {
    data.notify_log.push({ at: nowIso(), ...entry });
    if (data.notify_log.length > NOTIFY_LOG_MAX) {
      data.notify_log.splice(0, data.notify_log.length - NOTIFY_LOG_MAX);
    }
    save();
  },
};

// ---- Incidents (drive the status-board slide) ----
function cleanIncidentFields(fields) {
  const out = {};
  if (fields.title !== undefined) out.title = String(fields.title).trim();
  if (fields.severity !== undefined && INCIDENT_SEVERITIES.includes(fields.severity)) {
    out.severity = fields.severity;
  }
  if (fields.starts_on !== undefined) out.starts_on = fields.starts_on || null;
  if (fields.ends_on !== undefined) out.ends_on = fields.ends_on || null;
  if (fields.note !== undefined) out.note = String(fields.note || '').trim();
  return out;
}

export const Incidents = {
  // Newest first by start date, then most recently created.
  all: () => [...data.incidents].sort(
    (a, b) => String(b.starts_on).localeCompare(String(a.starts_on))
      || String(b.created_at).localeCompare(String(a.created_at)),
  ),
  get: (id) => data.incidents.find((i) => i.id === id) || null,
  create: ({ title, severity, starts_on, ends_on = null, note = '' }) => {
    const i = {
      id: makeIncidentId(),
      title: String(title).trim(),
      severity: INCIDENT_SEVERITIES.includes(severity) ? severity : 'degraded',
      starts_on: starts_on || null,
      ends_on: ends_on || null,
      note: String(note || '').trim(),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    data.incidents.push(i);
    save();
    return i;
  },
  update: (id, fields) => {
    const i = data.incidents.find((x) => x.id === id);
    if (!i) return null;
    Object.assign(i, cleanIncidentFields(fields));
    i.updated_at = nowIso();
    save();
    return i;
  },
  remove: (id) => {
    const index = data.incidents.findIndex((i) => i.id === id);
    if (index === -1) return false;
    data.incidents.splice(index, 1);
    save();
    return true;
  },
};

// ---- Settings ----
export const Settings = {
  all: () => ({ ...data.settings }),
  set: (key, value) => { data.settings[key] = value; save(); },
};

// ---- Demo seed ----
// Create a few sample users so the channel is visible immediately. No-op if any
// user already exists. Used by the `npm run seed` CLI shim (src/seed.js).
export function seedDemo() {
  const existing = Users.all();
  if (existing.length > 0) return { skipped: true, existing: existing.length, created: [] };
  const dateInDays = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const demos = [
    { username: 'Alice', plan_id: 'pro', expires_at: dateInDays(90) },       // active
    { username: 'Bob', plan_id: 'standard', expires_at: dateInDays(4) },      // expiring soon
    { username: 'Charlie', plan_id: 'standard', expires_at: dateInDays(-3) }, // expired
  ];
  const created = demos.map((d) => Users.create(d));
  return { skipped: false, existing: 0, created };
}
