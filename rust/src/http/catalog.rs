//! Admin JSON API for the channel catalog: sources, categories, channels and
//! each customer's personal visibility pins. Mounted inside the admin's
//! `/api` router, so it inherits auth + CSRF.
//!
//! Catalog edits never re-encode anything: the `.m3u` is rendered per
//! request, so a rename or toggle is live on the customer's next refresh.
//! Validation and view models are pure functions at the top of this file.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path as UrlPath, Query, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use super::AppState;
use super::api::{ApiError, ApiResult, body, created, num_of, ok, str_of};
use super::gateway::is_locked;
use crate::core::util::{account_status, locale_cmp};
use crate::notify::notify::ContentChange;
use crate::playlist::catalog::{CategoryPatch, ChannelPatch, ChannelQuery, OverridePatch, SourcePatch};
use crate::playlist::m3u::Attrs;
use crate::playlist::model::{
    Category, Channel, Counts, INFO_CATEGORY_ID, INFO_CHANNEL_ID, INFO_MEDIA_CHANNEL_ID, REFRESH_INTERVALS, Resolve, Source,
    UserOverrides, category_enabled_for, effective_enabled, resolve_user_channels,
};

// ===========================================================================
// Pure view models + validation
// ===========================================================================

pub fn source_json(s: &Source, due_at: Option<i64>) -> Value {
    json!({
        "id": s.id, "name": s.name, "url": s.url, "enabled": s.enabled, "auto_refresh": s.auto_refresh,
        "interval_hours": s.interval_hours.unwrap_or(0.0),
        // Epoch-ms of the next unattended re-download; null = manual only.
        "next_sync_ms": due_at,
        "epg_url": s.epg_url, "last_sync_at": s.last_sync_at, "last_error": s.last_error, "last_count": s.last_count,
    })
}

pub fn category_json(c: &Category, counts: &HashMap<String, Counts>) -> Value {
    let n = counts.get(&c.id).copied().unwrap_or_default();
    json!({
        "id": c.id, "name": c.name, "source_name": c.source_name.clone().unwrap_or_default(), "enabled": c.enabled,
        "builtin": c.builtin, "custom": c.custom, "sort": c.sort, "channels": n.total, "channels_enabled": n.enabled,
    })
}

pub fn channel_json(c: &Channel) -> Value {
    json!({
        "id": c.id, "name": c.name, "original_name": c.original_name, "category_id": c.category_id,
        "source_id": c.source_id, "url": c.url,
        "logo": c.attrs.get("tvg-logo").cloned().unwrap_or_default(),
        "tvg_id": c.attrs.get("tvg-id").cloned().unwrap_or_default(),
        "enabled": c.enabled, "builtin": c.builtin, "custom": c.custom, "missing": c.missing,
        "renamed": !c.original_name.is_empty() && c.name != c.original_name,
    })
}

fn bool_field(b: &Value, key: &str) -> Result<Option<bool>, String> {
    match b.get(key) {
        None => Ok(None),
        Some(Value::Bool(v)) => Ok(Some(*v)),
        Some(_) => Err(format!("{key} must be a boolean")),
    }
}

/// A playlist source: an http(s) URL is the only thing worth fetching, and
/// rejecting other schemes keeps `file:`/`data:` out of the fetcher.
pub fn validate_source(b: &Value, partial: bool) -> Result<SourcePatch, String> {
    let mut out = SourcePatch::default();
    if !partial || b.get("name").is_some() {
        let name = str_of(b.get("name")).trim().to_owned();
        if name.is_empty() {
            return Err("source name required".into());
        }
        if name.chars().count() > 80 {
            return Err("name must be 80 characters or less".into());
        }
        out.name = Some(name);
    }
    if !partial || b.get("url").is_some() {
        let url = str_of(b.get("url")).trim().to_owned();
        let parsed = url::Url::parse(&url).map_err(|_| "playlist URL is not valid".to_owned())?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("playlist URL must be http(s)".into());
        }
        out.url = Some(url);
    }
    out.enabled = bool_field(b, "enabled")?;
    out.auto_refresh = bool_field(b, "auto_refresh")?;
    if b.get("interval_hours").is_some() {
        let hours = num_of(b.get("interval_hours")).filter(|h| REFRESH_INTERVALS.contains(h));
        let Some(h) = hours else {
            let list: Vec<String> = REFRESH_INTERVALS.iter().map(|h| format!("{h}")).collect();
            return Err(format!("interval_hours must be one of: {}", list.join(", ")));
        };
        out.interval_hours = Some(h);
    }
    Ok(out)
}

pub fn validate_category(b: &Value, partial: bool) -> Result<CategoryPatch, String> {
    let mut out = CategoryPatch::default();
    if !partial || b.get("name").is_some() {
        let name = str_of(b.get("name")).trim().to_owned();
        if name.is_empty() {
            return Err("category name required".into());
        }
        if name.chars().count() > 80 {
            return Err("name must be 80 characters or less".into());
        }
        out.name = Some(name);
    }
    out.enabled = bool_field(b, "enabled")?;
    Ok(out)
}

/// `allow_empty_name`: the account channel's name may be cleared (empty is
/// its default, "<brand> — <customer>").
pub fn validate_channel_patch(b: &Value, allow_empty_name: bool) -> Result<ChannelPatch, String> {
    let mut out = ChannelPatch::default();
    if let Some(v) = b.get("name") {
        let name = str_of(Some(v)).trim().to_owned();
        if name.is_empty() && !allow_empty_name {
            return Err("channel name required".into());
        }
        if name.chars().count() > 160 {
            return Err("name must be 160 characters or less".into());
        }
        out.name = Some(name);
    }
    out.enabled = bool_field(b, "enabled")?;
    if let Some(v) = b.get("category_id") {
        out.category_id = Some(str_of(Some(v)));
    }
    if out.name.is_none() && out.enabled.is_none() && out.category_id.is_none() {
        return Err("nothing to update".into());
    }
    Ok(out)
}

const MAX_PAGE_SIZE: usize = 500;

pub fn parse_channel_query(q: &HashMap<String, String>) -> ChannelQuery {
    let int = |k: &str| q.get(k).and_then(|v| v.trim().parse::<i64>().ok()).filter(|n| *n > 0);
    let status = q.get("status").map(String::as_str).filter(|s| ["all", "enabled", "disabled", "missing"].contains(s)).unwrap_or("all");
    ChannelQuery {
        q: q.get("q").map(|s| s.chars().take(100).collect()).unwrap_or_default(),
        category_id: q.get("category").cloned().unwrap_or_default(),
        source_id: q.get("source").cloned().unwrap_or_default(),
        status: status.to_owned(),
        page: int("page").map_or(1, |n| n as usize),
        page_size: int("pageSize").map_or(50, |n| (n as usize).min(MAX_PAGE_SIZE)),
    }
}

/// Query parameters from a JSON `filter` object (the bulk endpoint).
fn query_map(filter: &Value) -> HashMap<String, String> {
    filter.as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), str_of(Some(v)))).collect()).unwrap_or_default()
}

/// A per-customer channel row: global value, this customer's pin, result.
pub fn personal_row_json(enabled: bool, pin: Option<bool>, locked: bool, forced: bool) -> Value {
    json!({ "global_enabled": enabled, "override": pin, "effective": forced || (!locked && effective_enabled(enabled, pin)) })
}

/// A per-customer category row, plus whether the plan includes it.
pub fn personal_category_json(c: &Category, pin: Option<bool>, locked: bool, plan: &HashSet<String>) -> Value {
    json!({
        "global_enabled": c.enabled,
        "in_plan": c.builtin || plan.contains(&c.id),
        "override": pin,
        // Информация is unconditional, even for a lapsed account.
        "effective": c.builtin || (!locked && category_enabled_for(c, pin, Some(plan))),
    })
}

/// What a personal-exception patch actually changes for the customer, by
/// comparing EFFECTIVE visibility before and after — so a pin restating what
/// the plan already grants reports (and mails) nothing.
pub fn diff_override_patch(
    category_rows: &[Category],
    channel_rows: &[Channel],
    before: &UserOverrides,
    after: &UserOverrides,
    plan: Option<&HashSet<String>>,
    category_visible_after: impl Fn(&str) -> bool,
) -> ContentChange {
    let mut out = ContentChange::default();
    for c in category_rows.iter().filter(|c| !c.builtin) {
        let was = category_enabled_for(c, before.categories.get(&c.id).copied(), plan);
        let now = category_enabled_for(c, after.categories.get(&c.id).copied(), plan);
        if was != now {
            if now { &mut out.added_categories } else { &mut out.removed_categories }.push(c.name.clone());
        }
    }
    for ch in channel_rows.iter().filter(|c| !c.builtin && category_visible_after(&c.category_id)) {
        let was = effective_enabled(ch.enabled, before.channels.get(&ch.id).copied());
        let now = effective_enabled(ch.enabled, after.channels.get(&ch.id).copied());
        if was != now {
            if now { &mut out.added_channels } else { &mut out.removed_channels }.push(ch.name.clone());
        }
    }
    out
}

// ===========================================================================
// HTTP
// ===========================================================================

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/catalog", get(overview))
        .route("/catalog/sources", post(create_source))
        .route("/catalog/sources/{id}", patch(update_source).delete(delete_source))
        .route("/catalog/sources/{id}/refresh", post(refresh_source))
        .route("/catalog/refresh", post(refresh_all))
        .route("/catalog/categories", post(create_category))
        .route("/catalog/categories/reorder", post(reorder_categories))
        .route("/catalog/categories/{id}", patch(update_category).delete(delete_category))
        .route("/catalog/channels", get(list_channels).post(create_channel))
        .route("/catalog/channels/bulk", post(bulk_channels))
        .route("/catalog/channels/{id}", patch(update_channel).delete(delete_channel))
        .route("/users/{id}/channels", get(user_channels).patch(patch_user_channels))
        .route("/users/{id}/channels/reset", post(reset_user_channels))
}

fn sorted_categories(st: &AppState) -> Vec<Category> {
    let mut cats = st.catalog.categories();
    cats.sort_by(|a, b| a.sort.cmp(&b.sort).then_with(|| locale_cmp(&a.name, &b.name)));
    cats
}

pub fn catalog_overview(st: &AppState) -> Value {
    let counts = st.catalog.category_counts();
    let plans = st.store.plans();
    let mut sold: HashMap<&str, usize> = HashMap::new();
    for p in &plans {
        for id in &p.category_ids {
            *sold.entry(id.as_str()).or_default() += 1;
        }
    }
    let categories: Vec<Value> = sorted_categories(st)
        .iter()
        .map(|c| {
            let mut v = category_json(c, &counts);
            // How many plans sell it; zero means no customer can ever see it.
            v["plans"] = json!(if c.builtin { plans.len() } else { sold.get(c.id.as_str()).copied().unwrap_or(0) });
            v
        })
        .collect();
    let data = st.catalog.read();
    let live = data.channels.iter().filter(|c| !c.missing);
    json!({
        "sources": data.sources.iter().map(|s| source_json(s, st.catalog.source_due_at(s))).collect::<Vec<_>>(),
        "refreshIntervals": REFRESH_INTERVALS,
        "autoRefreshEnabled": st.config.catalog.auto_refresh,
        "plans": plans.iter().map(|p| json!({ "id": p.id, "name": p.name, "category_ids": p.category_ids })).collect::<Vec<_>>(),
        "totals": {
            "channels": live.clone().count(),
            "enabled": live.filter(|c| c.enabled).count(),
            "missing": data.channels.iter().filter(|c| c.missing).count(),
            "categories": categories.len(),
            "emptyPlans": plans.iter().filter(|p| p.category_ids.is_empty()).count(),
            "unsoldCategories": categories.iter().filter(|c| c["builtin"] != json!(true) && c["plans"] == json!(0)).count(),
        },
        "categories": categories,
        "infoCategoryId": INFO_CATEGORY_ID,
    })
}

async fn overview(State(st): State<AppState>) -> ApiResult {
    ok(catalog_overview(&st))
}

async fn create_source(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let v = validate_source(&body(b), false).map_err(ApiError::bad)?;
    let s = st
        .catalog
        .create_source(&v.name.unwrap_or_default(), &v.url.unwrap_or_default(), v.enabled.unwrap_or(true), v.auto_refresh.unwrap_or(true), v.interval_hours)
        .await?;
    tracing::info!(target: "admin", source_id = %s.id, name = %s.name, "playlist source created");
    created(source_json(&s, st.catalog.source_due_at(&s)))
}

async fn update_source(State(st): State<AppState>, UrlPath(id): UrlPath<String>, b: Option<Json<Value>>) -> ApiResult {
    if st.catalog.source(&id).is_none() {
        return Err(ApiError::not_found());
    }
    let v = validate_source(&body(b), true).map_err(ApiError::bad)?;
    let s = st.catalog.update_source(&id, v).await?.ok_or_else(ApiError::not_found)?;
    ok(source_json(&s, st.catalog.source_due_at(&s)))
}

async fn delete_source(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    if !st.catalog.remove_source(&id).await? {
        return Err(ApiError::not_found());
    }
    tracing::info!(target: "admin", source_id = %id, "playlist source deleted");
    ok(json!({ "ok": true }))
}

/// Slow (a large download), so the client waits for the import result.
async fn refresh_source(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    if st.catalog.source(&id).is_none() {
        return Err(ApiError::not_found());
    }
    match st.catalog.refresh_source(&id).await {
        Ok(stats) => ok(json!({ "ok": true, "stats": stats, "catalog": catalog_overview(&st) })),
        Err(e) => Err(ApiError::new(axum::http::StatusCode::BAD_GATEWAY, e.to_string())),
    }
}

async fn refresh_all(State(st): State<AppState>) -> ApiResult {
    let results = st.catalog.refresh_all().await;
    ok(json!({ "ok": true, "results": results, "catalog": catalog_overview(&st) }))
}

async fn create_category(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let v = validate_category(&body(b), false).map_err(ApiError::bad)?;
    let c = st.catalog.create_category(&v.name.unwrap_or_default(), v.enabled.unwrap_or(true)).await?;
    created(category_json(&c, &st.catalog.category_counts()))
}

async fn update_category(State(st): State<AppState>, UrlPath(id): UrlPath<String>, b: Option<Json<Value>>) -> ApiResult {
    let existing = st.catalog.category(&id).ok_or_else(ApiError::not_found)?;
    let v = validate_category(&body(b), true).map_err(ApiError::bad)?;
    if existing.builtin && v.enabled == Some(false) {
        return Err(ApiError::bad("the info category cannot be switched off"));
    }
    let c = st.catalog.update_category(&id, v).await?.ok_or_else(ApiError::not_found)?;
    ok(category_json(&c, &st.catalog.category_counts()))
}

async fn reorder_categories(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    let ids: Vec<String> = b.get("ids").and_then(Value::as_array).ok_or_else(|| ApiError::bad("ids must be an array"))?.iter().map(|v| str_of(Some(v))).collect();
    st.catalog.reorder_categories(&ids).await?;
    ok(catalog_overview(&st))
}

async fn delete_category(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let category = st.catalog.category(&id).ok_or_else(ApiError::not_found)?;
    if category.builtin {
        return Err(ApiError::bad("the info category cannot be deleted"));
    }
    st.catalog.remove_category(&id).await?;
    // …and stop the plans that sold it from referencing a category that is gone.
    let plans_touched = st.store.plans_remove_category(&id).await?;
    tracing::info!(target: "admin", category_id = %id, name = %category.name, plans_touched, "category deleted");
    ok(json!({ "ok": true }))
}

async fn list_channels(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let params = parse_channel_query(&q);
    let (total, rows) = st.catalog.query_channels(&params);
    ok(json!({ "total": total, "page": params.page, "pageSize": params.page_size, "rows": rows.iter().map(channel_json).collect::<Vec<_>>() }))
}

async fn create_channel(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    let name = str_of(b.get("name")).trim().to_owned();
    let url = str_of(b.get("url"));
    let category = str_of(b.get("category_id"));
    if name.is_empty() {
        return Err(ApiError::bad("channel name required"));
    }
    if url.trim().is_empty() {
        return Err(ApiError::bad("stream URL required"));
    }
    if st.catalog.category(&category).is_none() {
        return Err(ApiError::bad("unknown category"));
    }
    let c = st.catalog.create_channel(&name, &url, &category, Attrs::new(), true).await?;
    created(channel_json(&c))
}

async fn update_channel(State(st): State<AppState>, UrlPath(id): UrlPath<String>, b: Option<Json<Value>>) -> ApiResult {
    if st.catalog.channel(&id).is_none() {
        return Err(ApiError::not_found());
    }
    let v = validate_channel_patch(&body(b), id == INFO_CHANNEL_ID).map_err(ApiError::bad)?;
    if v.category_id.as_ref().is_some_and(|c| st.catalog.category(c).is_none()) {
        return Err(ApiError::bad("unknown category"));
    }
    let c = st.catalog.update_channel(&id, &v).await?.ok_or_else(ApiError::not_found)?;
    ok(channel_json(&c))
}

/// `ids` targets a selection; `filter` targets everything matching the
/// admin's search, so "disable all 4 000 results" ships no ids.
async fn bulk_channels(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let mut b = body(b);
    let ids = b.as_object_mut().and_then(|m| m.remove("ids"));
    let filter = b.as_object_mut().and_then(|m| m.remove("filter"));
    let v = validate_channel_patch(&b, false).map_err(ApiError::bad)?;
    if v.category_id.as_ref().is_some_and(|c| st.catalog.category(c).is_none()) {
        return Err(ApiError::bad("unknown category"));
    }
    let targets: Vec<String> = match (ids, filter) {
        (Some(Value::Array(ids)), _) => ids.iter().map(|v| str_of(Some(v))).collect(),
        (_, Some(f)) if !f.is_null() => st.catalog.channel_ids_matching(&parse_channel_query(&query_map(&f))),
        _ => return Err(ApiError::bad("ids or filter required")),
    };
    let changed = st.catalog.bulk_update_channels(&targets, &v).await?;
    tracing::info!(target: "admin", changed, "channels bulk updated");
    ok(json!({ "ok": true, "changed": changed }))
}

async fn delete_channel(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    if !st.catalog.remove_channel(&id).await? {
        return Err(ApiError::not_found());
    }
    ok(json!({ "ok": true }))
}

/// One customer's view of the catalog: every category and a page of channels
/// with the global value, their pin and the effective result.
async fn user_channels(State(st): State<AppState>, UrlPath(id): UrlPath<i64>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let user = st.store.user(id).ok_or_else(ApiError::not_found)?;
    let locked = is_locked(&st, &user);
    let overrides = st.catalog.overrides(user.id);
    let plan = user.plan_category_set();
    let counts = st.catalog.category_counts();
    let categories: Vec<Value> = sorted_categories(&st)
        .iter()
        .map(|c| {
            let mut v = category_json(c, &counts);
            let personal = personal_category_json(c, overrides.categories.get(&c.id).copied(), locked, &plan);
            if let (Some(o), Some(p)) = (v.as_object_mut(), personal.as_object()) {
                o.extend(p.clone());
            }
            v
        })
        .collect();
    let category_effective: HashMap<String, bool> =
        categories.iter().map(|c| (str_of(c.get("id")), c["effective"].as_bool().unwrap_or(false))).collect();
    let params = parse_channel_query(&q);
    let (total, rows) = st.catalog.query_channels(&params);
    let has_media = st.media.loop_dir_for(&user).is_some();
    let visible = {
        let data = st.catalog.read();
        resolve_user_channels(&data, Resolve { overrides: Some(&overrides), locked, plan: Some(&plan) })
            .iter()
            .filter(|e| e.channel.id != INFO_MEDIA_CHANNEL_ID || has_media)
            .count()
    };
    let rows: Vec<Value> = rows
        .iter()
        .map(|ch| {
            let mut v = channel_json(ch);
            let personal = personal_row_json(ch.enabled, overrides.channels.get(&ch.id).copied(), locked, ch.builtin);
            let effective = personal["effective"].as_bool().unwrap_or(false) && category_effective.get(&ch.category_id).copied() != Some(false);
            if let (Some(o), Some(p)) = (v.as_object_mut(), personal.as_object()) {
                o.extend(p.clone());
                o.insert("effective".into(), json!(effective));
            }
            v
        })
        .collect();
    let status = account_status(user.active, user.expires_at.as_deref(), st.config.expiring_threshold_days, jiff::Timestamp::now(), &st.config.tz);
    ok(json!({
        "locked": locked,
        "status": status,
        "plan": { "id": user.plan_id, "name": user.plan_name, "categories": user.plan_categories },
        "categories": categories,
        "overrideCount": overrides.len(),
        "visibleCount": visible,
        "channels": { "total": total, "page": params.page, "pageSize": params.page_size, "rows": rows },
    }))
}

fn pin_map(v: Option<&Value>) -> Result<Vec<(String, Option<bool>)>, ApiError> {
    let Some(v) = v else { return Ok(Vec::new()) };
    let obj = v.as_object().ok_or_else(|| ApiError::bad("override values must be true, false or null"))?;
    obj.iter()
        .map(|(k, v)| match v {
            Value::Bool(b) => Ok((k.clone(), Some(*b))),
            Value::Null => Ok((k.clone(), None)),
            _ => Err(ApiError::bad("override values must be true, false or null")),
        })
        .collect()
}

/// Pin/unpin exceptions: `true`/`false` pins, `null` inherits again.
async fn patch_user_channels(State(st): State<AppState>, UrlPath(id): UrlPath<i64>, b: Option<Json<Value>>) -> ApiResult {
    let user = st.store.user(id).ok_or_else(ApiError::not_found)?;
    let b = body(b);
    let patch = OverridePatch { categories: pin_map(b.get("categories"))?, channels: pin_map(b.get("channels"))? };
    if patch.categories.iter().any(|(k, v)| k == INFO_CATEGORY_ID && *v == Some(false)) {
        return Err(ApiError::bad("the info category cannot be withheld from a customer"));
    }
    let before = st.catalog.overrides(user.id);
    let saved = st.catalog.patch_overrides(user.id, &patch).await?;
    tracing::info!(target: "admin", user_id = user.id, pinned = saved.len(), "customer channel access updated");

    // Tell the customer what this exception gave or took (not while locked:
    // their playlist is Информация either way until they renew).
    if !is_locked(&st, &user) {
        let plan = user.plan_category_set();
        let category_rows: Vec<Category> = patch.categories.iter().filter_map(|(id, _)| st.catalog.category(id)).collect();
        let channel_rows: Vec<Channel> = patch.channels.iter().filter_map(|(id, _)| st.catalog.channel(id)).collect();
        let visible_after = |cid: &str| {
            st.catalog.category(cid).is_some_and(|c| c.builtin || category_enabled_for(&c, saved.categories.get(cid).copied(), Some(&plan)))
        };
        let diff = diff_override_patch(&category_rows, &channel_rows, &before, &saved, Some(&plan), visible_after);
        let notifier = std::sync::Arc::clone(&st.notifier);
        tokio::spawn(async move {
            notifier.notify_content_change(&user, &diff, &user.plan_name).await;
        });
    }
    ok(json!({ "ok": true, "overrides": saved }))
}

async fn reset_user_channels(State(st): State<AppState>, UrlPath(id): UrlPath<i64>) -> ApiResult {
    let user = st.store.user(id).ok_or_else(ApiError::not_found)?;
    st.catalog.reset_overrides(user.id).await?;
    tracing::info!(target: "admin", user_id = user.id, "customer channel access reset to defaults");
    ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(id: &str, name: &str) -> Category {
        Category { id: id.into(), key: id.into(), name: name.into(), source_name: None, enabled: true, builtin: false, custom: false, sort: 0 }
    }

    #[test]
    fn source_validation() {
        let v = validate_source(&json!({"auto_refresh": true, "interval_hours": 6}), true).unwrap();
        assert_eq!((v.auto_refresh, v.interval_hours), (Some(true), Some(6.0)));
        assert_eq!(validate_source(&json!({"auto_refresh": "yes"}), true).unwrap_err(), "auto_refresh must be a boolean");
        assert!(validate_source(&json!({"interval_hours": 5}), true).unwrap_err().starts_with("interval_hours must be one of"));
        assert!(validate_source(&json!({"interval_hours": 0}), true).is_err());
        let v = validate_source(&json!({"name": " Провайдер ", "url": "https://p/list.m3u"}), false).unwrap();
        assert_eq!((v.name.as_deref(), v.url.as_deref()), (Some("Провайдер"), Some("https://p/list.m3u")));
        assert_eq!(validate_source(&json!({"name": "", "url": "https://p"}), false).unwrap_err(), "source name required");
        assert_eq!(validate_source(&json!({"name": "x", "url": "not a url"}), false).unwrap_err(), "playlist URL is not valid");
        assert_eq!(validate_source(&json!({"name": "x", "url": "file:///etc/passwd"}), false).unwrap_err(), "playlist URL must be http(s)");
        assert_eq!(validate_source(&json!({"enabled": false}), true).unwrap().enabled, Some(false));
    }

    #[test]
    fn category_channel_and_query_validation() {
        assert_eq!(validate_category(&json!({"name": "  Спорт "}), false).unwrap().name.as_deref(), Some("Спорт"));
        assert_eq!(validate_category(&json!({"name": "   "}), false).unwrap_err(), "category name required");
        assert_eq!(validate_category(&json!({"name": "x", "enabled": 1}), false).unwrap_err(), "enabled must be a boolean");
        assert_eq!(validate_channel_patch(&json!({}), false).unwrap_err(), "nothing to update");
        let p = validate_channel_patch(&json!({"name": " НТВ ", "enabled": false, "category_id": "c1"}), false).unwrap();
        assert_eq!((p.name.as_deref(), p.enabled, p.category_id.as_deref()), (Some("НТВ"), Some(false), Some("c1")));
        let q = parse_channel_query(&HashMap::new());
        assert_eq!((q.page, q.page_size, q.status.as_str()), (1, 50, "all"));
        let m = |k: &str, v: &str| HashMap::from([(k.to_owned(), v.to_owned())]);
        assert_eq!(parse_channel_query(&m("pageSize", "100000")).page_size, 500);
        assert_eq!(parse_channel_query(&m("page", "-3")).page, 1);
        assert_eq!(parse_channel_query(&m("status", "nonsense")).status, "all");
        assert_eq!(parse_channel_query(&m("status", "disabled")).status, "disabled");
    }

    #[test]
    fn personal_rows() {
        assert_eq!(personal_row_json(true, None, false, false), json!({"global_enabled": true, "override": null, "effective": true}));
        assert_eq!(personal_row_json(true, Some(false), false, false)["effective"], false);
        assert_eq!(personal_row_json(true, Some(true), true, false)["effective"], false);
        assert_eq!(personal_row_json(true, None, true, true)["effective"], true);
    }

    #[test]
    fn override_diff_reports_only_visible_changes() {
        let plan: HashSet<String> = ["sport".to_owned()].into();
        let (sport, kids) = (cat("sport", "Спорт"), cat("kids", "Дети"));
        let empty = UserOverrides::default();
        let mut pin = |id: &str, v: bool| {
            let mut o = UserOverrides::default();
            o.categories.insert(id.into(), v);
            o
        };
        assert!(diff_override_patch(&[sport.clone()], &[], &empty, &pin("sport", true), Some(&plan), |_| true).added_categories.is_empty());
        assert_eq!(diff_override_patch(&[kids], &[], &empty, &pin("kids", true), Some(&plan), |_| true).added_categories, ["Дети"]);
        assert_eq!(diff_override_patch(&[sport], &[], &empty, &pin("sport", false), Some(&plan), |_| true).removed_categories, ["Спорт"]);

        let ch = Channel {
            id: "c1".into(), key: "c1".into(), source_id: None, category_id: "kids".into(), name: "НТВ".into(),
            original_name: String::new(), upstream_group: None, url: String::new(), attrs: Attrs::new(), extras: vec![],
            enabled: false, builtin: false, custom: false, missing: false, sort: 0, added_at: None,
        };
        let mut on = UserOverrides::default();
        on.channels.insert("c1".into(), true);
        assert!(diff_override_patch(&[], &[ch.clone()], &empty, &on, Some(&plan), |_| false).added_channels.is_empty());
        assert_eq!(diff_override_patch(&[], &[ch], &empty, &on, None, |_| true).added_channels, ["НТВ"]);
    }

    #[test]
    fn views() {
        let counts = HashMap::from([("c1".to_owned(), Counts { total: 12, enabled: 9 })]);
        let v = category_json(&cat("c1", "Спорт"), &counts);
        assert_eq!((v["channels"].as_u64(), v["channels_enabled"].as_u64()), (Some(12), Some(9)));
        assert_eq!(category_json(&cat("zz", "X"), &counts)["channels"], 0);
    }
}
