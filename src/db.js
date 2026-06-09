// Lightweight JSON-file data store (no native deps). Holds plans, users, settings.
// Adequate for an info-channel's data volume; writes are atomic (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { config } from './config.js';
import { log } from './logger.js';

const DB_FILE = path.join(config.dataDir, 'db.json');

// URL-safe token without ambiguous characters.
const makeToken = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 16);

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
  data.seq ||= 0;
  data.settings ||= {};
  if (data.settings.brand_name === undefined) data.settings.brand_name = 'Мой IPTV-сервис';
  if (data.settings.tagline === undefined) data.settings.tagline = 'Информационный канал аккаунта';
  for (const [index, plan] of data.plans.entries()) {
    if (!Array.isArray(plan.features)) plan.features = [];
    if (!Number.isFinite(plan.sort)) plan.sort = index + 1;
    if (plan.billing_period === undefined) plan.billing_period = '';
  }
}

function save() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

load();

// Merge plan fields onto a user record (mimics the old SQL join).
function decorate(u) {
  if (!u) return u;
  const plan = data.plans.find((p) => p.id === u.plan_id) || {};
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
  all: () =>
    [...data.users]
      .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()))
      .map(decorate),
  get: (id) => decorate(data.users.find((u) => u.id === Number(id))),
  getByToken: (token) => decorate(data.users.find((u) => u.token === token)),
  create: ({ username, plan_id, expires_at, active = 1, token }) => {
    const id = ++data.seq;
    const u = {
      id,
      username,
      token: token || makeToken(),
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
    const i = data.users.findIndex((x) => x.id === Number(id));
    if (i !== -1) { data.users.splice(i, 1); save(); }
  },
};

// ---- Settings ----
export const Settings = {
  all: () => ({ ...data.settings }),
  get: (key) => data.settings[key],
  set: (key, value) => { data.settings[key] = value; save(); },
};

export default { Plans, Users, Settings };
