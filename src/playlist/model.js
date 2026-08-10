// Pure catalog logic: how an upstream playlist merges into the curated catalog,
// and which channels a given customer may see. No I/O, no module state — the
// JSON store and the HTTP fetching live in catalog.js, so everything here stays
// unit-testable in isolation (test/playlist/model.test.js).

// The built-in category that carries this server's own info channel. It is the
// only category an expired or disabled customer keeps, so it can never be
// deleted and its per-user visibility is not overridable.
export const INFO_CATEGORY_ID = 'info';
export const INFO_CHANNEL_ID = 'info-account';

// Built-in rows sort ahead of imported ones so Информация is always first.
const INFO_SORT = -1;

export function normalizeName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Categories are shared across sources: two providers both publishing "Спорт"
// land in one category, so the customer sees one group, not two.
export function categoryKey(name) {
  return normalizeName(name).toLocaleLowerCase() || 'без категории';
}

// Stable identity of an upstream channel across refreshes. `tvg-id` is the
// provider's own identifier and survives URL/token rotation, so it wins; the
// stream URL is the fallback for the many playlists that ship no tvg-id.
// Scoped per source so two providers carrying the same channel stay distinct.
export function channelKey(sourceId, item) {
  const tvgId = normalizeName(item.attrs?.['tvg-id']);
  return tvgId ? `${sourceId}|id:${tvgId}` : `${sourceId}|url:${item.url}`;
}

// Attributes worth keeping from upstream. Everything else (group-title, the
// provider's own bookkeeping) is re-derived from the catalog on output, so
// keeping it would let a stale value override an admin edit.
const KEPT_ATTRS = ['tvg-id', 'tvg-name', 'tvg-logo', 'tvg-shift', 'tvg-chno', 'radio', 'catchup', 'catchup-source', 'catchup-days'];

export function pickAttrs(attrs = {}) {
  const out = {};
  for (const key of KEPT_ATTRS) {
    if (attrs[key]) out[key] = attrs[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

// Make sure the Информация category and its info channel exist. Idempotent:
// an admin rename of either survives (only a missing row is created).
export function ensureBuiltins(state, { infoCategoryName = 'Информация' } = {}) {
  let category = state.categories.find((c) => c.id === INFO_CATEGORY_ID);
  if (!category) {
    category = {
      id: INFO_CATEGORY_ID,
      key: categoryKey(infoCategoryName),
      name: infoCategoryName,
      enabled: true,
      builtin: true,
      sort: INFO_SORT,
    };
    state.categories.push(category);
  }
  let channel = state.channels.find((c) => c.id === INFO_CHANNEL_ID);
  if (!channel) {
    channel = {
      id: INFO_CHANNEL_ID,
      key: INFO_CHANNEL_ID,
      source_id: null,
      category_id: INFO_CATEGORY_ID,
      name: '', // empty => the playlist builder uses "<brand> — <username>"
      original_name: '',
      url: '', // per-user; filled in by the playlist builder
      attrs: {},
      extras: [],
      enabled: true,
      builtin: true,
      missing: false,
      sort: INFO_SORT,
    };
    state.channels.push(channel);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Unattended source refreshing
// ---------------------------------------------------------------------------

// Intervals offered in the admin, in hours. Anything else a client sends is
// rejected, so a stored interval is always one the UI can show back.
export const REFRESH_INTERVALS = [1, 2, 3, 6, 12, 24, 48, 72, 168];

// When this source next becomes due for an automatic re-download, as an epoch
// milliseconds value — or `null` when it is never refreshed automatically
// (disabled source, or auto-refresh switched off for it).
//
// A source that has never been fetched is due immediately. `last_sync_ms` is
// stamped on every ATTEMPT, success or failure, so a permanently broken
// provider is retried on its interval rather than on every tick.
export function sourceDueAt(source, { defaultHours = 24 } = {}) {
  if (!source || source.enabled === false || source.auto_refresh === false) return null;
  if (!source.last_sync_ms) return 0;
  const hours = Number(source.interval_hours) > 0 ? Number(source.interval_hours) : defaultHours;
  return source.last_sync_ms + hours * 3600_000;
}

export function sourceIsDue(source, now = Date.now(), options = {}) {
  const due = sourceDueAt(source, options);
  return due !== null && now >= due;
}

// ---------------------------------------------------------------------------
// Merge an upstream playlist into the catalog
// ---------------------------------------------------------------------------

function upsertCategory(state, name, makeId) {
  const clean = normalizeName(name) || 'Без категории';
  const key = categoryKey(clean);
  let category = state.categories.find((c) => c.key === key);
  if (category) return category;
  category = {
    id: makeId(),
    key,
    name: clean,
    // `source_name` remembers what the provider called the group, so a renamed
    // category can still be traced back to the upstream group it came from.
    source_name: clean,
    enabled: true,
    builtin: false,
    sort: state.categories.reduce((max, c) => Math.max(max, c.sort ?? 0), 0) + 1,
  };
  state.categories.push(category);
  return category;
}

// Fold a parsed upstream playlist into `state` (mutated in place).
//
// Admin edits always win over upstream: a renamed channel keeps its name, a
// channel moved to another category stays there, and a disabled channel stays
// disabled. Only the stream URL and the passthrough attributes/directives are
// refreshed, because those are what actually plays.
//
// Channels that vanished upstream are marked `missing` rather than deleted, so
// a truncated download or a provider hiccup doesn't destroy the admin's
// overrides — they come back intact when the channel reappears.
export function mergeSourceChannels(state, sourceId, parsed, { makeId, now = new Date() } = {}) {
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ');
  const byKey = new Map(
    state.channels.filter((c) => c.source_id === sourceId).map((c) => [c.key, c]),
  );
  const seen = new Set();
  const stats = { added: 0, updated: 0, missing: 0, restored: 0 };

  parsed.items.forEach((item, index) => {
    const key = channelKey(sourceId, item);
    if (seen.has(key)) return; // duplicate line in the upstream file
    seen.add(key);

    const name = normalizeName(item.name) || normalizeName(item.attrs?.['tvg-name']) || item.url;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.missing) { existing.missing = false; stats.restored += 1; }
      existing.url = item.url;
      existing.attrs = pickAttrs(item.attrs);
      existing.extras = item.extras || [];
      existing.original_name = name;
      existing.upstream_group = normalizeName(item.group);
      existing.sort = index;
      stats.updated += 1;
      return;
    }

    const category = upsertCategory(state, item.group, makeId);
    state.channels.push({
      id: makeId(),
      key,
      source_id: sourceId,
      category_id: category.id,
      name, // admin-editable; starts as the upstream name
      original_name: name,
      upstream_group: normalizeName(item.group),
      url: item.url,
      attrs: pickAttrs(item.attrs),
      extras: item.extras || [],
      enabled: true,
      builtin: false,
      missing: false,
      sort: index,
      added_at: stamp,
    });
    stats.added += 1;
  });

  for (const [key, channel] of byKey) {
    if (seen.has(key) || channel.missing) continue;
    channel.missing = true;
    stats.missing += 1;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Per-customer resolution
// ---------------------------------------------------------------------------

// Effective visibility of one row for one customer.
//
// A per-user override is AUTHORITATIVE, not merely subtractive: `false` hides a
// globally enabled row, and `true` grants a globally disabled one. That second
// direction is the point of per-client editing — it lets a channel stay off by
// default and be handed to individual customers.
export function effectiveEnabled(row, override) {
  if (override === true || override === false) return override;
  return row.enabled !== false;
}

// Effective visibility of a CATEGORY, which has one more layer than a channel:
// the customer's plan. Precedence, highest first:
//
//   1. a personal override  — the admin's explicit exception for this customer
//   2. the global enable    — the catalog-wide kill switch for the category
//   3. the plan             — whether the customer is paying for this category
//
// `planCategories` is the Set of category ids the plan grants; pass `null` to
// resolve without a plan restriction (admin previews).
export function categoryEnabledFor(category, override, planCategories = null) {
  if (override === true || override === false) return override;
  if (category.enabled === false) return false;
  if (!planCategories) return true;
  return planCategories.has(category.id);
}

const byOrder = (a, b) => (a.sort ?? 0) - (b.sort ?? 0)
  || String(a.name).localeCompare(String(b.name));

// The ordered channel list one customer may see.
//
// Three layers, applied in order:
//   - the PLAN decides which categories the customer is entitled to;
//   - personal OVERRIDES add or remove individual exceptions on top;
//   - `locked` (an expired or deactivated account) overrules both and leaves
//     ONLY the built-in Информация category.
//
// Nothing is written when an account lapses — visibility is derived on every
// request, so a renewal restores the full list immediately and can never drift
// out of sync with a persisted "disabled everything" flag.
export function resolveUserChannels(
  catalog,
  { overrides = {}, locked = false, planCategories = null } = {},
) {
  const catOverrides = overrides.categories || {};
  const chOverrides = overrides.channels || {};

  const categories = [...catalog.categories]
    .filter((c) => {
      if (c.id === INFO_CATEGORY_ID) return true; // always available
      if (locked) return false;
      return categoryEnabledFor(c, catOverrides[c.id], planCategories);
    })
    .sort(byOrder);

  const visibleCategoryIds = new Map(categories.map((c) => [c.id, c]));

  return [...catalog.channels]
    .filter((ch) => {
      if (ch.missing) return false;
      const category = visibleCategoryIds.get(ch.category_id);
      if (!category) return false;
      if (ch.id === INFO_CHANNEL_ID) return true; // the account channel is mandatory
      return effectiveEnabled(ch, chOverrides[ch.id]);
    })
    .sort((a, b) => {
      const ca = visibleCategoryIds.get(a.category_id);
      const cb = visibleCategoryIds.get(b.category_id);
      return byOrder(ca, cb) || byOrder(a, b);
    })
    .map((channel) => ({ channel, category: visibleCategoryIds.get(channel.category_id) }));
}

// Whether ONE channel is playable for ONE customer, right now.
//
// This is the same three-layer decision resolveUserChannels makes for the whole
// list, asked about a single row: the stream gateway (http/stream.js) calls it
// on every channel switch, so it must agree with the .m3u exactly — and it must
// not sort or copy the catalog to answer, because that catalog can hold tens of
// thousands of channels.
//
// `reason` says which layer refused, for the admin log:
//   unknown  — no such channel id (deleted since the playlist was downloaded)
//   missing  — the channel vanished upstream
//   locked   — the account is expired or deactivated
//   category — the category is not in the plan, off catalog-wide, or pinned off
//   channel  — the channel itself is off (globally or pinned off for this user)
//   no-url   — nothing to play (a custom row saved without a stream URL)
export function resolveChannelAccess(catalog, channelId, {
  overrides = {}, locked = false, planCategories = null,
} = {}) {
  const channel = catalog.channels.find((c) => c.id === channelId);
  if (!channel) return { channel: null, category: null, allowed: false, reason: 'unknown' };
  const category = catalog.categories.find((c) => c.id === channel.category_id) || null;
  const deny = (reason) => ({ channel, category, allowed: false, reason });

  // The account channel is the one entry every customer keeps, expired or not.
  if (channel.id === INFO_CHANNEL_ID) return { channel, category, allowed: true, reason: 'info' };

  if (channel.missing) return deny('missing');
  if (!category) return deny('category');
  if (locked) return deny('locked');
  if (!categoryEnabledFor(category, (overrides.categories || {})[category.id], planCategories)) {
    return deny('category');
  }
  if (!effectiveEnabled(channel, (overrides.channels || {})[channel.id])) return deny('channel');
  if (!channel.url) return deny('no-url');
  return { channel, category, allowed: true, reason: 'ok' };
}

// Count of channels per category id (excludes rows gone from upstream).
export function channelCounts(catalog) {
  const counts = new Map();
  for (const ch of catalog.channels) {
    if (ch.missing) continue;
    const entry = counts.get(ch.category_id) || { total: 0, enabled: 0 };
    entry.total += 1;
    if (ch.enabled !== false) entry.enabled += 1;
    counts.set(ch.category_id, entry);
  }
  return counts;
}
