//! The curated channel catalog store: upstream sources, the categories and
//! channels imported from them, and each customer's personal visibility
//! overrides. A provider playlist can carry tens of thousands of channels.
//!
//! Persisted in PostgreSQL. Like `data::store`, reads come from an in-memory
//! copy; every write changes a copy, persists only the rows that differ, and
//! then swaps the copy in.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use anyhow::Context;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use sqlx::PgPool;
use tokio::sync::Mutex as AsyncMutex;
use serde::Serialize;

use super::m3u::{Attrs, parse_m3u};
use super::model::{
    CatalogData, Category, Channel, Counts, INFO_MEDIA_CHANNEL_ID, MergeStats, Source, UserOverrides, channel_counts,
    ensure_builtins, merge_source_channels, normalize_name, source_due_at, source_is_due,
};
use crate::core::fetch::fetch_bounded;
use crate::core::util::{locale_cmp, make_token, now_ms, now_stamp};

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
    pool: PgPool,
    data: RwLock<Arc<CatalogData>>,
    settings: CatalogSettings,
    client: reqwest::Client,
    writes: AsyncMutex<()>,
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
    /// Load the catalog from an already-migrated pool and make sure the
    /// built-in Информация rows exist.
    pub async fn open(pool: PgPool, settings: CatalogSettings, client: reqwest::Client) -> anyhow::Result<Self> {
        let mut data = sql::load(&pool).await.context("loading the catalog")?;
        for source in &mut data.sources {
            if source.interval_hours.is_none() {
                source.interval_hours = Some(settings.default_interval_hours);
            }
        }
        let catalog = Self { pool, data: RwLock::new(Arc::new(data)), settings, client, writes: AsyncMutex::new(()) };
        let name = catalog.settings.info_category_name.clone();
        catalog.write(|d| ensure_builtins(d, &name)).await?;
        Ok(catalog)
    }

    /// A consistent read snapshot for the pure helpers in `model`.
    pub fn read(&self) -> Arc<CatalogData> {
        Arc::clone(&self.data.read().unwrap_or_else(PoisonError::into_inner))
    }

    /// Run a mutation on a copy of the catalog, persist exactly the rows that
    /// differ (one transaction), then make the copy the cache.
    async fn write<R>(&self, f: impl FnOnce(&mut CatalogData) -> R) -> anyhow::Result<R> {
        let _guard = self.writes.lock().await;
        let current = self.read();
        let mut next = (*current).clone();
        let result = f(&mut next);
        let mut tx = self.pool.begin().await?;
        sql::persist_diff(&mut tx, &current, &next).await.context("persisting catalog changes")?;
        tx.commit().await?;
        *self.data.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(next);
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

    pub async fn create_source(
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
        self.write(|d| d.sources.push(source.clone())).await?;
        Ok(source)
    }

    pub async fn update_source(&self, id: &str, patch: SourcePatch) -> anyhow::Result<Option<Source>> {
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
        }).await
    }

    /// Removing a source drops the channels it imported, and any non-builtin
    /// category left empty (categories are shared between sources).
    pub async fn remove_source(&self, id: &str) -> anyhow::Result<bool> {
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
        }).await
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
        }).await?;
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

    pub async fn create_category(&self, name: &str, enabled: bool) -> anyhow::Result<Category> {
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
        }).await
    }

    /// The built-in Информация stays on and in place — it is what an expired
    /// customer keeps.
    pub async fn update_category(&self, id: &str, patch: CategoryPatch) -> anyhow::Result<Option<Category>> {
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
        }).await
    }

    pub async fn reorder_categories(&self, ids: &[String]) -> anyhow::Result<Vec<Category>> {
        self.write(|d| {
            for (index, id) in ids.iter().enumerate() {
                if let Some(c) = d.categories.iter_mut().find(|c| &c.id == id && !c.builtin) {
                    c.sort = index as i64 + 1;
                }
            }
            d.categories.clone()
        }).await
    }

    /// Deleting a category deletes its channels. Callers must also drop it
    /// from the plans that granted it (`Store::plans_remove_category`).
    pub async fn remove_category(&self, id: &str) -> anyhow::Result<bool> {
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
        }).await
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
    pub async fn create_channel(&self, name: &str, url: &str, category_id: &str, attrs: Attrs, enabled: bool) -> anyhow::Result<Channel> {
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
        }).await
    }

    pub async fn update_channel(&self, id: &str, patch: &ChannelPatch) -> anyhow::Result<Option<Channel>> {
        self.write(|d| {
            let known = d.categories.iter().any(|c| Some(&c.id) == patch.category_id.as_ref());
            let c = d.channels.iter_mut().find(|c| c.id == id)?;
            apply_channel_fields(c, patch, known);
            Some(c.clone())
        }).await
    }

    /// One write for a multi-row edit.
    pub async fn bulk_update_channels(&self, ids: &[String], patch: &ChannelPatch) -> anyhow::Result<usize> {
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        self.write(|d| {
            let known = d.categories.iter().any(|c| Some(&c.id) == patch.category_id.as_ref());
            let mut changed = 0;
            for c in d.channels.iter_mut().filter(|c| wanted.contains(c.id.as_str())) {
                apply_channel_fields(c, patch, known);
                changed += 1;
            }
            changed
        }).await
    }

    pub async fn remove_channel(&self, id: &str) -> anyhow::Result<bool> {
        self.write(|d| {
            if !d.channels.iter().any(|c| c.id == id && !c.builtin) {
                return false;
            }
            d.channels.retain(|c| c.id != id);
            true
        }).await
    }

    // ---- Per-customer overrides ----

    pub fn overrides(&self, user_id: i64) -> UserOverrides {
        self.read().overrides.get(&user_id.to_string()).cloned().unwrap_or_default()
    }

    pub async fn patch_overrides(&self, user_id: i64, patch: &OverridePatch) -> anyhow::Result<UserOverrides> {
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
        }).await
    }

    pub async fn reset_overrides(&self, user_id: i64) -> anyhow::Result<()> {
        self.write(|d| {
            d.overrides.remove(&user_id.to_string());
        }).await
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

/// PostgreSQL persistence of the catalog: a full load at startup and a
/// row-level diff on every write.
mod sql {
    use std::collections::{HashMap, HashSet};

    use serde_json::Value;
    use sqlx::{PgPool, Postgres, Row, Transaction};

    use super::super::m3u::Attrs;
    use super::super::model::{CatalogData, Category, Channel, Source};

    /// Channels per UNNEST batch.
    const CHUNK: usize = 5000;

    pub async fn load(pool: &PgPool) -> anyhow::Result<CatalogData> {
        let mut d = CatalogData::default();
        let src_sql = "SELECT id, name, url, enabled, auto_refresh, interval_hours, epg_url, \
            to_char(last_sync_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS last_sync_at, \
            (extract(epoch FROM last_sync_at) * 1000)::bigint AS last_sync_ms, last_error, last_count, \
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created_at FROM sources ORDER BY created_at, id";
        for r in sqlx::query(src_sql).fetch_all(pool).await? {
            d.sources.push(Source {
                id: r.try_get("id")?,
                name: r.try_get("name")?,
                url: r.try_get("url")?,
                enabled: r.try_get("enabled")?,
                auto_refresh: r.try_get("auto_refresh")?,
                interval_hours: r.try_get("interval_hours")?,
                epg_url: r.try_get("epg_url")?,
                last_sync_at: r.try_get("last_sync_at")?,
                last_sync_ms: r.try_get("last_sync_ms")?,
                last_error: r.try_get("last_error")?,
                last_count: usize::try_from(r.try_get::<i64, _>("last_count")?).unwrap_or(0),
                created_at: r.try_get("created_at")?,
            });
        }
        for r in sqlx::query("SELECT id, key, name, source_name, enabled, builtin, custom, sort FROM categories ORDER BY sort, id")
            .fetch_all(pool)
            .await?
        {
            d.categories.push(Category {
                id: r.try_get("id")?,
                key: r.try_get("key")?,
                name: r.try_get("name")?,
                source_name: r.try_get("source_name")?,
                enabled: r.try_get("enabled")?,
                builtin: r.try_get("builtin")?,
                custom: r.try_get("custom")?,
                sort: r.try_get("sort")?,
            });
        }
        let ch_sql = "SELECT id, key, source_id, category_id, name, original_name, upstream_group, url, attrs, extras, \
            enabled, builtin, custom, missing, sort, \
            to_char(added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS added_at FROM channels ORDER BY sort, id";
        for r in sqlx::query(ch_sql).fetch_all(pool).await? {
            d.channels.push(Channel {
                id: r.try_get("id")?,
                key: r.try_get("key")?,
                source_id: r.try_get("source_id")?,
                category_id: r.try_get("category_id")?,
                name: r.try_get("name")?,
                original_name: r.try_get("original_name")?,
                upstream_group: r.try_get("upstream_group")?,
                url: r.try_get("url")?,
                attrs: serde_json::from_value::<Attrs>(r.try_get("attrs")?).unwrap_or_default(),
                extras: serde_json::from_value(r.try_get("extras")?).unwrap_or_default(),
                enabled: r.try_get("enabled")?,
                builtin: r.try_get("builtin")?,
                custom: r.try_get("custom")?,
                missing: r.try_get("missing")?,
                sort: r.try_get("sort")?,
                added_at: r.try_get("added_at")?,
            });
        }
        for r in sqlx::query("SELECT user_id, kind, target_id, value FROM user_overrides").fetch_all(pool).await? {
            let entry = d.overrides.entry(r.try_get::<i64, _>("user_id")?.to_string()).or_default();
            let (target, value): (String, bool) = (r.try_get("target_id")?, r.try_get("value")?);
            if r.try_get::<String, _>("kind")? == "category" {
                entry.categories.insert(target, value);
            } else {
                entry.channels.insert(target, value);
            }
        }
        Ok(d)
    }

    /// Rows of `new` that are new or differ from `old`, and ids gone from it.
    fn diff<'a, T: PartialEq>(old: &'a [T], new: &'a [T], id: impl Fn(&T) -> &str) -> (Vec<&'a T>, Vec<String>) {
        let before: HashMap<&str, &T> = old.iter().map(|x| (id(x), x)).collect();
        let after: HashSet<&str> = new.iter().map(&id).collect();
        let changed = new.iter().filter(|x| before.get(id(x)).is_none_or(|b| *b != *x)).collect();
        let gone = old.iter().map(&id).filter(|k| !after.contains(k)).map(str::to_owned).collect();
        (changed, gone)
    }

    type Pin = (i64, &'static str, String, bool);

    fn pins(d: &CatalogData) -> HashMap<(i64, &'static str, String), bool> {
        let mut out = HashMap::new();
        for (user, o) in &d.overrides {
            let Ok(user) = user.parse::<i64>() else { continue };
            for (id, v) in &o.categories {
                out.insert((user, "category", id.clone()), *v);
            }
            for (id, v) in &o.channels {
                out.insert((user, "channel", id.clone()), *v);
            }
        }
        out
    }

    pub async fn persist_diff(tx: &mut Transaction<'_, Postgres>, old: &CatalogData, new: &CatalogData) -> sqlx::Result<()> {
        let (sources, gone_sources) = diff(&old.sources, &new.sources, |s| &s.id);
        let (categories, gone_categories) = diff(&old.categories, &new.categories, |c| &c.id);
        let (channels, gone_channels) = diff(&old.channels, &new.channels, |c| &c.id);

        // Parents first, so channels always find their source and category.
        for s in sources {
            sqlx::query(
                "INSERT INTO sources (id, name, url, enabled, auto_refresh, interval_hours, epg_url, last_sync_at, last_error, last_count, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision / 1000),$9,$10,COALESCE(NULLIF($11,'')::timestamptz, now()))
                 ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, url=EXCLUDED.url, enabled=EXCLUDED.enabled,
                   auto_refresh=EXCLUDED.auto_refresh, interval_hours=EXCLUDED.interval_hours, epg_url=EXCLUDED.epg_url,
                   last_sync_at=EXCLUDED.last_sync_at, last_error=EXCLUDED.last_error, last_count=EXCLUDED.last_count",
            )
            .bind(&s.id)
            .bind(&s.name)
            .bind(&s.url)
            .bind(s.enabled)
            .bind(s.auto_refresh)
            .bind(s.interval_hours)
            .bind(&s.epg_url)
            .bind(s.last_sync_ms.map(|ms| ms as f64))
            .bind(&s.last_error)
            .bind(s.last_count as i64)
            .bind(s.created_at.as_deref().unwrap_or(""))
            .execute(&mut **tx)
            .await?;
        }
        for c in categories {
            sqlx::query(
                "INSERT INTO categories (id, key, name, source_name, enabled, builtin, custom, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (id) DO UPDATE SET key=EXCLUDED.key, name=EXCLUDED.name, source_name=EXCLUDED.source_name,
                   enabled=EXCLUDED.enabled, builtin=EXCLUDED.builtin, custom=EXCLUDED.custom, sort=EXCLUDED.sort",
            )
            .bind(&c.id)
            .bind(&c.key)
            .bind(&c.name)
            .bind(&c.source_name)
            .bind(c.enabled)
            .bind(c.builtin)
            .bind(c.custom)
            .bind(c.sort)
            .execute(&mut **tx)
            .await?;
        }
        for chunk in channels.chunks(CHUNK) {
            upsert_channels(tx, chunk).await?;
        }
        if !gone_channels.is_empty() {
            sqlx::query("DELETE FROM channels WHERE id = ANY($1)").bind(&gone_channels).execute(&mut **tx).await?;
        }
        if !gone_categories.is_empty() {
            sqlx::query("DELETE FROM categories WHERE id = ANY($1)").bind(&gone_categories).execute(&mut **tx).await?;
        }
        if !gone_sources.is_empty() {
            sqlx::query("DELETE FROM sources WHERE id = ANY($1)").bind(&gone_sources).execute(&mut **tx).await?;
        }

        let (before, after) = (pins(old), pins(new));
        for (user, kind, target) in before.keys().filter(|k| !after.contains_key(*k)) {
            sqlx::query("DELETE FROM user_overrides WHERE user_id = $1 AND kind = $2 AND target_id = $3")
                .bind(user)
                .bind(*kind)
                .bind(target)
                .execute(&mut **tx)
                .await?;
        }
        let changed: Vec<Pin> = after
            .iter()
            .filter(|(k, v)| before.get(*k) != Some(*v))
            .map(|((u, kind, t), v)| (*u, *kind, t.clone(), *v))
            .collect();
        for (user, kind, target, value) in changed {
            sqlx::query(
                "INSERT INTO user_overrides (user_id, kind, target_id, value) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (user_id, kind, target_id) DO UPDATE SET value = EXCLUDED.value",
            )
            .bind(user)
            .bind(kind)
            .bind(target)
            .bind(value)
            .execute(&mut **tx)
            .await?;
        }
        Ok(())
    }

    /// One statement per batch: parallel arrays through UNNEST.
    async fn upsert_channels(tx: &mut Transaction<'_, Postgres>, rows: &[&Channel]) -> sqlx::Result<()> {
        let col = |f: fn(&Channel) -> String| rows.iter().map(|c| f(c)).collect::<Vec<String>>();
        let opt = |f: fn(&Channel) -> Option<String>| rows.iter().map(|c| f(c)).collect::<Vec<Option<String>>>();
        let flag = |f: fn(&Channel) -> bool| rows.iter().map(|c| f(c)).collect::<Vec<bool>>();
        sqlx::query(
            "INSERT INTO channels (id, key, source_id, category_id, name, original_name, upstream_group, url, attrs, extras,
                                   enabled, builtin, custom, missing, sort, added_at)
             SELECT id, key, source_id, category_id, name, original_name, upstream_group, url, attrs::jsonb, extras::jsonb,
                    enabled, builtin, custom, missing, sort, NULLIF(added_at, '')::timestamptz
             FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                         $9::text[], $10::text[], $11::bool[], $12::bool[], $13::bool[], $14::bool[], $15::int8[], $16::text[])
               AS t(id, key, source_id, category_id, name, original_name, upstream_group, url, attrs, extras,
                    enabled, builtin, custom, missing, sort, added_at)
             ON CONFLICT (id) DO UPDATE SET key=EXCLUDED.key, source_id=EXCLUDED.source_id, category_id=EXCLUDED.category_id,
               name=EXCLUDED.name, original_name=EXCLUDED.original_name, upstream_group=EXCLUDED.upstream_group, url=EXCLUDED.url,
               attrs=EXCLUDED.attrs, extras=EXCLUDED.extras, enabled=EXCLUDED.enabled, builtin=EXCLUDED.builtin,
               custom=EXCLUDED.custom, missing=EXCLUDED.missing, sort=EXCLUDED.sort, added_at=EXCLUDED.added_at",
        )
        .bind(col(|c| c.id.clone()))
        .bind(col(|c| c.key.clone()))
        .bind(opt(|c| c.source_id.clone()))
        .bind(col(|c| c.category_id.clone()))
        .bind(col(|c| c.name.clone()))
        .bind(col(|c| c.original_name.clone()))
        .bind(opt(|c| c.upstream_group.clone()))
        .bind(col(|c| c.url.clone()))
        .bind(col(|c| serde_json::to_string(&c.attrs).unwrap_or_else(|_| "{}".to_owned())))
        .bind(col(|c| Value::from(c.extras.clone()).to_string()))
        .bind(flag(|c| c.enabled))
        .bind(flag(|c| c.builtin))
        .bind(flag(|c| c.custom))
        .bind(flag(|c| c.missing))
        .bind(rows.iter().map(|c| c.sort).collect::<Vec<i64>>())
        .bind(rows.iter().map(|c| c.added_at.clone().unwrap_or_default()).collect::<Vec<String>>())
        .execute(&mut **tx)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::db::testing::TestDb;
    use crate::data::store::Store;
    use crate::playlist::model::{INFO_CATEGORY_ID, INFO_CHANNEL_ID};

    async fn open(pool: &PgPool) -> Catalog {
        let settings = CatalogSettings {
            info_category_name: "Информация".into(),
            default_interval_hours: 24.0,
            fetch_timeout: Duration::from_secs(5),
            max_bytes: 1 << 20,
        };
        Catalog::open(pool.clone(), settings, reqwest::Client::new()).await.unwrap()
    }

    #[tokio::test]
    async fn builtins_are_protected() {
        let t = TestDb::new().await;
        let cat = open(&t.pool).await;
        assert!(!cat.remove_category(INFO_CATEGORY_ID).await.unwrap());
        let off = CategoryPatch { enabled: Some(false), ..CategoryPatch::default() };
        assert!(cat.update_category(INFO_CATEGORY_ID, off).await.unwrap().unwrap().enabled);
        let other = cat.create_category("Спорт", true).await.unwrap();
        let mv = ChannelPatch { category_id: Some(other.id.clone()), enabled: Some(false), ..ChannelPatch::default() };
        let info = cat.update_channel(INFO_CHANNEL_ID, &mv).await.unwrap().unwrap();
        assert_eq!(info.category_id, INFO_CATEGORY_ID);
        assert!(info.enabled);
        let media = cat.update_channel(INFO_MEDIA_CHANNEL_ID, &mv).await.unwrap().unwrap();
        assert!(!media.enabled);
        assert_eq!(media.category_id, INFO_CATEGORY_ID);
        assert!(!cat.remove_channel(INFO_CHANNEL_ID).await.unwrap());
        // Reloading from the database gives the same rows.
        let again = open(&t.pool).await;
        assert!(!again.channel(INFO_MEDIA_CHANNEL_ID).unwrap().enabled);
        assert_eq!(again.categories().len(), 2);
        t.drop().await;
    }

    #[tokio::test]
    async fn overrides_patch_and_persist() {
        let t = TestDb::new().await;
        let store = Store::open(t.pool.clone()).await.unwrap();
        let u = store.create_user("x".into(), "pro".into(), None, true, None).await.unwrap();
        let cat = open(&t.pool).await;
        let patch = OverridePatch { categories: vec![("c1".into(), Some(true))], channels: vec![("x".into(), Some(false))] };
        cat.patch_overrides(u.id, &patch).await.unwrap();
        assert_eq!(cat.override_counts()[&u.id], 2);
        let cat = open(&t.pool).await;
        assert_eq!(cat.overrides(u.id).categories["c1"], true);
        let clear = OverridePatch { categories: vec![("c1".into(), None)], channels: vec![("x".into(), None)] };
        cat.patch_overrides(u.id, &clear).await.unwrap();
        assert!(open(&t.pool).await.override_counts().is_empty());
        t.drop().await;
    }

    #[tokio::test]
    async fn query_pages_and_filters() {
        let t = TestDb::new().await;
        let cat = open(&t.pool).await;
        let c = cat.create_category("Кино", true).await.unwrap();
        for i in 0..5 {
            cat.create_channel(&format!("Film {i}"), "http://x", &c.id, Attrs::new(), i % 2 == 0).await.unwrap();
        }
        let q = ChannelQuery { category_id: c.id.clone(), page: 1, page_size: 2, ..ChannelQuery::default() };
        let (total, rows) = cat.query_channels(&q);
        assert_eq!((total, rows.len()), (5, 2));
        let q = ChannelQuery { status: "disabled".into(), q: "film".into(), page: 1, page_size: 50, ..ChannelQuery::default() };
        assert_eq!(cat.query_channels(&q).0, 2);
        assert_eq!(open(&t.pool).await.channel_ids_matching(&q).len(), 2);
        t.drop().await;
    }

    #[tokio::test]
    async fn refresh_imports_and_keeps_edits_in_postgres() {
        use axum::routing::get;
        let body = "#EXTM3U url-tvg=\"http://p/epg.xml\"\n#EXTINF:-1 tvg-id=\"s1\" group-title=\"Спорт\",Sport 1\nhttp://p/1.m3u8\n#EXTINF:-1 tvg-id=\"n1\" group-title=\"Новости\",News 1\nhttp://p/2.ts\n";
        let app = axum::Router::new().route("/list.m3u", get(move || async move { body }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let t = TestDb::new().await;
        let cat = open(&t.pool).await;
        let src = cat.create_source("P", &format!("http://{addr}/list.m3u"), true, true, None).await.unwrap();
        let out = cat.refresh_source(&src.id).await.unwrap();
        assert_eq!(out.stats.unwrap().added, 2);
        let sport1 = cat.read().channels.iter().find(|c| c.name == "Sport 1").unwrap().id.clone();
        cat.update_channel(&sport1, &ChannelPatch { name: Some("Спорт 1".into()), ..ChannelPatch::default() }).await.unwrap();
        let out = cat.refresh_source(&src.id).await.unwrap();
        assert_eq!(out.stats.unwrap().updated, 2);

        let again = open(&t.pool).await;
        let ch = again.channel(&sport1).unwrap();
        assert_eq!(ch.name, "Спорт 1", "admin rename survives a refresh");
        assert_eq!(ch.attrs.get("tvg-id").map(String::as_str), Some("s1"));
        let s = again.source(&src.id).unwrap();
        assert_eq!(s.epg_url, "http://p/epg.xml");
        assert!(s.last_sync_ms.is_some() && s.last_error.is_none());
        assert!(again.remove_source(&src.id).await.unwrap());
        assert_eq!(open(&t.pool).await.read().channels.len(), 2, "only the two built-ins remain");
        t.drop().await;
    }
}
