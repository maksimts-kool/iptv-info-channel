// The curated channel catalog: upstream playlist sources, the categories and
// channels imported from them, and each customer's personal visibility
// overrides.
//
// Stored in its own file (DATA_DIR/catalog.json) rather than in data/store.js's
// db.json on purpose: a provider playlist can carry tens of thousands of
// channels, and both stores rewrite the whole file on every save. Keeping them
// apart means toggling one user's expiry date doesn't rewrite megabytes of
// channel rows (and vice versa). Same atomic tmp+rename write and
// corrupt-file backup-and-reset behaviour as data/store.js.
import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { config } from '../config.js';
import { log } from '../core/logger.js';
import { parseM3u } from './m3u.js';
import {
  INFO_CATEGORY_ID, INFO_CHANNEL_ID, ensureBuiltins, mergeSourceChannels,
  normalizeName, resolveUserChannels, channelCounts,
} from './model.js';

// A plan's `category_ids` as a lookup Set. `null` (no plan) means "unrestricted"
// to the resolver, so callers that genuinely have no plan must pass an empty Set
// rather than null if the customer should get nothing.
export function planCategorySet(plan) {
  return new Set(plan?.plan_categories || plan?.category_ids || []);
}

// The category names a plan grants, in display order — this is what the info
// channel prints as the plan's contents and what the admin sees on the card.
export function planCategoryNames(plan) {
  const granted = planCategorySet(plan);
  return data.categories
    .filter((c) => granted.has(c.id) && !c.builtin)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name))
    .map((c) => c.name);
}

// Decorate plans with the category names they grant, under the `features` key
// the plan cards in render/overlay.js already render. Keeping that key means the
// renderer (and its golden tests) need no knowledge of the catalog.
export function describePlans(plans) {
  return plans.map((plan) => ({ ...plan, features: planCategoryNames(plan) }));
}

// How many plans grant each category — surfaced in the admin so a category that
// nobody is paying for is obvious.
export function planCountsByCategory(plans) {
  const counts = new Map();
  for (const plan of plans) {
    for (const id of plan.category_ids || []) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

const CATALOG_FILE = path.join(config.dataDir, 'catalog.json');
const makeId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 12);

function nowIso() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function defaultData() {
  return {
    sources: [], categories: [], channels: [], overrides: {},
  };
}

let data;
function load() {
  if (fs.existsSync(CATALOG_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    } catch (e) {
      const backup = `${CATALOG_FILE}.corrupt-${Date.now()}`;
      fs.renameSync(CATALOG_FILE, backup);
      log.error('catalog', 'catalog.json was corrupt; starting with an empty catalog', {
        backup, error: e.message,
      });
      data = defaultData();
    }
  } else {
    data = defaultData();
  }
  data.sources ||= [];
  data.categories ||= [];
  data.channels ||= [];
  data.overrides ||= {};
  ensureBuiltins(data, { infoCategoryName: config.catalog.infoCategoryName });
  save();
}

function save() {
  const tmp = `${CATALOG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, CATALOG_FILE);
}

load();

// Read-only snapshot for the pure helpers in model.js.
export function catalog() {
  return data;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const Sources = {
  all: () => data.sources.map((s) => ({ ...s })),
  get: (id) => data.sources.find((s) => s.id === id) || null,
  create: ({ name, url, enabled = true }) => {
    const source = {
      id: makeId(),
      name: normalizeName(name) || 'Источник',
      url: String(url).trim(),
      enabled: !!enabled,
      epg_url: '',
      last_sync_at: null,
      last_error: null,
      last_count: 0,
      created_at: nowIso(),
    };
    data.sources.push(source);
    save();
    return { ...source };
  },
  update: (id, fields) => {
    const source = data.sources.find((s) => s.id === id);
    if (!source) return null;
    if (fields.name !== undefined) source.name = normalizeName(fields.name) || source.name;
    if (fields.url !== undefined) source.url = String(fields.url).trim();
    if (fields.enabled !== undefined) source.enabled = !!fields.enabled;
    save();
    return { ...source };
  },
  // Removing a source drops the channels it imported. Categories are shared
  // between sources, so an emptied non-builtin category goes too.
  remove: (id) => {
    const index = data.sources.findIndex((s) => s.id === id);
    if (index === -1) return false;
    data.sources.splice(index, 1);
    data.channels = data.channels.filter((c) => c.source_id !== id);
    const used = new Set(data.channels.map((c) => c.category_id));
    data.categories = data.categories.filter((c) => c.builtin || used.has(c.id));
    save();
    return true;
  },
};

// Download an upstream playlist. Guards a hostile/broken URL with a timeout and
// a hard byte cap so a bad source can't hang or exhaust memory.
async function fetchPlaylist(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' },
    signal: AbortSignal.timeout(config.catalog.fetchTimeoutMs),
  });
  if (!res.ok) throw new Error(`upstream responded ${res.status}`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > config.catalog.maxBytes) {
    throw new Error(`playlist is larger than the ${config.catalog.maxBytes} byte limit`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > config.catalog.maxBytes) {
    throw new Error(`playlist is larger than the ${config.catalog.maxBytes} byte limit`);
  }
  return buffer.toString('utf8');
}

// Fetch one source and merge it into the catalog. Any failure is recorded on
// the source row (surfaced in the admin) and re-thrown for the caller.
export async function refreshSource(id, { fetchImpl } = {}) {
  const source = data.sources.find((s) => s.id === id);
  if (!source) throw new Error('source not found');
  try {
    const text = await fetchPlaylist(source.url, fetchImpl);
    const parsed = parseM3u(text);
    if (!parsed.items.length) throw new Error('no channels found in the playlist');

    const stats = mergeSourceChannels(data, source.id, parsed, { makeId });
    // Providers advertise their own guide on the #EXTM3U line; remember it so
    // the customer playlist can pass it through alongside our own EPG.
    source.epg_url = parsed.headerAttrs['url-tvg'] || parsed.headerAttrs['x-tvg-url'] || '';
    source.last_sync_at = nowIso();
    source.last_error = null;
    source.last_count = parsed.items.length;
    save();
    log.info('catalog', 'source refreshed', {
      source_id: source.id, name: source.name, ...stats, malformed: parsed.malformed,
    });
    return { ...stats, malformed: parsed.malformed, total: parsed.items.length };
  } catch (e) {
    source.last_error = e.message;
    source.last_sync_at = nowIso();
    save();
    log.error('catalog', 'source refresh failed', { source_id: source.id, error: e.message });
    throw e;
  }
}

// Refresh every enabled source; used by the daily cron and the admin's
// "refresh all" button. Never throws — one dead provider must not stop the rest.
export async function refreshAllSources() {
  const results = [];
  for (const source of data.sources.filter((s) => s.enabled)) {
    try {
      results.push({ id: source.id, ok: true, ...(await refreshSource(source.id)) });
    } catch (e) {
      results.push({ id: source.id, ok: false, error: e.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const Categories = {
  all: () => data.categories.map((c) => ({ ...c })),
  get: (id) => data.categories.find((c) => c.id === id) || null,
  counts: () => channelCounts(data),
  create: ({ name, enabled = true }) => {
    const category = {
      id: makeId(),
      key: `custom:${makeId()}`,
      name: normalizeName(name) || 'Новая категория',
      source_name: '',
      enabled: !!enabled,
      builtin: false,
      custom: true,
      sort: data.categories.reduce((max, c) => Math.max(max, c.sort ?? 0), 0) + 1,
    };
    data.categories.push(category);
    save();
    return { ...category };
  },
  update: (id, fields) => {
    const category = data.categories.find((c) => c.id === id);
    if (!category) return null;
    if (fields.name !== undefined) category.name = normalizeName(fields.name) || category.name;
    // The built-in Информация category must stay on — it is the fallback an
    // expired customer keeps, so letting it be switched off would leave that
    // customer with an empty playlist.
    if (fields.enabled !== undefined && !category.builtin) category.enabled = !!fields.enabled;
    if (Number.isFinite(fields.sort) && !category.builtin) category.sort = fields.sort;
    save();
    return { ...category };
  },
  // Reorder in one write: `ids` is the new display order.
  reorder: (ids) => {
    ids.forEach((id, index) => {
      const category = data.categories.find((c) => c.id === id);
      if (category && !category.builtin) category.sort = index + 1;
    });
    save();
    return Categories.all();
  },
  // Deleting a category deletes the channels in it (they have nowhere to live).
  // Callers must also drop it from the plans that granted it — see
  // Plans.removeCategory in data/store.js, wired up in http/catalog.js.
  remove: (id) => {
    const category = data.categories.find((c) => c.id === id);
    if (!category || category.builtin) return false;
    data.categories = data.categories.filter((c) => c.id !== id);
    data.channels = data.channels.filter((c) => c.category_id !== id);
    // Per-customer pins for a category that no longer exists are dead weight.
    for (const entry of Object.values(data.overrides)) delete entry.categories?.[id];
    save();
    return true;
  },
};

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

// Paged, filtered channel listing — the admin table can be tens of thousands of
// rows, so the server does the filtering and hands back one page.
export function queryChannels({
  q = '', categoryId = '', sourceId = '', status = 'all', page = 1, pageSize = 50,
} = {}) {
  const needle = normalizeName(q).toLocaleLowerCase();
  const filtered = data.channels.filter((ch) => {
    if (categoryId && ch.category_id !== categoryId) return false;
    if (sourceId && ch.source_id !== sourceId) return false;
    if (status === 'enabled' && ch.enabled === false) return false;
    if (status === 'disabled' && ch.enabled !== false) return false;
    if (status === 'missing' && !ch.missing) return false;
    if (status !== 'missing' && ch.missing) return false;
    if (!needle) return true;
    return String(ch.name).toLocaleLowerCase().includes(needle)
      || String(ch.original_name || '').toLocaleLowerCase().includes(needle);
  });

  const categoryOrder = new Map(data.categories.map((c) => [c.id, c.sort ?? 0]));
  filtered.sort(
    (a, b) => (categoryOrder.get(a.category_id) ?? 0) - (categoryOrder.get(b.category_id) ?? 0)
      || (a.sort ?? 0) - (b.sort ?? 0)
      || String(a.name).localeCompare(String(b.name)),
  );

  const start = Math.max(0, (page - 1) * pageSize);
  return { total: filtered.length, rows: filtered.slice(start, start + pageSize).map((c) => ({ ...c })) };
}

export const Channels = {
  get: (id) => data.channels.find((c) => c.id === id) || null,
  // Add a channel by hand (an extra stream the upstream playlist doesn't carry).
  create: ({ name, url, category_id, attrs = {}, enabled = true }) => {
    const channel = {
      id: makeId(),
      key: `custom:${makeId()}`,
      source_id: null,
      category_id,
      name: normalizeName(name),
      original_name: normalizeName(name),
      url: String(url).trim(),
      attrs,
      extras: [],
      enabled: !!enabled,
      builtin: false,
      custom: true,
      missing: false,
      sort: data.channels.reduce((max, c) => Math.max(max, c.sort ?? 0), 0) + 1,
      added_at: nowIso(),
    };
    data.channels.push(channel);
    save();
    return { ...channel };
  },
  update: (id, fields) => {
    const channel = data.channels.find((c) => c.id === id);
    if (!channel) return null;
    applyChannelFields(channel, fields);
    save();
    return { ...channel };
  },
  // One write for a multi-row edit (enable/disable or re-group a selection).
  bulkUpdate: (ids, fields) => {
    const wanted = new Set(ids);
    let changed = 0;
    for (const channel of data.channels) {
      if (!wanted.has(channel.id)) continue;
      applyChannelFields(channel, fields);
      changed += 1;
    }
    if (changed) save();
    return changed;
  },
  remove: (id) => {
    const channel = data.channels.find((c) => c.id === id);
    if (!channel || channel.builtin) return false;
    data.channels = data.channels.filter((c) => c.id !== id);
    save();
    return true;
  },
};

// The built-in info channel may be renamed but must keep its category and stay
// on: it is what an expired customer is left with, and moving it into a
// category that can be switched off would empty that fallback.
function applyChannelFields(channel, fields) {
  if (fields.name !== undefined) channel.name = normalizeName(fields.name);
  if (channel.builtin) return;
  if (fields.enabled !== undefined) channel.enabled = !!fields.enabled;
  if (fields.category_id !== undefined && data.categories.some((c) => c.id === fields.category_id)) {
    channel.category_id = fields.category_id;
  }
  if (fields.url !== undefined) channel.url = String(fields.url).trim();
}

// ---------------------------------------------------------------------------
// Per-customer overrides
// ---------------------------------------------------------------------------

// A sparse map of explicit per-customer decisions:
//   { categories: { <id>: true|false }, channels: { <id>: true|false } }
// Absent means "inherit the global setting" — so a new customer automatically
// tracks catalog changes, and only deliberate exceptions are stored.
export const Overrides = {
  get: (userId) => {
    const entry = data.overrides[String(userId)];
    return {
      categories: { ...(entry?.categories || {}) },
      channels: { ...(entry?.channels || {}) },
    };
  },
  // `patch` values: true / false to pin, null to fall back to the global value.
  patch: (userId, { categories = {}, channels = {} }) => {
    const key = String(userId);
    const entry = data.overrides[key] || { categories: {}, channels: {} };
    for (const [id, value] of Object.entries(categories)) {
      if (value === null) delete entry.categories[id];
      else entry.categories[id] = !!value;
    }
    for (const [id, value] of Object.entries(channels)) {
      if (value === null) delete entry.channels[id];
      else entry.channels[id] = !!value;
    }
    if (!Object.keys(entry.categories).length && !Object.keys(entry.channels).length) {
      delete data.overrides[key];
    } else {
      data.overrides[key] = entry;
    }
    save();
    return Overrides.get(userId);
  },
  reset: (userId) => {
    delete data.overrides[String(userId)];
    save();
  },
  // Number of pinned decisions, for the "personalised" badge in the client list.
  countByUser: () => {
    const out = new Map();
    for (const [userId, entry] of Object.entries(data.overrides)) {
      out.set(
        Number(userId),
        Object.keys(entry.categories || {}).length + Object.keys(entry.channels || {}).length,
      );
    }
    return out;
  },
};

// The ordered channel list one customer may see: their plan's categories, plus
// their personal exceptions, unless `locked` (an expired or deactivated account)
// collapses it to the Информация category alone.
export function channelsForUser(userId, { locked = false, planCategories = null } = {}) {
  return resolveUserChannels(data, {
    overrides: Overrides.get(userId), locked, planCategories,
  });
}

export { INFO_CATEGORY_ID, INFO_CHANNEL_ID };
