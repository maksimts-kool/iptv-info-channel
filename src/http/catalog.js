// Admin JSON API for the channel catalog: upstream sources, categories,
// channels and each customer's personal visibility overrides.
//
// Mounted by http/admin.js *inside* its /api sub-router, so it inherits the
// session-cookie auth, the CSRF check and the JSON body parser — this file adds
// no auth of its own. It is split out because the catalog is the largest single
// surface in the admin and admin.js was already carrying the whole rest of it.
//
// Unlike plan/branding/incident edits, catalog edits do NOT trigger an ffmpeg
// regeneration: the .m3u is rendered per request from the catalog, so a rename
// or a toggle is live for the customer on their next playlist refresh.
//
// As in admin.js, request validation and response view-models are pure,
// exported and side-effect-free (test/catalog-api.test.js imports them).
import express from 'express';
import { Users, Plans } from '../data.js';
import {
  Sources, Categories, Channels, Overrides,
  queryChannels, refreshSource, refreshAllSources, catalog,
  planCategorySet, planCountsByCategory, INFO_CATEGORY_ID,
} from '../playlist/catalog.js';
import {
  channelCounts, categoryEnabledFor, effectiveEnabled, resolveUserChannels,
} from '../playlist/model.js';
import { accountStatus } from '../util.js';
import { config } from '../config.js';
import { log } from '../logger.js';

// ===========================================================================
// Pure view models + input validation (no Express, no I/O — unit-tested)
// ===========================================================================

export function sourceJson(source) {
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    enabled: !!source.enabled,
    epg_url: source.epg_url || '',
    last_sync_at: source.last_sync_at,
    last_error: source.last_error,
    last_count: source.last_count || 0,
  };
}

export function categoryJson(category, counts = new Map()) {
  const count = counts.get(category.id) || { total: 0, enabled: 0 };
  return {
    id: category.id,
    name: category.name,
    source_name: category.source_name || '',
    enabled: category.enabled !== false,
    builtin: !!category.builtin,
    custom: !!category.custom,
    sort: category.sort ?? 0,
    channels: count.total,
    channels_enabled: count.enabled,
  };
}

export function channelJson(channel) {
  return {
    id: channel.id,
    name: channel.name,
    original_name: channel.original_name || '',
    category_id: channel.category_id,
    source_id: channel.source_id,
    url: channel.url,
    logo: channel.attrs?.['tvg-logo'] || '',
    tvg_id: channel.attrs?.['tvg-id'] || '',
    enabled: channel.enabled !== false,
    builtin: !!channel.builtin,
    custom: !!channel.custom,
    missing: !!channel.missing,
    renamed: !!channel.original_name && channel.name !== channel.original_name,
  };
}

// An http(s) URL is the only thing worth fetching, and rejecting other schemes
// up front keeps `file:`/`data:` URLs out of the fetcher.
export function validateSource(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has('name')) {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'source name required' };
    if (name.length > 80) return { error: 'name must be 80 characters or less' };
    out.name = name;
  }
  if (!partial || has('url')) {
    const url = String(body.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { return { error: 'playlist URL is not valid' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'playlist URL must be http(s)' };
    }
    out.url = url;
  }
  if (has('enabled')) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    out.enabled = body.enabled;
  }
  return { value: out };
}

export function validateCategory(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'category name required' };
    if (name.length > 80) return { error: 'name must be 80 characters or less' };
    out.name = name;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    out.enabled = body.enabled;
  }
  return { value: out };
}

// Fields an admin may change on a channel row. `category_id` is checked against
// the live catalog by the caller.
export function validateChannelPatch(body) {
  const out = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return { error: 'channel name required' };
    if (name.length > 160) return { error: 'name must be 160 characters or less' };
    out.name = name;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    out.enabled = body.enabled;
  }
  if (body.category_id !== undefined) out.category_id = String(body.category_id);
  if (!Object.keys(out).length) return { error: 'nothing to update' };
  return { value: out };
}

const MAX_PAGE_SIZE = 500;

export function parseChannelQuery(query = {}) {
  const pageSize = Number(query.pageSize);
  const page = Number(query.page);
  return {
    q: String(query.q || '').slice(0, 100),
    categoryId: String(query.category || ''),
    sourceId: String(query.source || ''),
    status: ['all', 'enabled', 'disabled', 'missing'].includes(query.status) ? query.status : 'all',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, MAX_PAGE_SIZE) : 50,
  };
}

// A per-customer CHANNEL row: what the catalog says globally, what (if
// anything) this customer has pinned, and the result the playlist will use.
export function personalRowJson(row, override, { locked = false, forced = false } = {}) {
  const pinned = override === true || override === false ? override : null;
  return {
    global_enabled: row.enabled !== false,
    override: pinned,
    effective: forced ? true : (!locked && effectiveEnabled(row, pinned)),
  };
}

// A per-customer CATEGORY row. Adds the layer a channel doesn't have: whether
// the customer's plan includes this category at all. `in_plan` is what the admin
// reads to tell "not sold to them" apart from "switched off for them".
export function personalCategoryJson(category, override, {
  locked = false, planCategories = null,
} = {}) {
  const pinned = override === true || override === false ? override : null;
  const inPlan = category.builtin || !planCategories || planCategories.has(category.id);
  return {
    global_enabled: category.enabled !== false,
    in_plan: inPlan,
    override: pinned,
    effective: category.builtin
      ? true // Информация is unconditional, even for a lapsed account
      : (!locked && categoryEnabledFor(category, pinned, planCategories)),
  };
}

// True when the account itself has switched the playlist off (expired or
// manually disabled) — everything but Информация is withheld regardless of
// overrides, and is restored the moment the expiry date moves forward.
export function isLocked(user, expiringThresholdDays) {
  const status = accountStatus(user, expiringThresholdDays);
  return status === 'expired' || status === 'disabled';
}

// ===========================================================================
// HTTP layer
// ===========================================================================

const router = express.Router();

function catalogOverview() {
  const counts = channelCounts(catalog());
  const plans = Plans.all();
  const planCounts = planCountsByCategory(plans);
  const categories = Categories.all()
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name))
    .map((c) => ({
      ...categoryJson(c, counts),
      // How many plans sell this category. Zero means no customer can ever see
      // it, however enabled it is — worth flagging loudly in the UI.
      plans: c.builtin ? plans.length : (planCounts.get(c.id) || 0),
    }));
  const all = catalog().channels;
  return {
    sources: Sources.all().map(sourceJson),
    categories,
    plans: plans.map((p) => ({
      id: p.id, name: p.name, category_ids: p.category_ids || [],
    })),
    totals: {
      channels: all.filter((c) => !c.missing).length,
      enabled: all.filter((c) => !c.missing && c.enabled !== false).length,
      missing: all.filter((c) => c.missing).length,
      categories: categories.length,
      // Plans that grant nothing: their customers get only Информация.
      emptyPlans: plans.filter((p) => !(p.category_ids || []).length).length,
      // Categories no plan sells.
      unsoldCategories: categories.filter((c) => !c.builtin && !c.plans).length,
    },
    infoCategoryId: INFO_CATEGORY_ID,
  };
}

router.get('/catalog', (req, res) => res.json(catalogOverview()));

// ---------- Sources ----------
router.post('/catalog/sources', (req, res) => {
  const { error, value } = validateSource(req.body || {});
  if (error) return res.status(400).json({ error });
  const source = Sources.create(value);
  log.info('admin', 'playlist source created', { source_id: source.id, name: source.name });
  res.status(201).json(sourceJson(source));
});

router.patch('/catalog/sources/:id', (req, res) => {
  if (!Sources.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const { error, value } = validateSource(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  res.json(sourceJson(Sources.update(req.params.id, value)));
});

router.delete('/catalog/sources/:id', (req, res) => {
  if (!Sources.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  log.info('admin', 'playlist source deleted', { source_id: req.params.id });
  res.json({ ok: true });
});

// Fetch + merge one source now. Slow (a large playlist download), so the client
// shows a spinner rather than this being fire-and-forget: the admin needs to see
// the import result.
router.post('/catalog/sources/:id/refresh', async (req, res) => {
  if (!Sources.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const stats = await refreshSource(req.params.id);
    res.json({ ok: true, stats, catalog: catalogOverview() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/catalog/refresh', async (req, res) => {
  const results = await refreshAllSources();
  res.json({ ok: true, results, catalog: catalogOverview() });
});

// ---------- Categories ----------
router.post('/catalog/categories', (req, res) => {
  const { error, value } = validateCategory(req.body || {});
  if (error) return res.status(400).json({ error });
  res.status(201).json(categoryJson(Categories.create(value), channelCounts(catalog())));
});

router.patch('/catalog/categories/:id', (req, res) => {
  const existing = Categories.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { error, value } = validateCategory(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  if (existing.builtin && value.enabled === false) {
    return res.status(400).json({ error: 'the info category cannot be switched off' });
  }
  const updated = Categories.update(req.params.id, value);
  res.json(categoryJson(updated, channelCounts(catalog())));
});

router.post('/catalog/categories/reorder', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  if (!ids) return res.status(400).json({ error: 'ids must be an array' });
  Categories.reorder(ids);
  res.json(catalogOverview());
});

router.delete('/catalog/categories/:id', (req, res) => {
  const category = Categories.get(req.params.id);
  if (!category) return res.status(404).json({ error: 'not found' });
  if (category.builtin) return res.status(400).json({ error: 'the info category cannot be deleted' });
  Categories.remove(req.params.id);
  // …and stop the plans that sold it from referencing a category that is gone.
  const plansTouched = Plans.removeCategory(req.params.id);
  log.info('admin', 'category deleted', {
    category_id: req.params.id, name: category.name, plans_touched: plansTouched,
  });
  res.json({ ok: true });
});

// ---------- Channels ----------
router.get('/catalog/channels', (req, res) => {
  const params = parseChannelQuery(req.query);
  const { total, rows } = queryChannels(params);
  res.json({ total, page: params.page, pageSize: params.pageSize, rows: rows.map(channelJson) });
});

router.post('/catalog/channels', (req, res) => {
  const { name, url, category_id: categoryId } = req.body || {};
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.status(400).json({ error: 'channel name required' });
  if (!String(url || '').trim()) return res.status(400).json({ error: 'stream URL required' });
  if (!Categories.get(categoryId)) return res.status(400).json({ error: 'unknown category' });
  const channel = Channels.create({ name: cleanName, url, category_id: categoryId });
  res.status(201).json(channelJson(channel));
});

router.patch('/catalog/channels/:id', (req, res) => {
  if (!Channels.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const { error, value } = validateChannelPatch(req.body || {});
  if (error) return res.status(400).json({ error });
  if (value.category_id && !Categories.get(value.category_id)) {
    return res.status(400).json({ error: 'unknown category' });
  }
  res.json(channelJson(Channels.update(req.params.id, value)));
});

// Enable/disable or re-group a selection in one write. `ids` targets an explicit
// selection; `filter` targets everything currently matching the admin's search,
// so "disable all 4 000 results" doesn't need the client to ship 4 000 ids.
router.post('/catalog/channels/bulk', (req, res) => {
  const { ids, filter, ...rest } = req.body || {};
  const { error, value } = validateChannelPatch(rest);
  if (error) return res.status(400).json({ error });
  if (value.category_id && !Categories.get(value.category_id)) {
    return res.status(400).json({ error: 'unknown category' });
  }

  let targets;
  if (Array.isArray(ids)) {
    targets = ids.map(String);
  } else if (filter) {
    const params = parseChannelQuery(filter);
    targets = queryChannels({ ...params, page: 1, pageSize: Number.MAX_SAFE_INTEGER })
      .rows.map((c) => c.id);
  } else {
    return res.status(400).json({ error: 'ids or filter required' });
  }

  const changed = Channels.bulkUpdate(targets, value);
  log.info('admin', 'channels bulk updated', { changed, fields: Object.keys(value) });
  res.json({ ok: true, changed });
});

router.delete('/catalog/channels/:id', (req, res) => {
  if (!Channels.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ---------- Per-customer access ----------
function requireUser(req, res) {
  const user = Users.get(Number(req.params.id));
  if (!user) { res.status(404).json({ error: 'not found' }); return null; }
  return user;
}

// One customer's view of the catalog: every category with its global value,
// this customer's pin and the effective result, plus a page of channels the
// same way. Driving the client from `effective` keeps the expiry lock visible
// (everything shows as off while an account is expired) without persisting it.
router.get('/users/:id/channels', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return undefined;

  const locked = isLocked(user, config.expiringThresholdDays);
  const overrides = Overrides.get(user.id);
  const planCategories = planCategorySet(user);
  const counts = channelCounts(catalog());
  const categories = Categories.all()
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name))
    .map((c) => ({
      ...categoryJson(c, counts),
      ...personalCategoryJson(c, overrides.categories[c.id], { locked, planCategories }),
    }));

  const params = parseChannelQuery(req.query);
  const { total, rows } = queryChannels(params);
  const categoryEffective = new Map(categories.map((c) => [c.id, c.effective]));

  return res.json({
    locked,
    status: accountStatus(user, config.expiringThresholdDays),
    plan: { id: user.plan_id, name: user.plan_name, categories: [...planCategories] },
    categories,
    overrideCount: Object.keys(overrides.categories).length + Object.keys(overrides.channels).length,
    visibleCount: resolveUserChannels(catalog(), { overrides, locked, planCategories }).length,
    channels: {
      total,
      page: params.page,
      pageSize: params.pageSize,
      rows: rows.map((ch) => {
        const personal = personalRowJson(ch, overrides.channels[ch.id], {
          locked, forced: ch.builtin,
        });
        return {
          ...channelJson(ch),
          ...personal,
          // A channel is only really on when its category is on too.
          effective: personal.effective && categoryEffective.get(ch.category_id) !== false,
        };
      }),
    },
  });
});

// Pin/unpin this customer's exceptions. Values: true / false to pin, null to go
// back to inheriting the global setting.
router.patch('/users/:id/channels', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return undefined;
  const { categories = {}, channels = {} } = req.body || {};
  const bad = (map) => Object.values(map).some((v) => v !== true && v !== false && v !== null);
  if (typeof categories !== 'object' || typeof channels !== 'object' || bad(categories) || bad(channels)) {
    return res.status(400).json({ error: 'override values must be true, false or null' });
  }
  if (categories[INFO_CATEGORY_ID] === false) {
    return res.status(400).json({ error: 'the info category cannot be withheld from a customer' });
  }
  const saved = Overrides.patch(user.id, { categories, channels });
  log.info('admin', 'customer channel access updated', {
    user_id: user.id,
    pinned: Object.keys(saved.categories).length + Object.keys(saved.channels).length,
  });
  return res.json({ ok: true, overrides: saved });
});

router.post('/users/:id/channels/reset', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return undefined;
  Overrides.reset(user.id);
  log.info('admin', 'customer channel access reset to defaults', { user_id: user.id });
  return res.json({ ok: true });
});

export default router;
