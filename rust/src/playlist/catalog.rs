//! The curated channel catalog store (`DATA_DIR/catalog.json`): upstream
//! sources, the categories and channels imported from them, and each
//! customer's personal visibility overrides.
//!
//! Kept apart from `db.json` on purpose: a provider playlist can carry tens of
//! thousands of channels and both stores rewrite the whole file on every
//! save, so one customer's expiry edit must not rewrite megabytes of rows.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{PoisonError, RwLock, RwLockReadGuard};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde::Serialize;

use super::m3u::{Attrs, parse_m3u};
use super::model::{
    CatalogData, Category, Channel, Counts, INFO_MEDIA_CHANNEL_ID, MergeStats, Source, UserOverrides, channel_counts,
    ensure_builtins, merge_source_channels, normalize_name, source_due_at, source_is_due,
};
use crate::core::fetch::fetch_bounded;
use crate::core::util::{locale_cmp, make_token, now_ms, now_stamp, parse_instant};
use crate::data::jsonfile::{self, Loaded};

/// How the catalog fetches and names things (from `config.catalog`).
#[derive(Debug, Clone)]
pub struct CatalogSettings {
    pub info_category_name: String,
    pub default_interval_hours: f64,
    pub fetch_timeout: Duration,
    pub max_bytes: usize,
}

#[derive(Debug)]
pub struct Catalog {
    path: PathBuf,
    data: RwLock<CatalogData>,
    settings: CatalogSettings,
    client: reqwest::Client,
}

/// Result of one source refresh.
#[derive(Debug, Clone, Serialize)]
pub struct RefreshOutcome {
    pub id: String,
    pub ok: bool,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub stats: Option<MergeStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub malformed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SourcePatch {
    pub name: Option<String>,
    pub url: Option<String>,
    pub enabled: Option<bool>,
    pub auto_refresh: Option<bool>,
    pub interval_hours: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct CategoryPatch {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub sort: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct ChannelPatch {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub category_id: Option<String>,
    pub url: Option<String>,
}

/// Server-side channel listing filter.
#[derive(Debug, Clone, Default)]
pub struct ChannelQuery {
    pub q: String,
    pub category_id: String,
    pub source_id: String,
    pub status: String,
    pub page: usize,
    pub page_size: usize,
}

/// A personal override patch: `Some(b)` pins, `None` falls back to global.
#[derive(Debug, Clone, Default)]
pub struct OverridePatch {
    pub categories: Vec<(String, Option<bool>)>,
    pub channels: Vec<(String, Option<bool>)>,
}

impl Catalog {
    pub fn open(data_dir: &Path, settings: CatalogSettings, client: reqwest::Client) -> anyhow::Result<Self> {
        let path = data_dir.join("catalog.json");
        let mut data = match jsonfile::load::<CatalogData>(&path)? {
            Loaded::Existing(d) => d,
            Loaded::Missing => CatalogData::default(),
            Loaded::Corrupt { backup, error } => {
                tracing::error!(target: "catalog", backup = %backup.display(), %error, "catalog.json was corrupt; starting with an empty catalog");
                CatalogData::default()
            }
        };
        // Backfill auto-refresh fields on sources that predate the scheduler.
        for source in &mut data.sources {
            if source.interval_hours.is_none() {
                source.interval_hours = Some(settings.default_interval_hours);
            }
            if source.last_sync_ms.is_none() {
                source.last_sync_ms = source.last_sync_at.as_deref().and_then(parse_instant).map(jiff::Timestamp::as_millisecond);
            }
        }
        ensure_builtins(&mut data, &settings.info_category_name);
        let catalog = Self { path, data: RwLock::new(data), settings, client };
        catalog.persist(&catalog.read())?;
        Ok(catalog)
    }

    fn persist(&self, data: &CatalogData) -> anyhow::Result<()> {
        jsonfile::save(&self.path, data, false)
    }

    /// A read snapshot for the pure helpers in `model`.
    pub fn read(&self) -> RwLockReadGuard<'_, CatalogData> {
        self.data.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write<R>(&self, f: impl FnOnce(&mut CatalogData) -> R) -> anyhow::Result<R> {
        let mut data = self.data.write().unwrap_or_else(PoisonError::into_inner);
        let result = f(&mut data);
        self.persist(&data)?;
        Ok(result)
    }

    pub fn default_interval_hours(&self) -> f64 {
        self.settings.default_interval_hours
    }

    // ---- Plans <-> categories ----

    /// The category names a plan grants, in display order.
    pub fn plan_category_names(&self, granted: &[String]) -> Vec<String> {
        let set: HashSet<&str> = granted.iter().map(String::as_str).collect();
        let data = self.read();
        let mut cats: Vec<&Category> = data.categories.iter().filter(|c| set.contains(c.id.as_str()) && !c.builtin).collect();
        cats.sort_by(|a, b| a.sort.cmp(&b.sort).then_with(|| locale_cmp(&a.name, &b.name)));
        cats.into_iter().map(|c| c.name.clone()).collect()
    }

    // ---- Sources ----

    pub fn sources(&self) -> Vec<Source> {
        self.read().sources.clone()
    }

    pub fn source(&self, id: &str) -> Option<Source> {
        self.read().sources.iter().find(|s| s.id == id).cloned()
    }

    pub fn source_due_at(&self, source: &Source) -> Option<i64> {
        source_due_at(source, self.settings.default_interval_hours)
    }

    pub fn create_source(
        &self,
        name: &str,
        url: &str,
        enabled: bool,
        auto_refresh: bool,
        interval_hours: Option<f64>,
    ) -> anyhow::Result<Source> {
        let mut name = normalize_name(name);
        if name.is_empty() {
            "Источник".clone_into(&mut name);
        }
        let source = Source {
            id: make_token(12),
            name,
            url: url.trim().to_owned(),
            enabled,
            auto_refresh,
            interval_hours: Some(interval_hours.filter(|h| *h > 0.0).unwrap_or(self.settings.default_interval_hours)),
            epg_url: String::new(),
            last_sync_at: None,
            last_sync_ms: None,
            last_error: None,
            last_count: 0,
            created_at: Some(now_stamp()),
        };
        self.write(|d| d.sources.push(source.clone()))?;
        Ok(source)
    }

    pub fn update_source(&self, id: &str, patch: SourcePatch) -> anyhow::Result<Option<Source>> {
        self.write(|d| {
            let s = d.sources.iter_mut().find(|s| s.id == id)?;
            if let Some(name) = patch.name.map(|n| normalize_name(&n)).filter(|n| !n.is_empty()) {
                s.name = name;
            }
            if let Some(url) = patch.url {
                s.url = url.trim().to_owned();
            }
            if let Some(v) = patch.enabled {
                s.enabled = v;
            }
            if let Some(v) = patch.auto_refresh {
                s.auto_refresh = v;
            }
            if let Some(h) = patch.interval_hours.filter(|h| *h > 0.0) {
                s.interval_hours = Some(h);
            }
            Some(s.clone())
        })
    }

    /// Removing a source drops the channels it imported, and any non-builtin
    /// category left empty (categories are shared between sources).
    pub fn remove_source(&self, id: &str) -> anyhow::Result<bool> {
        self.write(|d| {
            let before = d.sources.len();
            d.sources.retain(|s| s.id != id);
            if d.sources.len() == before {
                return false;
            }
            d.channels.retain(|c| c.source_id.as_deref() != Some(id));
            let used: HashSet<String> = d.channels.iter().map(|c| c.category_id.clone()).collect();
            d.categories.retain(|c| c.builtin || used.contains(&c.id));
            true
        })
    }

    /// Fetch one source and merge it. A failure is recorded on the source row
    /// (shown in the admin) and returned. The download happens outside the
    /// lock; only the merge holds it.
    pub async fn refresh_source(&self, id: &str) -> anyhow::Result<RefreshOutcome> {
        let url = self.source(id).ok_or_else(|| anyhow::anyhow!("source not found"))?.url;
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("VLC/3.0.20 LibVLC/3.0.20"));
        let fetched = fetch_bounded(&self.client, &url, headers, self.settings.fetch_timeout, self.settings.max_bytes).await;
        let parsed = fetched
            .map_err(|e| e.to_string())
            .map(|f| parse_m3u(&f.text()))
            .and_then(|p| if p.items.is_empty() { Err("no channels found in the playlist".to_owned()) } else { Ok(p) });

        let result = self.write(|d| {
            let mut make_id = || make_token(12);
            let stats = parsed.as_ref().ok().map(|p| merge_source_channels(d, id, p, &mut make_id, jiff::Timestamp::now()));
            let Some(source) = d.sources.iter_mut().find(|s| s.id == id) else {
                return Err("source not found".to_owned());
            };
            // Stamp the attempt either way, so a broken provider is retried on
            // its interval rather than on every scheduler tick.
            source.last_sync_at = Some(now_stamp());
            source.last_sync_ms = Some(now_ms());
            match (&parsed, stats) {
                (Ok(p), Some(stats)) => {
                    source.epg_url = p
                        .header_attrs
                        .get("url-tvg")
                        .or_else(|| p.header_attrs.get("x-tvg-url"))
                        .cloned()
                        .unwrap_or_default();
                    source.last_error = None;
                    source.last_count = p.items.len();
                    Ok((stats, p.malformed, p.items.len(), source.name.clone()))
                }
                (Err(e), _) => {
                    source.last_error = Some(e.clone());
                    Err(e.clone())
                }
                (Ok(_), None) => Err("merge failed".to_owned()),
            }
        })?;
        match result {
            Ok((stats, malformed, total, name)) => {
                tracing::info!(target: "catalog", source_id = id, %name, added = stats.added, updated = stats.updated, missing = stats.missing, restored = stats.restored, malformed, "source refreshed");
                Ok(RefreshOutcome { id: id.to_owned(), ok: true, stats: Some(stats), malformed: Some(malformed), total: Some(total), error: None })
            }
            Err(error) => {
                tracing::error!(target: "catalog", source_id = id, %error, "source refresh failed");
                Err(anyhow::anyhow!(error))
            }
        }
    }

    /// Refresh sources one after another; one dead provider must not stop the rest.
    async fn refresh_each(&self, ids: Vec<String>) -> Vec<RefreshOutcome> {
        let mut out = Vec::new();
        for id in ids {
            out.push(self.refresh_source(&id).await.unwrap_or_else(|e| RefreshOutcome {
                id,
                ok: false,
                stats: None,
                malformed: None,
                total: None,
                error: Some(e.to_string()),
            }));
        }
        out
    }

    /// Every enabled source now, regardless of interval (the admin button).
    pub async fn refresh_all(&self) -> Vec<RefreshOutcome> {
        let ids = self.read().sources.iter().filter(|s| s.enabled).map(|s| s.id.clone()).collect();
        self.refresh_each(ids).await
    }

    /// Only the sources whose own interval has elapsed (the scheduler).
    pub async fn refresh_due(&self) -> Vec<RefreshOutcome> {
        let now = now_ms();
        let hours = self.settings.default_interval_hours;
        let ids: Vec<String> =
            self.read().sources.iter().filter(|s| source_is_due(s, now, hours)).map(|s| s.id.clone()).collect();
        if ids.is_empty() {
            return Vec::new();
        }
        let results = self.refresh_each(ids).await;
        tracing::info!(target: "catalog", sources = results.len(), failed = results.iter().filter(|r| !r.ok).count(), "scheduled source refresh finished");
        results
    }

    // ---- Categories ----

    pub fn categories(&self) -> Vec<Category> {
        self.read().categories.clone()
    }

    pub fn category(&self, id: &str) -> Option<Category> {
        self.read().categories.iter().find(|c| c.id == id).cloned()
    }

    pub fn category_counts(&self) -> HashMap<String, Counts> {
        channel_counts(&self.read())
    }

    pub fn create_category(&self, name: &str, enabled: bool) -> anyhow::Result<Category> {
        self.write(|d| {
            let mut name = normalize_name(name);
            if name.is_empty() {
                "Новая категория".clone_into(&mut name);
            }
            let c = Category {
                id: make_token(12),
                key: format!("custom:{}", make_token(12)),
                name,
                source_name: Some(String::new()),
                enabled,
                builtin: false,
                custom: true,
                sort: d.categories.iter().map(|c| c.sort).fold(0, i64::max) + 1,
            };
            d.categories.push(c.clone());
            c
        })
    }

    /// The built-in Информация stays on and in place — it is what an expired
    /// customer keeps.
    pub fn update_category(&self, id: &str, patch: CategoryPatch) -> anyhow::Result<Option<Category>> {
        self.write(|d| {
            let c = d.categories.iter_mut().find(|c| c.id == id)?;
            if let Some(name) = patch.name.map(|n| normalize_name(&n)).filter(|n| !n.is_empty()) {
                c.name = name;
            }
            if !c.builtin {
                if let Some(v) = patch.enabled {
                    c.enabled = v;
                }
                if let Some(v) = patch.sort {
                    c.sort = v;
                }
            }
            Some(c.clone())
        })
    }

    pub fn reorder_categories(&self, ids: &[String]) -> anyhow::Result<Vec<Category>> {
        self.write(|d| {
            for (index, id) in ids.iter().enumerate() {
                if let Some(c) = d.categories.iter_mut().find(|c| &c.id == id && !c.builtin) {
                    c.sort = index as i64 + 1;
                }
            }
            d.categories.clone()
        })
    }

    /// Deleting a category deletes its channels. Callers must also drop it
    /// from the plans that granted it (`Store::plans_remove_category`).
    pub fn remove_category(&self, id: &str) -> anyhow::Result<bool> {
        self.write(|d| {
            if !d.categories.iter().any(|c| c.id == id && !c.builtin) {
                return false;
            }
            d.categories.retain(|c| c.id != id);
            d.channels.retain(|c| c.category_id != id);
            for entry in d.overrides.values_mut() {
                entry.categories.remove(id);
            }
            true
        })
    }

    // ---- Channels ----

    /// One page of the filtered channel list.
    pub fn query_channels(&self, q: &ChannelQuery) -> (usize, Vec<Channel>) {
        let data = self.read();
        let needle = normalize_name(&q.q).to_lowercase();
        let mut filtered: Vec<&Channel> = data
            .channels
            .iter()
            .filter(|ch| {
                if !q.category_id.is_empty() && ch.category_id != q.category_id {
                    return false;
                }
                if !q.source_id.is_empty() && ch.source_id.as_deref() != Some(q.source_id.as_str()) {
                    return false;
                }
                let status_ok = match q.status.as_str() {
                    "enabled" => ch.enabled && !ch.missing,
                    "disabled" => !ch.enabled && !ch.missing,
                    "missing" => ch.missing,
                    _ => !ch.missing,
                };
                status_ok
                    && (needle.is_empty()
                        || ch.name.to_lowercase().contains(&needle)
                        || ch.original_name.to_lowercase().contains(&needle))
            })
            .collect();
        let order: HashMap<&str, i64> = data.categories.iter().map(|c| (c.id.as_str(), c.sort)).collect();
        filtered.sort_by(|a, b| {
            let ca = order.get(a.category_id.as_str()).copied().unwrap_or(0);
            let cb = order.get(b.category_id.as_str()).copied().unwrap_or(0);
            ca.cmp(&cb).then(a.sort.cmp(&b.sort)).then_with(|| locale_cmp(&a.name, &b.name))
        });
        let start = q.page.saturating_sub(1) * q.page_size;
        let rows = filtered.iter().skip(start).take(q.page_size).map(|c| (*c).clone()).collect();
        (filtered.len(), rows)
    }

    /// Ids of every channel matching a filter (for "select all N" bulk edits).
    pub fn channel_ids_matching(&self, q: &ChannelQuery) -> Vec<String> {
        let all = ChannelQuery { page: 1, page_size: usize::MAX, ..q.clone() };
        self.query_channels(&all).1.into_iter().map(|c| c.id).collect()
    }

    pub fn channel(&self, id: &str) -> Option<Channel> {
        self.read().channels.iter().find(|c| c.id == id).cloned()
    }

    /// Add a channel by hand (a stream the upstream doesn't carry).
    pub fn create_channel(&self, name: &str, url: &str, category_id: &str, attrs: Attrs, enabled: bool) -> anyhow::Result<Channel> {
        self.write(|d| {
            let name = normalize_name(name);
            let c = Channel {
                id: make_token(12),
                key: format!("custom:{}", make_token(12)),
                source_id: None,
                category_id: category_id.to_owned(),
                original_name: name.clone(),
                name,
                upstream_group: None,
                url: url.trim().to_owned(),
                attrs,
                extras: Vec::new(),
                enabled,
                builtin: false,
                custom: true,
                missing: false,
                sort: d.channels.iter().map(|c| c.sort).fold(0, i64::max) + 1,
                added_at: Some(now_stamp()),
            };
            d.channels.push(c.clone());
            c
        })
    }

    pub fn update_channel(&self, id: &str, patch: &ChannelPatch) -> anyhow::Result<Option<Channel>> {
        self.write(|d| {
            let known = d.categories.iter().any(|c| Some(&c.id) == patch.category_id.as_ref());
            let c = d.channels.iter_mut().find(|c| c.id == id)?;
            apply_channel_fields(c, patch, known);
            Some(c.clone())
        })
    }

    /// One write for a multi-row edit.
    pub fn bulk_update_channels(&self, ids: &[String], patch: &ChannelPatch) -> anyhow::Result<usize> {
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        self.write(|d| {
            let known = d.categories.iter().any(|c| Some(&c.id) == patch.category_id.as_ref());
            let mut changed = 0;
            for c in d.channels.iter_mut().filter(|c| wanted.contains(c.id.as_str())) {
                apply_channel_fields(c, patch, known);
                changed += 1;
            }
            changed
        })
    }

    pub fn remove_channel(&self, id: &str) -> anyhow::Result<bool> {
        self.write(|d| {
            if !d.channels.iter().any(|c| c.id == id && !c.builtin) {
                return false;
            }
            d.channels.retain(|c| c.id != id);
            true
        })
    }

    // ---- Per-customer overrides ----

    pub fn overrides(&self, user_id: i64) -> UserOverrides {
        self.read().overrides.get(&user_id.to_string()).cloned().unwrap_or_default()
    }

    pub fn patch_overrides(&self, user_id: i64, patch: &OverridePatch) -> anyhow::Result<UserOverrides> {
        let key = user_id.to_string();
        self.write(|d| {
            let mut entry = d.overrides.remove(&key).unwrap_or_default();
            for (id, v) in &patch.categories {
                match v {
                    Some(b) => entry.categories.insert(id.clone(), *b),
                    None => entry.categories.remove(id),
                };
            }
            for (id, v) in &patch.channels {
                match v {
                    Some(b) => entry.channels.insert(id.clone(), *b),
                    None => entry.channels.remove(id),
                };
            }
            if !entry.is_empty() {
                d.overrides.insert(key, entry.clone());
            }
            entry
        })
    }

    pub fn reset_overrides(&self, user_id: i64) -> anyhow::Result<()> {
        self.write(|d| {
            d.overrides.remove(&user_id.to_string());
        })
    }

    /// Pinned decisions per user, for the "personalised" badge.
    pub fn override_counts(&self) -> HashMap<i64, usize> {
        self.read().overrides.iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.len()))).collect()
    }
}

/// The built-in info channel may be renamed but keeps its category and stays
/// on; the built-in media channel may also be switched off, but stays in
/// Информация too.
fn apply_channel_fields(c: &mut Channel, patch: &ChannelPatch, category_known: bool) {
    if let Some(name) = &patch.name {
        c.name = normalize_name(name);
    }
    if let Some(v) = patch.enabled
        && c.id == INFO_MEDIA_CHANNEL_ID
    {
        c.enabled = v;
    }
    if c.builtin {
        return;
    }
    if let Some(v) = patch.enabled {
        c.enabled = v;
    }
    if let Some(cat) = patch.category_id.as_ref().filter(|_| category_known) {
        c.category_id.clone_from(cat);
    }
    if let Some(url) = &patch.url {
        c.url = url.trim().to_owned();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playlist::model::{INFO_CATEGORY_ID, INFO_CHANNEL_ID};

    fn open(dir: &Path) -> Catalog {
        let settings = CatalogSettings {
            info_category_name: "Информация".into(),
            default_interval_hours: 24.0,
            fetch_timeout: Duration::from_secs(5),
            max_bytes: 1 << 20,
        };
        Catalog::open(dir, settings, reqwest::Client::new()).unwrap()
    }

    #[test]
    fn builtins_are_protected() {
        let dir = tempfile::tempdir().unwrap();
        let cat = open(dir.path());
        assert!(!cat.remove_category(INFO_CATEGORY_ID).unwrap());
        let off = CategoryPatch { enabled: Some(false), ..CategoryPatch::default() };
        assert!(cat.update_category(INFO_CATEGORY_ID, off).unwrap().unwrap().enabled);
        let other = cat.create_category("Спорт", true).unwrap();
        let mv = ChannelPatch { category_id: Some(other.id.clone()), enabled: Some(false), ..ChannelPatch::default() };
        let info = cat.update_channel(INFO_CHANNEL_ID, &mv).unwrap().unwrap();
        assert_eq!(info.category_id, INFO_CATEGORY_ID);
        assert!(info.enabled);
        let media = cat.update_channel(INFO_MEDIA_CHANNEL_ID, &mv).unwrap().unwrap();
        assert!(!media.enabled);
        assert_eq!(media.category_id, INFO_CATEGORY_ID);
        assert!(!cat.remove_channel(INFO_CHANNEL_ID).unwrap());
    }

    #[test]
    fn overrides_patch_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let cat = open(dir.path());
        let patch = OverridePatch { categories: vec![("c1".into(), Some(true))], channels: vec![("x".into(), Some(false))] };
        cat.patch_overrides(7, &patch).unwrap();
        assert_eq!(cat.override_counts()[&7], 2);
        drop(cat);
        let cat = open(dir.path());
        assert_eq!(cat.overrides(7).categories["c1"], true);
        let clear = OverridePatch { categories: vec![("c1".into(), None)], channels: vec![("x".into(), None)] };
        cat.patch_overrides(7, &clear).unwrap();
        assert!(cat.override_counts().is_empty());
    }

    #[test]
    fn query_pages_and_filters() {
        let dir = tempfile::tempdir().unwrap();
        let cat = open(dir.path());
        let c = cat.create_category("Кино", true).unwrap();
        for i in 0..5 {
            cat.create_channel(&format!("Film {i}"), "http://x", &c.id, Attrs::new(), i % 2 == 0).unwrap();
        }
        let q = ChannelQuery { category_id: c.id.clone(), page: 1, page_size: 2, ..ChannelQuery::default() };
        let (total, rows) = cat.query_channels(&q);
        assert_eq!((total, rows.len()), (5, 2));
        let q = ChannelQuery { status: "disabled".into(), q: "film".into(), page: 1, page_size: 50, ..ChannelQuery::default() };
        assert_eq!(cat.query_channels(&q).0, 2);
        assert_eq!(cat.channel_ids_matching(&q).len(), 2);
    }
}
