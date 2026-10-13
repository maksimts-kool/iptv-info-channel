//! Pure catalog logic: how an upstream playlist merges into the curated
//! catalog, and which channels a given customer may see. No I/O, no module
//! state — the JSON store and the HTTP fetching live in `playlist::catalog`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use super::m3u::{Attrs, Item, Parsed};
use crate::core::util::locale_cmp;

/// The built-in category carrying this server's own channels. The only
/// category an expired or disabled customer keeps, so it can never be deleted
/// and its per-user visibility is not overridable.
pub const INFO_CATEGORY_ID: &str = "info";
pub const INFO_CHANNEL_ID: &str = "info-account";
/// The second built-in row of Информация: the admin-curated media loop. Unlike
/// the account channel it CAN be switched off (globally or pinned per
/// customer).
pub const INFO_MEDIA_CHANNEL_ID: &str = "info-media";
pub const INFO_MEDIA_DEFAULT_NAME: &str = "Медиа";

/// Built-in rows sort ahead of imported ones so Информация is always first.
const INFO_SORT: i64 = -1;

const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Category {
    pub id: String,
    pub key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub custom: bool,
    #[serde(default)]
    pub sort: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Channel {
    pub id: String,
    pub key: String,
    #[serde(default)]
    pub source_id: Option<String>,
    pub category_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub original_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_group: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub attrs: Attrs,
    #[serde(default)]
    pub extras: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub custom: bool,
    #[serde(default)]
    pub missing: bool,
    #[serde(default)]
    pub sort: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "yes")]
    pub auto_refresh: bool,
    #[serde(default)]
    pub interval_hours: Option<f64>,
    #[serde(default)]
    pub epg_url: String,
    #[serde(default)]
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub last_sync_ms: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_count: usize,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// A sparse map of explicit per-customer decisions. Absent means "inherit".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserOverrides {
    #[serde(default)]
    pub categories: HashMap<String, bool>,
    #[serde(default)]
    pub channels: HashMap<String, bool>,
}

impl UserOverrides {
    pub fn is_empty(&self) -> bool {
        self.categories.is_empty() && self.channels.is_empty()
    }

    pub fn len(&self) -> usize {
        self.categories.len() + self.channels.len()
    }
}

/// The whole catalog (`catalog.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CatalogData {
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub categories: Vec<Category>,
    #[serde(default)]
    pub channels: Vec<Channel>,
    /// Keyed by the customer id as a string, as the Node store kept it.
    #[serde(default)]
    pub overrides: HashMap<String, UserOverrides>,
}

pub fn normalize_name(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Categories are shared across sources: two providers both publishing
/// "Спорт" land in one category.
pub fn category_key(name: &str) -> String {
    let n = normalize_name(name).to_lowercase();
    if n.is_empty() {
        "без категории".to_owned()
    } else {
        n
    }
}

/// Stable identity of an upstream channel across refreshes: `tvg-id` wins (it
/// survives URL/token rotation), the stream URL is the fallback. Scoped per
/// source so two providers carrying the same channel stay distinct.
pub fn channel_key(source_id: &str, item: &Item) -> String {
    let tvg_id = normalize_name(item.attrs.get("tvg-id").map_or("", String::as_str));
    if tvg_id.is_empty() {
        format!("{source_id}|url:{}", item.url)
    } else {
        format!("{source_id}|id:{tvg_id}")
    }
}

/// Attributes worth keeping from upstream. Everything else is re-derived from
/// the catalog on output, so keeping it would let a stale value override an
/// admin edit.
const KEPT_ATTRS: [&str; 9] = [
    "tvg-id",
    "tvg-name",
    "tvg-logo",
    "tvg-shift",
    "tvg-chno",
    "radio",
    "catchup",
    "catchup-source",
    "catchup-days",
];

pub fn pick_attrs(attrs: &Attrs) -> Attrs {
    KEPT_ATTRS
        .iter()
        .filter_map(|k| {
            attrs
                .get(*k)
                .filter(|v| !v.is_empty())
                .map(|v| ((*k).to_owned(), v.clone()))
        })
        .collect()
}

fn builtin_channel(id: &str, name: &str, sort: i64) -> Channel {
    Channel {
        id: id.to_owned(),
        key: id.to_owned(),
        source_id: None,
        category_id: INFO_CATEGORY_ID.to_owned(),
        name: name.to_owned(),
        original_name: String::new(),
        upstream_group: None,
        url: String::new(), // per-user; filled in by the playlist builder
        attrs: Attrs::new(),
        extras: Vec::new(),
        enabled: true,
        builtin: true,
        custom: false,
        missing: false,
        sort,
        added_at: None,
    }
}

/// Make sure the Информация category and its two channels exist. Idempotent:
/// an admin rename survives (only a missing row is created).
pub fn ensure_builtins(state: &mut CatalogData, info_category_name: &str) {
    if !state.categories.iter().any(|c| c.id == INFO_CATEGORY_ID) {
        state.categories.push(Category {
            id: INFO_CATEGORY_ID.to_owned(),
            key: category_key(info_category_name),
            name: info_category_name.to_owned(),
            source_name: None,
            enabled: true,
            builtin: true,
            custom: false,
            sort: INFO_SORT,
        });
    }
    if !state.channels.iter().any(|c| c.id == INFO_CHANNEL_ID) {
        // Empty name => the playlist builder uses "<brand> — <username>".
        state
            .channels
            .push(builtin_channel(INFO_CHANNEL_ID, "", INFO_SORT));
    }
    if !state.channels.iter().any(|c| c.id == INFO_MEDIA_CHANNEL_ID) {
        state.channels.push(builtin_channel(
            INFO_MEDIA_CHANNEL_ID,
            INFO_MEDIA_DEFAULT_NAME,
            INFO_SORT + 1,
        ));
    }
}

/// Intervals offered in the admin, in hours.
pub const REFRESH_INTERVALS: [f64; 9] = [1.0, 2.0, 3.0, 6.0, 12.0, 24.0, 48.0, 72.0, 168.0];

/// When this source next becomes due for an automatic re-download (epoch ms),
/// or `None` when it is never refreshed automatically. A never-fetched source
/// is due immediately. `last_sync_ms` is stamped on every ATTEMPT, so a broken
/// provider is retried on its interval rather than on every tick.
pub fn source_due_at(source: &Source, default_hours: f64) -> Option<i64> {
    if !source.enabled || !source.auto_refresh {
        return None;
    }
    let Some(last) = source.last_sync_ms.filter(|ms| *ms != 0) else {
        return Some(0);
    };
    let hours = source
        .interval_hours
        .filter(|h| *h > 0.0)
        .unwrap_or(default_hours);
    Some(last + (hours * 3_600_000.0) as i64)
}

pub fn source_is_due(source: &Source, now_ms: i64, default_hours: f64) -> bool {
    source_due_at(source, default_hours).is_some_and(|due| now_ms >= due)
}

fn upsert_category(
    state: &mut CatalogData,
    name: &str,
    make_id: &mut impl FnMut() -> String,
) -> String {
    let mut clean = normalize_name(name);
    if clean.is_empty() {
        "Без категории".clone_into(&mut clean);
    }
    let key = category_key(&clean);
    if let Some(c) = state.categories.iter().find(|c| c.key == key) {
        return c.id.clone();
    }
    let sort = state.categories.iter().map(|c| c.sort).fold(0, i64::max) + 1;
    let id = make_id();
    state.categories.push(Category {
        id: id.clone(),
        key,
        // Remembers what the provider called the group, so a renamed category
        // can still be traced back to it.
        source_name: Some(clean.clone()),
        name: clean,
        enabled: true,
        builtin: false,
        custom: false,
        sort,
    });
    id
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MergeStats {
    pub added: usize,
    pub updated: usize,
    pub missing: usize,
    pub restored: usize,
}

/// Fold a parsed upstream playlist into `state`.
///
/// Admin edits always win over upstream: a renamed channel keeps its name, a
/// moved channel stays moved, a disabled one stays disabled. Only the stream
/// URL and passthrough attributes/directives are refreshed. Channels that
/// vanished upstream are marked `missing`, never deleted, so a truncated
/// download can't destroy the admin's overrides.
pub fn merge_source_channels(
    state: &mut CatalogData,
    source_id: &str,
    parsed: &Parsed,
    make_id: &mut impl FnMut() -> String,
    now: Timestamp,
) -> MergeStats {
    let stamp = now.strftime("%Y-%m-%d %H:%M:%S").to_string();
    let by_key: HashMap<String, usize> = state
        .channels
        .iter()
        .enumerate()
        .filter(|(_, c)| c.source_id.as_deref() == Some(source_id))
        .map(|(i, c)| (c.key.clone(), i))
        .collect();
    let mut keys_seen = HashSet::new();
    let mut totals = MergeStats::default();

    for (index, item) in parsed.items.iter().enumerate() {
        let key = channel_key(source_id, item);
        if !keys_seen.insert(key.clone()) {
            continue; // duplicate line in the upstream file
        }
        let mut name = normalize_name(&item.name);
        if name.is_empty() {
            name = normalize_name(item.attrs.get("tvg-name").map_or("", String::as_str));
        }
        if name.is_empty() {
            name.clone_from(&item.url);
        }

        if let Some(&i) = by_key.get(&key) {
            let existing = &mut state.channels[i];
            if existing.missing {
                existing.missing = false;
                totals.restored += 1;
            }
            existing.url.clone_from(&item.url);
            existing.attrs = pick_attrs(&item.attrs);
            existing.extras.clone_from(&item.extras);
            existing.original_name = name;
            existing.upstream_group = Some(normalize_name(&item.group));
            existing.sort = index as i64;
            totals.updated += 1;
            continue;
        }

        let category_id = upsert_category(state, &item.group, make_id);
        state.channels.push(Channel {
            id: make_id(),
            key,
            source_id: Some(source_id.to_owned()),
            category_id,
            name: name.clone(), // admin-editable; starts as the upstream name
            original_name: name,
            upstream_group: Some(normalize_name(&item.group)),
            url: item.url.clone(),
            attrs: pick_attrs(&item.attrs),
            extras: item.extras.clone(),
            enabled: true,
            builtin: false,
            custom: false,
            missing: false,
            sort: index as i64,
            added_at: Some(stamp.clone()),
        });
        totals.added += 1;
    }

    for (key, &i) in &by_key {
        let channel = &mut state.channels[i];
        if keys_seen.contains(key) || channel.missing {
            continue;
        }
        channel.missing = true;
        totals.missing += 1;
    }
    totals
}

/// Effective visibility of one row for one customer. A per-user override is
/// AUTHORITATIVE: `false` hides a globally enabled row, `true` grants a
/// globally disabled one.
pub fn effective_enabled(enabled: bool, pin: Option<bool>) -> bool {
    pin.unwrap_or(enabled)
}

/// Effective visibility of a CATEGORY. Precedence, highest first: a personal
/// pin, the global enable, the plan. `plan` = `None` resolves without a plan
/// restriction (admin previews).
pub fn category_enabled_for(
    category: &Category,
    pin: Option<bool>,
    plan: Option<&HashSet<String>>,
) -> bool {
    if let Some(p) = pin {
        return p;
    }
    if !category.enabled {
        return false;
    }
    plan.is_none_or(|set| set.contains(&category.id))
}

fn by_order(sort_a: i64, name_a: &str, sort_b: i64, name_b: &str) -> Ordering {
    sort_a.cmp(&sort_b).then_with(|| locale_cmp(name_a, name_b))
}

/// Inputs shared by [`resolve_user_channels`] and [`resolve_channel_access`].
#[derive(Debug, Clone, Copy, Default)]
pub struct Resolve<'a> {
    pub overrides: Option<&'a UserOverrides>,
    pub locked: bool,
    pub plan: Option<&'a HashSet<String>>,
}

impl Resolve<'_> {
    fn category_pin(&self, id: &str) -> Option<bool> {
        self.overrides.and_then(|o| o.categories.get(id).copied())
    }
    fn channel_pin(&self, id: &str) -> Option<bool> {
        self.overrides.and_then(|o| o.channels.get(id).copied())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Entry<'a> {
    pub channel: &'a Channel,
    pub category: &'a Category,
}

/// The ordered channel list one customer may see. The plan decides the
/// categories, personal overrides add/remove exceptions, and `locked` (expired
/// or deactivated) overrules both, leaving ONLY Информация. Nothing is written
/// when an account lapses, so a renewal restores the list immediately.
pub fn resolve_user_channels<'a>(catalog: &'a CatalogData, opts: Resolve<'_>) -> Vec<Entry<'a>> {
    let visible: HashMap<&str, &Category> = catalog
        .categories
        .iter()
        .filter(|c| {
            c.id == INFO_CATEGORY_ID
                || (!opts.locked && category_enabled_for(c, opts.category_pin(&c.id), opts.plan))
        })
        .map(|c| (c.id.as_str(), c))
        .collect();

    let mut entries: Vec<Entry<'a>> = catalog
        .channels
        .iter()
        .filter(|ch| !ch.missing)
        .filter_map(|ch| {
            let category = *visible.get(ch.category_id.as_str())?;
            let allowed =
                ch.id == INFO_CHANNEL_ID || effective_enabled(ch.enabled, opts.channel_pin(&ch.id));
            allowed.then_some(Entry {
                channel: ch,
                category,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        by_order(
            a.category.sort,
            &a.category.name,
            b.category.sort,
            &b.category.name,
        )
        .then_with(|| {
            by_order(
                a.channel.sort,
                &a.channel.name,
                b.channel.sort,
                &b.channel.name,
            )
        })
    });
    entries
}

/// Which layer refused a channel, for the admin log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccessReason {
    Ok,
    Info,
    Unknown,
    Missing,
    Locked,
    Category,
    Channel,
    NoUrl,
}

impl AccessReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Info => "info",
            Self::Unknown => "unknown",
            Self::Missing => "missing",
            Self::Locked => "locked",
            Self::Category => "category",
            Self::Channel => "channel",
            Self::NoUrl => "no-url",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Access<'a> {
    pub channel: Option<&'a Channel>,
    pub category: Option<&'a Category>,
    pub allowed: bool,
    pub reason: AccessReason,
}

/// Whether ONE channel is playable for ONE customer right now — the same
/// decision [`resolve_user_channels`] makes for the whole list. The stream
/// gateway asks this on every manifest fetch, so it must agree with the
/// `.m3u` exactly.
pub fn resolve_channel_access<'a>(
    catalog: &'a CatalogData,
    channel_id: &str,
    opts: Resolve<'_>,
) -> Access<'a> {
    let Some(channel) = catalog.channels.iter().find(|c| c.id == channel_id) else {
        return Access {
            channel: None,
            category: None,
            allowed: false,
            reason: AccessReason::Unknown,
        };
    };
    let category = catalog
        .categories
        .iter()
        .find(|c| c.id == channel.category_id);
    let verdict = |allowed, reason| Access {
        channel: Some(channel),
        category,
        allowed,
        reason,
    };

    // The account channel is the one entry every customer keeps.
    if channel.id == INFO_CHANNEL_ID {
        return verdict(true, AccessReason::Info);
    }
    // The media channel lives in Информация, which a locked account keeps, so
    // only its own switch (global or pinned) decides.
    if channel.id == INFO_MEDIA_CHANNEL_ID {
        return if effective_enabled(channel.enabled, opts.channel_pin(&channel.id)) {
            verdict(true, AccessReason::Info)
        } else {
            verdict(false, AccessReason::Channel)
        };
    }
    if channel.missing {
        return verdict(false, AccessReason::Missing);
    }
    let Some(cat) = category else {
        return verdict(false, AccessReason::Category);
    };
    if opts.locked {
        return verdict(false, AccessReason::Locked);
    }
    if !category_enabled_for(cat, opts.category_pin(&cat.id), opts.plan) {
        return verdict(false, AccessReason::Category);
    }
    if !effective_enabled(channel.enabled, opts.channel_pin(&channel.id)) {
        return verdict(false, AccessReason::Channel);
    }
    if channel.url.is_empty() {
        return verdict(false, AccessReason::NoUrl);
    }
    verdict(true, AccessReason::Ok)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub total: usize,
    pub enabled: usize,
}

/// Channel count per category id (excludes rows gone from upstream).
pub fn channel_counts(catalog: &CatalogData) -> HashMap<String, Counts> {
    let mut counts: HashMap<String, Counts> = HashMap::new();
    for ch in catalog.channels.iter().filter(|c| !c.missing) {
        let e = counts.entry(ch.category_id.clone()).or_default();
        e.total += 1;
        if ch.enabled {
            e.enabled += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playlist::m3u::parse_m3u;

    const PLAYLIST: &str = "#EXTM3U url-tvg=\"http://p/epg.xml\"\n\
        #EXTINF:-1 tvg-id=\"s1\" group-title=\"Спорт\",Sport 1\nhttp://p/1.ts\n\
        #EXTINF:-1 tvg-id=\"s2\" group-title=\"Спорт\",Sport 2\nhttp://p/2.ts\n\
        #EXTINF:-1 tvg-id=\"n1\" group-title=\"Новости\",News 1\nhttp://p/3.ts";

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("id{n}")
        }
    }

    fn empty() -> CatalogData {
        let mut s = CatalogData::default();
        ensure_builtins(&mut s, "Информация");
        s
    }

    fn merge(
        state: &mut CatalogData,
        src: &str,
        text: &str,
        mk: &mut impl FnMut() -> String,
    ) -> MergeStats {
        merge_source_channels(state, src, &parse_m3u(text), mk, Timestamp::now())
    }

    fn seeded() -> (CatalogData, MergeStats, impl FnMut() -> String) {
        let mut catalog = empty();
        let mut mk = ids();
        let merged = merge(&mut catalog, "src1", PLAYLIST, &mut mk);
        (catalog, merged, mk)
    }

    fn cat_id(s: &CatalogData, name: &str) -> String {
        s.categories
            .iter()
            .find(|c| c.name == name)
            .unwrap()
            .id
            .clone()
    }

    fn ch_mut<'a>(s: &'a mut CatalogData, name: &str) -> &'a mut Channel {
        s.channels.iter_mut().find(|c| c.name == name).unwrap()
    }

    fn names(s: &CatalogData, opts: Resolve<'_>) -> Vec<String> {
        resolve_user_channels(s, opts)
            .iter()
            .map(|e| e.channel.name.clone())
            .collect()
    }

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_owned()).collect()
    }

    fn src(enabled: bool, auto: bool, hours: Option<f64>, last: Option<i64>) -> Source {
        Source {
            id: "s".into(),
            name: "s".into(),
            url: "http://x".into(),
            enabled,
            auto_refresh: auto,
            interval_hours: hours,
            epg_url: String::new(),
            last_sync_at: None,
            last_sync_ms: last,
            last_error: None,
            last_count: 0,
            created_at: None,
        }
    }

    #[test]
    fn never_synced_source_is_due_now() {
        let s = src(true, true, Some(24.0), None);
        assert_eq!(source_due_at(&s, 24.0), Some(0));
        assert!(source_is_due(&s, crate::core::util::now_ms(), 24.0));
    }

    #[test]
    fn source_due_one_interval_after_attempt() {
        let hour = 3_600_000;
        let s = src(true, true, Some(6.0), Some(1_000_000));
        assert_eq!(source_due_at(&s, 24.0), Some(1_000_000 + 6 * hour));
        assert!(!source_is_due(&s, 1_000_000 + 5 * hour, 24.0));
        assert!(source_is_due(&s, 1_000_000 + 6 * hour, 24.0));
        let d = src(true, true, None, Some(1_000_000));
        assert_eq!(source_due_at(&d, 12.0), Some(1_000_000 + 12 * hour));
    }

    #[test]
    fn disabled_or_opted_out_never_scheduled() {
        assert_eq!(
            source_due_at(&src(false, true, Some(1.0), Some(1)), 24.0),
            None
        );
        assert_eq!(
            source_due_at(&src(true, false, Some(1.0), Some(1)), 24.0),
            None
        );
    }

    #[test]
    fn builtins_created_once() {
        let mut s = empty();
        ensure_builtins(&mut s, "Информация");
        assert_eq!(
            s.categories
                .iter()
                .filter(|c| c.id == INFO_CATEGORY_ID)
                .count(),
            1
        );
        assert_eq!(
            s.channels
                .iter()
                .filter(|c| c.id == INFO_CHANNEL_ID)
                .count(),
            1
        );
        assert_eq!(
            s.channels
                .iter()
                .filter(|c| c.id == INFO_MEDIA_CHANNEL_ID)
                .count(),
            1
        );
        assert!(s.categories[0].builtin);
        let r: Vec<_> = resolve_user_channels(&s, Resolve::default())
            .iter()
            .map(|e| e.channel.id.clone())
            .collect();
        assert_eq!(r, [INFO_CHANNEL_ID, INFO_MEDIA_CHANNEL_ID]);
    }

    #[test]
    fn merge_creates_categories_and_channels() {
        let (s, stats, _) = seeded();
        assert_eq!(
            stats,
            MergeStats {
                added: 3,
                updated: 0,
                missing: 0,
                restored: 0
            }
        );
        let cats: Vec<_> = s.categories.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(cats, ["Информация", "Спорт", "Новости"]);
    }

    #[test]
    fn shared_group_names_share_category() {
        let (mut s, _, mut mk) = seeded();
        merge(
            &mut s,
            "src2",
            "#EXTM3U\n#EXTINF:-1 tvg-id=\"s9\" group-title=\"спорт\",Sport 9\nhttp://q/9.ts",
            &mut mk,
        );
        assert_eq!(
            s.categories
                .iter()
                .filter(|c| category_key(&c.name) == "спорт")
                .count(),
            1
        );
    }

    #[test]
    fn refresh_keeps_admin_edits() {
        let (mut s, _, mut mk) = seeded();
        let news = cat_id(&s, "Новости");
        {
            let c = ch_mut(&mut s, "Sport 1");
            c.name = "Спорт Первый".into();
            c.enabled = false;
            c.category_id.clone_from(&news);
        }
        let stats = merge(
            &mut s,
            "src1",
            "#EXTM3U\n#EXTINF:-1 tvg-id=\"s1\" group-title=\"Спорт\",SPORT ONE RENAMED UPSTREAM\nhttp://p/rotated-token/1.ts\n\
             #EXTINF:-1 tvg-id=\"s2\" group-title=\"Спорт\",Sport 2\nhttp://p/2.ts\n\
             #EXTINF:-1 tvg-id=\"n1\" group-title=\"Новости\",News 1\nhttp://p/3.ts",
            &mut mk,
        );
        assert_eq!((stats.added, stats.updated), (0, 3));
        let after = s
            .channels
            .iter()
            .find(|c| c.attrs.get("tvg-id").map(String::as_str) == Some("s1"))
            .unwrap();
        assert_eq!(after.name, "Спорт Первый");
        assert!(!after.enabled);
        assert_eq!(after.category_id, news);
        assert_eq!(after.url, "http://p/rotated-token/1.ts");
        assert_eq!(after.original_name, "SPORT ONE RENAMED UPSTREAM");
    }

    #[test]
    fn vanished_channels_flagged_then_restored() {
        let (mut s, _, mut mk) = seeded();
        let gone = merge(
            &mut s,
            "src1",
            "#EXTM3U\n#EXTINF:-1 tvg-id=\"s1\" group-title=\"Спорт\",Sport 1\nhttp://p/1.ts",
            &mut mk,
        );
        assert_eq!(gone.missing, 2);
        assert_eq!(
            s.channels
                .iter()
                .filter(|c| c.source_id.as_deref() == Some("src1"))
                .count(),
            3
        );
        let back = merge(&mut s, "src1", PLAYLIST, &mut mk);
        assert_eq!(back.restored, 2);
    }

    #[test]
    fn channel_key_prefers_tvg_id() {
        let mut attrs = Attrs::new();
        attrs.insert("tvg-id".into(), "x".into());
        let a = Item {
            attrs: attrs.clone(),
            url: "http://a/1.ts".into(),
            ..Item::default()
        };
        let b = Item {
            attrs,
            url: "http://a/TOKEN2/1.ts".into(),
            ..Item::default()
        };
        assert_eq!(channel_key("s", &a), channel_key("s", &b));
        let c = Item {
            url: "http://a/1.ts".into(),
            ..Item::default()
        };
        assert_eq!(channel_key("s", &c), "s|url:http://a/1.ts");
        assert_ne!(channel_key("s1", &a), channel_key("s2", &a));
    }

    #[test]
    fn category_layers() {
        let cat = Category {
            id: "c1".into(),
            key: "c1".into(),
            name: "c".into(),
            source_name: None,
            enabled: true,
            builtin: false,
            custom: false,
            sort: 0,
        };
        let in_plan = set(&["c1"]);
        let not_in = set(&["other"]);
        assert!(category_enabled_for(&cat, None, Some(&in_plan)));
        assert!(!category_enabled_for(&cat, None, Some(&not_in)));
        assert!(category_enabled_for(&cat, Some(true), Some(&not_in)));
        assert!(!category_enabled_for(&cat, Some(false), Some(&in_plan)));
        let off = Category {
            enabled: false,
            ..cat.clone()
        };
        assert!(!category_enabled_for(&off, None, Some(&in_plan)));
        assert!(category_enabled_for(&off, Some(true), Some(&in_plan)));
        assert!(category_enabled_for(&cat, None, None));
        assert!(!effective_enabled(true, Some(false)));
        assert!(effective_enabled(false, Some(true)));
    }

    #[test]
    fn resolution_follows_plan_pins_and_lock() {
        let (mut s, _, _) = seeded();
        let sport = cat_id(&s, "Спорт");
        let news = cat_id(&s, "Новости");
        assert_eq!(
            names(&s, Resolve::default()),
            ["", "Медиа", "Sport 1", "Sport 2", "News 1"]
        );
        let sp = set(&[&sport]);
        assert_eq!(
            names(
                &s,
                Resolve {
                    plan: Some(&sp),
                    ..Default::default()
                }
            ),
            ["", "Медиа", "Sport 1", "Sport 2"]
        );
        let none = set(&[]);
        assert_eq!(
            names(
                &s,
                Resolve {
                    plan: Some(&none),
                    ..Default::default()
                }
            ),
            ["", "Медиа"]
        );

        let mut bonus = UserOverrides::default();
        bonus.categories.insert(news.clone(), true);
        assert_eq!(
            names(
                &s,
                Resolve {
                    plan: Some(&sp),
                    overrides: Some(&bonus),
                    ..Default::default()
                }
            ),
            ["", "Медиа", "Sport 1", "Sport 2", "News 1"]
        );
        let mut trim = UserOverrides::default();
        trim.categories.insert(sport.clone(), false);
        assert_eq!(
            names(
                &s,
                Resolve {
                    plan: Some(&sp),
                    overrides: Some(&trim),
                    ..Default::default()
                }
            ),
            ["", "Медиа"]
        );

        let all: HashSet<String> = s.categories.iter().map(|c| c.id.clone()).collect();
        let locked = resolve_user_channels(
            &s,
            Resolve {
                locked: true,
                plan: Some(&all),
                overrides: Some(&bonus),
            },
        );
        let ids: Vec<_> = locked.iter().map(|e| e.channel.id.as_str()).collect();
        assert_eq!(ids, [INFO_CHANNEL_ID, INFO_MEDIA_CHANNEL_ID]);
        assert_eq!(locked[0].category.id, INFO_CATEGORY_ID);

        let mut pin = UserOverrides::default();
        let sport2 = ch_mut(&mut s, "Sport 2").id.clone();
        pin.channels.insert(sport2, false);
        assert_eq!(
            names(
                &s,
                Resolve {
                    overrides: Some(&pin),
                    ..Default::default()
                }
            ),
            ["", "Медиа", "Sport 1", "News 1"]
        );

        ch_mut(&mut s, "Sport 1").missing = true;
        assert_eq!(
            names(&s, Resolve::default()),
            ["", "Медиа", "Sport 2", "News 1"]
        );
    }

    #[test]
    fn channel_counts_ignore_missing() {
        let (mut s, _, _) = seeded();
        let sport = cat_id(&s, "Спорт");
        let news = cat_id(&s, "Новости");
        ch_mut(&mut s, "Sport 2").enabled = false;
        ch_mut(&mut s, "News 1").missing = true;
        let counts = channel_counts(&s);
        assert_eq!(
            counts[&sport],
            Counts {
                total: 2,
                enabled: 1
            }
        );
        assert!(!counts.contains_key(&news));
    }

    #[test]
    fn duplicates_imported_once() {
        let mut s = empty();
        let stats = merge(
            &mut s,
            "src1",
            "#EXTM3U\n#EXTINF:-1 tvg-id=\"d1\" group-title=\"A\",Dup\nhttp://p/d.ts\n#EXTINF:-1 tvg-id=\"d1\" group-title=\"A\",Dup again\nhttp://p/d.ts",
            &mut ids(),
        );
        assert_eq!(stats.added, 1);
    }

    #[test]
    fn access_agrees_with_playlist_row_by_row() {
        let (s, _, _) = seeded();
        let sport = cat_id(&s, "Спорт");
        let news = cat_id(&s, "Новости");
        let plan = set(&[&sport]);
        let opts = Resolve {
            plan: Some(&plan),
            ..Default::default()
        };
        let allowed: HashSet<_> = resolve_user_channels(&s, opts)
            .iter()
            .map(|e| e.channel.id.clone())
            .collect();
        for ch in &s.channels {
            assert_eq!(
                resolve_channel_access(&s, &ch.id, opts).allowed,
                allowed.contains(&ch.id),
                "{}",
                ch.name
            );
        }
        let n = s.channels.iter().find(|c| c.category_id == news).unwrap();
        assert_eq!(
            resolve_channel_access(&s, &n.id, opts).reason,
            AccessReason::Category
        );
    }

    #[test]
    fn gateway_refusal_reasons() {
        let (mut s, _, _) = seeded();
        let sport = cat_id(&s, "Спорт");
        let s1 = ch_mut(&mut s, "Sport 1").id.clone();
        let plan = set(&[&sport]);
        let base = Resolve {
            plan: Some(&plan),
            ..Default::default()
        };
        assert!(resolve_channel_access(&s, &s1, base).allowed);
        assert_eq!(
            resolve_channel_access(
                &s,
                &s1,
                Resolve {
                    locked: true,
                    ..base
                }
            )
            .reason,
            AccessReason::Locked
        );
        let mut ch_off = UserOverrides::default();
        ch_off.channels.insert(s1.clone(), false);
        assert_eq!(
            resolve_channel_access(
                &s,
                &s1,
                Resolve {
                    overrides: Some(&ch_off),
                    ..base
                }
            )
            .reason,
            AccessReason::Channel
        );
        let mut cat_off = UserOverrides::default();
        cat_off.categories.insert(sport.clone(), false);
        assert_eq!(
            resolve_channel_access(
                &s,
                &s1,
                Resolve {
                    overrides: Some(&cat_off),
                    ..base
                }
            )
            .reason,
            AccessReason::Category
        );
        assert_eq!(
            resolve_channel_access(&s, "nope", base).reason,
            AccessReason::Unknown
        );

        ch_mut(&mut s, "Sport 1").enabled = false;
        assert_eq!(
            resolve_channel_access(&s, &s1, base).reason,
            AccessReason::Channel
        );
        let mut ch_on = UserOverrides::default();
        ch_on.channels.insert(s1.clone(), true);
        assert!(
            resolve_channel_access(
                &s,
                &s1,
                Resolve {
                    overrides: Some(&ch_on),
                    ..base
                }
            )
            .allowed
        );
        let c = ch_mut(&mut s, "Sport 1");
        c.enabled = true;
        c.missing = true;
        assert_eq!(
            resolve_channel_access(&s, &s1, base).reason,
            AccessReason::Missing
        );

        let none = set(&[]);
        let info = resolve_channel_access(
            &s,
            INFO_CHANNEL_ID,
            Resolve {
                locked: true,
                plan: Some(&none),
                overrides: None,
            },
        );
        assert!(info.allowed);
        assert_eq!(info.category.unwrap().id, INFO_CATEGORY_ID);
    }
}
