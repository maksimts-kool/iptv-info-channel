//! The admin: login/logout, the SPA shell, and the JSON API under
//! `/admin/api` (auth + CSRF via `auth::require_admin`). The catalog and
//! media surfaces are separate routers merged into the same `/api`.
//!
//! Request validation and response view models are pure functions at the
//! top of this file. Mutations that change what a channel SHOWS re-encode in
//! the background (plan/branding/incident edits: all users; user edits: that
//! user); catalog edits never do.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock};

use axum::extract::{ConnectInfo, Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde_json::{Map, Value, json};

use super::api::{ApiError, ApiResult, body, created, is_date, num_of, ok, str_of};
use super::auth::{check_password, clear_cookie, csrf_token, require_admin, session_cookie};
use super::gateway::is_locked;
use super::playlist::user_stream_url;
use super::ratelimit::RateLimiter;
use super::stream::render_user_playlist;
use super::{AppState, client_ip};
use crate::core::util::{
    Period, account_status, add_period, days_left, format_date, format_price, local_date, local_date_string,
    parse_instant,
};
use crate::data::model::{DecoratedUser, Incident, Newsletter, Payment, Plan, Severity};
use crate::data::store::{IncidentFields, NewPlan, PlanPatch, UserPatch};
use crate::encode::channel::{spawn_regen, spawn_regen_all};
use crate::news::notices::{parse_cookie_header, serialize_cookies};
use crate::news::providernews::NewsPatch;
use crate::notify::notify::{ContentChange, newsletter_recipients, validate_newsletter, validate_subscription};
use crate::playlist::hls::is_hls_url;
use crate::playlist::model::{INFO_CHANNEL_ID, INFO_MEDIA_CHANNEL_ID};
use crate::render::status::{status_summary, with_provider_notices};

// ===========================================================================
// Pure view models + validation
// ===========================================================================

pub fn incident_json(i: &Incident) -> Value {
    let ends = i.ends_on.as_deref().filter(|e| !e.is_empty());
    json!({
        "id": i.id, "title": i.title, "severity": i.severity, "starts_on": i.starts_on, "ends_on": ends,
        "starts_pretty": format_date(i.starts_on.as_deref()), "ends_pretty": ends.map(|e| format_date(Some(e))),
        "ongoing": ends.is_none(), "note": i.note,
    })
}

/// Settings as handed to the browser: the provider-news credentials and the
/// (large) media channel document stay server-side.
pub fn public_settings(settings: &Map<String, Value>) -> Value {
    let mut out = settings.clone();
    out.remove("provider_news");
    out.remove("media_channel");
    Value::Object(out)
}

/// `PATCH /api/provider-news` body. An empty url = the default feed; the
/// cookie is normalised to a plain `a=1; b=2` header.
pub fn validate_provider_news(b: &Value) -> Result<NewsPatch, String> {
    let mut out = NewsPatch::default();
    match b.get("enabled") {
        None => {}
        Some(Value::Bool(v)) => out.enabled = Some(*v),
        Some(_) => return Err("enabled must be a boolean".into()),
    }
    if b.get("url").is_some() {
        let url = str_of(b.get("url")).trim().to_owned();
        if !url.is_empty() {
            let ok = url::Url::parse(&url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"));
            if !ok {
                return Err("url must be an http(s) URL".into());
            }
        }
        out.url = Some(url);
    }
    if b.get("cookie").is_some() {
        let cookie = serialize_cookies(&parse_cookie_header(&str_of(b.get("cookie"))));
        if cookie.len() > 8192 {
            return Err("cookie is too long".into());
        }
        out.cookie = Some(cookie);
    }
    if b.get("ai_key").is_some() {
        let key = str_of(b.get("ai_key")).trim().to_owned();
        if key.len() > 512 || key.chars().any(char::is_whitespace) {
            return Err("ai_key is not a valid API key".into());
        }
        out.ai_key = Some(key);
    }
    Ok(out)
}

/// A plan with its package resolved to category names (`features`, the key
/// the on-screen plan cards render).
pub fn plan_json(p: &Plan, names: &HashMap<String, String>) -> Value {
    json!({
        "id": p.id, "name": p.name, "price_cents": p.price_cents, "currency": p.currency,
        "billing_period": p.billing_period, "price": format_price(p.price_cents, &p.currency),
        "category_ids": p.category_ids,
        "features": p.category_ids.iter().filter_map(|id| names.get(id)).collect::<Vec<_>>(),
        "max_devices": p.max_devices, "sort": p.sort,
    })
}

pub fn decorate_user(st: &AppState, u: &DecoratedUser) -> Value {
    let status = account_status(u.active, u.expires_at.as_deref(), st.config.expiring_threshold_days, jiff::Timestamp::now(), &st.config.tz);
    let base = &st.config.public_base_url;
    json!({
        "id": u.id, "username": u.username, "token": u.token, "plan_id": u.plan_id, "plan_name": u.plan_name,
        "price": format_price(u.price_cents, &u.currency), "expires_at": u.expires_at,
        "expires_pretty": format_date(u.expires_at.as_deref()),
        "days_left": days_left(u.expires_at.as_deref(), jiff::Timestamp::now(), &st.config.tz),
        "active": u.active, "status": status, "status_label": status.label(), "status_color": status.color(),
        "max_devices": u.max_devices, "plan_max_devices": u.plan_max_devices, "device_limit": u.device_limit,
        "m3u_url": format!("{base}/u/{}/playlist.m3u", u.token),
        "hls_url": user_stream_url(&u.token, base),
    })
}

pub const MAX_DEVICES_CEILING: i64 = 100;

/// A whole number 0..=100 (0 = no limit). With `allow_null`, `null`/`''`
/// clears a personal override. `Ok(None)` = cleared.
pub fn parse_max_devices(v: &Value, allow_null: bool) -> Result<Option<i64>, String> {
    let empty = v.is_null() || v.as_str() == Some("");
    if empty {
        return if allow_null { Ok(None) } else { Err("max_devices must be a whole number".into()) };
    }
    let n = num_of(Some(v)).filter(|n| n.fract() == 0.0 && (0.0..=MAX_DEVICES_CEILING as f64).contains(n));
    n.map(|n| Some(n as i64)).ok_or_else(|| format!("max_devices must be a whole number from 0 to {MAX_DEVICES_CEILING}"))
}

/// Euros (as typed) -> integer cents.
pub fn parse_price_cents(v: Option<&Value>) -> Result<i64, String> {
    let empty = v.is_none_or(|v| v.is_null() || v.as_str() == Some(""));
    if empty {
        return Err("bad price".into());
    }
    let cents = num_of(v).map(|e| (e * 100.0).round()).filter(|c| c.is_finite() && *c >= 0.0);
    cents.map(|c| c as i64).ok_or_else(|| "bad price".into())
}

/// The category ids a plan grants; unknown ids are rejected so a stale admin
/// tab can't grant a deleted category.
pub fn parse_plan_categories(v: &Value, known: &HashSet<String>) -> Result<Vec<String>, String> {
    let list = v.as_array().ok_or_else(|| "category_ids must be an array".to_owned())?;
    let mut ids: Vec<String> = Vec::new();
    for id in list.iter().map(|x| str_of(Some(x)).trim().to_owned()).filter(|s| !s.is_empty()) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if let Some(bad) = ids.iter().find(|id| !known.contains(*id)) {
        return Err(format!("unknown category: {bad}"));
    }
    Ok(ids)
}

/// What a plan edit added to / took away from its customers.
pub fn plan_category_diff(before: &[String], after: &[String]) -> (Vec<String>, Vec<String>) {
    let added = after.iter().filter(|id| !before.contains(id)).cloned().collect();
    let removed = before.iter().filter(|id| !after.contains(id)).cloned().collect();
    (added, removed)
}

pub fn duplicate_plan_name(plans: &[Plan], name: &str, except: Option<&str>) -> bool {
    let n = name.trim().to_lowercase();
    plans.iter().any(|p| Some(p.id.as_str()) != except && p.name.trim().to_lowercase() == n)
}

const PAYMENT_PERIODS: [&str; 3] = ["day", "month", "year"];
const MAX_PAYMENT_UNITS: i64 = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentRequest {
    pub count: i64,
    pub period: String,
    pub from: String,
}

/// "Customer paid for N periods". The period defaults to the plan's own, so
/// the common case is just `{}`; a plan with no period is billed monthly.
pub fn validate_payment(b: &Value, plan: Option<&Plan>) -> Result<PaymentRequest, String> {
    let count = if b.get("count").is_none() { Some(1.0) } else { num_of(b.get("count")) };
    let count = count
        .filter(|c| c.fract() == 0.0 && *c >= 1.0 && *c <= MAX_PAYMENT_UNITS as f64)
        .ok_or_else(|| format!("count must be a whole number between 1 and {MAX_PAYMENT_UNITS}"))? as i64;
    let given = str_of(b.get("period"));
    let period = if given.is_empty() {
        plan.map(|p| p.billing_period.as_str()).filter(|p| PAYMENT_PERIODS.contains(p)).unwrap_or("month").to_owned()
    } else {
        given
    };
    if !PAYMENT_PERIODS.contains(&period.as_str()) {
        return Err(format!("period must be one of: {}", PAYMENT_PERIODS.join(", ")));
    }
    let from = match b.get("from") {
        None => "expiry".to_owned(),
        Some(v) => match v.as_str() {
            Some(f @ ("expiry" | "today")) => f.to_owned(),
            _ => return Err("from must be 'expiry' or 'today'".into()),
        },
    };
    Ok(PaymentRequest { count, period, from })
}

/// The new expiry a payment produces. Paid time stacks on what the customer
/// still has; a lapsed or open-ended account restarts from today.
pub fn payment_expiry(expires_at: Option<&str>, req: &PaymentRequest, today: &str) -> Option<String> {
    let current = expires_at.unwrap_or("");
    let base = if req.from == "today" || current.is_empty() || current < today { today } else { current };
    add_period(base, Period::parse(&req.period)?, req.count)
}

/// The plan's price for the periods paid, converted between month/year; a
/// payment in days has no fair price.
pub fn suggested_payment_cents(plan: Option<&Plan>, count: i64, period: &str) -> Option<i64> {
    let plan = plan?;
    let billed = if PAYMENT_PERIODS.contains(&plan.billing_period.as_str()) { plan.billing_period.as_str() } else { "month" };
    match (billed, period) {
        (b, p) if b == p => Some(plan.price_cents * count),
        ("month", "year") => Some(plan.price_cents * 12 * count),
        ("year", "month") => Some(((plan.price_cents * count) as f64 / 12.0).round() as i64),
        _ => None,
    }
}

/// The ledger fields: amount received (blank = the plan price) and a note.
pub fn validate_payment_record(b: &Value) -> Result<(Option<i64>, String), String> {
    let amount = match b.get("amount_eur") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        v => Some(parse_price_cents(v).map_err(|_| "bad amount".to_owned())?),
    };
    let note = str_of(b.get("note")).split_whitespace().collect::<Vec<_>>().join(" ");
    if note.chars().count() > 200 {
        return Err("note must be 200 characters or less".into());
    }
    Ok((amount, note))
}

pub fn payment_json(p: &Payment) -> Value {
    json!({
        "id": p.id, "at": p.at, "user_id": p.user_id, "username": p.username, "plan_name": p.plan_name,
        "count": p.count, "period": p.period, "from": p.from, "previous_expires_at": p.previous_expires_at,
        "expires_at": p.expires_at, "expires_pretty": format_date(p.expires_at.as_deref()),
        "amount_cents": p.amount_cents, "amount": p.amount_cents.map(|c| format_price(c, &p.currency)),
        "currency": p.currency, "note": p.note,
    })
}

/// This calendar month and the last 30 days (`today` is the local date).
pub fn payments_summary(payments: &[Payment], today: &str, tz: &jiff::tz::TimeZone) -> Value {
    let month = &today[..today.len().min(7)];
    let since = crate::core::util::parse_ymd(today).and_then(|d| d.checked_sub(jiff::Span::new().days(29)).ok());
    let local = |p: &Payment| parse_instant(&p.at).map(|t| local_date(t, tz));
    let this_month: Vec<&Payment> = payments.iter().filter(|p| local(p).is_some_and(|d| d.to_string().starts_with(month))).collect();
    let last30: Vec<&Payment> = payments.iter().filter(|p| local(p).zip(since).is_some_and(|(d, s)| d >= s)).collect();
    let sum = |l: &[&Payment]| l.iter().filter_map(|p| p.amount_cents).sum::<i64>();
    json!({
        "month_count": this_month.len(), "month_cents": sum(&this_month), "month_total": format_price(sum(&this_month), "EUR"),
        "last30_count": last30.len(), "last30_cents": sum(&last30), "last30_total": format_price(sum(&last30), "EUR"),
    })
}

pub fn newsletter_json(n: &Newsletter) -> Value {
    json!({
        "id": n.id, "subject": n.subject, "body": n.body, "important": n.important, "audience": n.audience,
        "status": if n.status.is_empty() { "sent" } else { n.status.as_str() },
        "recipients": n.recipients, "sent": n.sent, "failed": n.failed, "error": n.error,
        "created_at": n.created_at, "sent_at": n.sent_at,
    })
}

/// Incident create (full) or patch (partial).
pub fn validate_incident(b: &Value, partial: bool) -> Result<IncidentFields, String> {
    let mut out = IncidentFields::default();
    let has = |k: &str| b.get(k).is_some();
    if !partial || has("title") {
        let title = str_of(b.get("title")).trim().to_owned();
        if title.is_empty() {
            return Err("incident title required".into());
        }
        if title.chars().count() > 100 {
            return Err("title must be 100 characters or less".into());
        }
        out.title = Some(title);
    }
    if !partial || has("severity") {
        let sev = str_of(b.get("severity"));
        if !matches!(Severity::parse(&sev), Some(Severity::Degraded | Severity::Outage)) {
            return Err("bad severity".into());
        }
        out.severity = Some(sev);
    }
    if !partial || has("starts_on") {
        let start = str_of(b.get("starts_on"));
        if !is_date(&start) {
            return Err("bad starts_on (YYYY-MM-DD)".into());
        }
        out.starts_on = Some(Some(start));
    }
    if has("ends_on") {
        let end = str_of(b.get("ends_on"));
        if !end.is_empty() && !is_date(&end) {
            return Err("bad ends_on (YYYY-MM-DD)".into());
        }
        out.ends_on = Some((!end.is_empty()).then_some(end));
    } else if !partial {
        out.ends_on = Some(None);
    }
    if has("note") {
        let note = str_of(b.get("note")).trim().to_owned();
        if note.chars().count() > 280 {
            return Err("note must be 280 characters or less".into());
        }
        out.note = Some(note);
    } else if !partial {
        out.note = Some(String::new());
    }
    Ok(out)
}

// ===========================================================================
// HTTP
// ===========================================================================

static LOGIN_LIMIT: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter::new(15 * 60 * 1000, 10));

/// `/admin` (SPA shell + static assets + login) and `/admin/api`.
pub fn router(st: &AppState) -> Router<AppState> {
    let api = Router::new()
        .route("/state", get(state))
        .route("/generation-status", get(generation_status))
        .route("/users", post(create_user))
        .route("/users/{id}", patch(update_user).delete(delete_user))
        .route("/users/{id}/payment", post(record_payment))
        .route("/users/{id}/token", post(regenerate_token))
        .route("/users/{id}/regenerate", post(regenerate_user))
        .route("/users/{id}/playlist", get(user_playlist))
        .route("/users/{id}/devices", get(user_devices))
        .route("/users/{id}/devices/reset", post(reset_devices))
        .route("/users/{id}/subscriber", put(put_subscriber).delete(delete_subscriber))
        .route("/payments", get(list_payments))
        .route("/payments/{id}", axum::routing::delete(undo_payment))
        .route("/devices", get(all_devices))
        .route("/plans", post(create_plan))
        .route("/plans/{id}", patch(update_plan).delete(delete_plan))
        .route("/settings", patch(update_settings))
        .route("/provider-news", patch(update_provider_news))
        .route("/provider-news/refresh", post(refresh_provider_news))
        .route("/gateway", patch(toggle_gateway))
        .route("/incidents", post(create_incident))
        .route("/incidents/{id}", patch(update_incident).delete(delete_incident))
        .route("/notifications", get(notifications).patch(toggle_notifications))
        .route("/notifications/test", post(test_email))
        .route("/newsletters", get(list_newsletters).post(send_newsletter))
        .route("/newsletters/test", post(test_newsletter))
        .route("/newsletters/{id}", axum::routing::delete(delete_newsletter))
        .route("/regenerate-all", post(regenerate_all))
        .merge(super::catalog::router())
        .layer(axum::middleware::from_fn_with_state(st.clone(), require_admin));

    Router::new()
        .route("/", get(spa_shell))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .nest_service("/static", tower_http::services::ServeDir::new(st.config.public_dir.clone()))
        .nest("/api", api)
}

/// The SPA shell, with no server-side auth gate: the app renders its own
/// login view on a 401.
async fn spa_shell(State(st): State<AppState>) -> Response {
    match tokio::fs::read_to_string(st.config.public_dir.join("index.html")).await {
        Ok(html) => Html(html).into_response(),
        Err(_) => Html(
            "<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:system-ui;padding:2rem\"><h1>Admin UI not built</h1>\
             <p>Build the Docker image (it runs the Vite build) or run <code>npm run dev</code> in <code>frontend/</code> for local development.</p>",
        )
        .into_response(),
    }
}

async fn login(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, raw: axum::body::Bytes) -> Response {
    let ip = client_ip(&headers, peer, st.config.trust_proxy);
    let is_json = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|c| c.contains("json"));
    if LOGIN_LIMIT.hit(&format!("login:{ip}")) {
        tracing::warn!(target: "admin", remote = %ip, "login rate limited");
        return if is_json {
            ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many attempts, try again later").into_response()
        } else {
            Redirect::to("/admin/login?error=rate").into_response()
        };
    }
    let password = if is_json {
        serde_json::from_slice::<Value>(&raw).ok().map(|v| str_of(v.get("password"))).unwrap_or_default()
    } else {
        form_urlencoded::parse(&raw).find(|(k, _)| k == "password").map(|(_, v)| v.into_owned()).unwrap_or_default()
    };
    if !check_password(&st.config, &password) {
        tracing::warn!(target: "admin", remote = %ip, "login failed");
        return if is_json { ApiError::new(StatusCode::UNAUTHORIZED, "wrong password").into_response() } else { Redirect::to("/admin/login?error=1").into_response() };
    }
    let mut res = if is_json { Json(json!({ "ok": true })).into_response() } else { Redirect::to("/admin").into_response() };
    res.headers_mut().insert(header::SET_COOKIE, session_cookie(&st.config));
    res
}

async fn logout() -> Response {
    let mut res = Json(json!({ "ok": true })).into_response();
    res.headers_mut().insert(header::SET_COOKIE, clear_cookie());
    res
}

/// Non-builtin categories: Информация is unconditional, so never sold.
fn category_names(st: &AppState) -> HashMap<String, String> {
    st.catalog.categories().into_iter().filter(|c| !c.builtin).map(|c| (c.id, c.name)).collect()
}

async fn state(State(st): State<AppState>) -> ApiResult {
    let incidents = st.store.incidents();
    let payments = st.store.payments();
    let override_counts = st.catalog.override_counts();
    let names = category_names(&st);
    let today = local_date_string(jiff::Timestamp::now(), &st.config.tz);
    let catalog = st.catalog.read();
    let live: Vec<_> = catalog.channels.iter().filter(|c| !c.missing).collect();
    let users: Vec<Value> = st
        .store
        .users()
        .iter()
        .map(|u| {
            let mut v = decorate_user(&st, u);
            v["personal_overrides"] = json!(override_counts.get(&u.id).copied().unwrap_or(0));
            v["devices_active"] = json!(st.gateway.device_count(u.id));
            v
        })
        .collect();
    let mut summary = payments_summary(&payments, &today, &st.config.tz);
    summary["recent"] = json!(payments.iter().take(6).map(payment_json).collect::<Vec<_>>());
    let status = with_provider_notices(status_summary(&incidents, jiff::Timestamp::now(), &st.config.tz, 90), &st.news.current_notices(), &st.config.tz);
    ok(json!({
        "csrfToken": csrf_token(&st.config),
        "publicBaseUrl": st.config.public_base_url,
        "expiringThresholdDays": st.config.expiring_threshold_days,
        "statusSlideEnabled": st.config.status_slide.enabled,
        "notify": { "enabled": st.config.notify_enabled() },
        "gateway": { "enabled": st.config.gateway_enabled(), "device_idle_seconds": st.config.gateway.device_idle_seconds },
        "settings": public_settings(&st.store.settings()),
        "providerNews": st.news.view(),
        "plans": st.store.plans().iter().map(|p| plan_json(p, &names)).collect::<Vec<_>>(),
        // Headline numbers only: the rows are paged through /api/catalog/channels.
        "catalog": {
            "sources": catalog.sources.len(),
            "categories": catalog.categories.len(),
            "channels": live.len(),
            "enabled": live.iter().filter(|c| c.enabled).count(),
            // Only HLS channels can be gated; the rest stay direct.
            "gateable": live.iter().filter(|c| !c.builtin && is_hls_url(&c.url)).count(),
            "direct": live.iter().filter(|c| !c.builtin && !is_hls_url(&c.url)).count(),
        },
        "users": users,
        "subscribers": st.store.subscribers().iter().map(|s| json!({ "user_id": s.user_id, "email": s.email, "options": s.options, "verified": s.verified })).collect::<Vec<_>>(),
        "incidents": incidents.iter().map(incident_json).collect::<Vec<_>>(),
        "builtinChannels": catalog.channels.iter().filter(|c| c.id == INFO_CHANNEL_ID || c.id == INFO_MEDIA_CHANNEL_ID)
            .map(|c| json!({ "id": c.id, "name": c.name, "enabled": c.enabled })).collect::<Vec<_>>(),
        "payments": summary,
        "media": st.media.status_json(),
        "newsletters": { "last": st.store.newsletters().first().map(newsletter_json) },
        "status": status,
    }))
}

async fn generation_status(State(st): State<AppState>) -> ApiResult {
    ok(st.channels.generation_status())
}

fn user_or_404(st: &AppState, id: i64) -> Result<DecoratedUser, ApiError> {
    st.store.user(id).ok_or_else(ApiError::not_found)
}

fn spawn_renewal(st: &AppState, user: DecoratedUser) {
    let notifier = Arc::clone(&st.notifier);
    tokio::spawn(async move { notifier.notify_renewal(&user).await });
}

/// `expires_at` from a body: absent = leave, null/'' = clear, else a date.
fn expires_field(b: &Value) -> Result<Option<Option<String>>, ApiError> {
    match b.get("expires_at") {
        None => Ok(None),
        Some(v) => {
            let s = str_of(Some(v));
            if s.is_empty() {
                Ok(Some(None))
            } else if is_date(&s) {
                Ok(Some(Some(s)))
            } else {
                Err(ApiError::bad("bad expires_at (YYYY-MM-DD)"))
            }
        }
    }
}

async fn create_user(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    let (username, plan_id) = (str_of(b.get("username")), str_of(b.get("plan_id")));
    if username.trim().is_empty() || plan_id.is_empty() {
        return Err(ApiError::bad("username and plan_id required"));
    }
    if st.store.plan(&plan_id).is_none() {
        return Err(ApiError::bad("unknown plan_id"));
    }
    let expires = expires_field(&b)?.flatten();
    let active = b.get("active").is_none_or(crate::notify::notify::truthy);
    let u = st.store.create_user(username, plan_id.clone(), expires, active, None).await?;
    tracing::info!(target: "admin", user_id = u.id, username = %u.username, %plan_id, "user created");
    spawn_regen(&st.channels, u.id, "admin user created");
    created(decorate_user(&st, &u))
}

async fn update_user(State(st): State<AppState>, UrlPath(id): UrlPath<i64>, b: Option<Json<Value>>) -> ApiResult {
    let before = user_or_404(&st, id)?;
    let b = body(b);
    let plan_id = b.get("plan_id").map(|v| str_of(Some(v))).filter(|p| !p.is_empty());
    if plan_id.as_ref().is_some_and(|p| st.store.plan(p).is_none()) {
        return Err(ApiError::bad("unknown plan_id"));
    }
    let max_devices = match b.get("max_devices") {
        None => None,
        Some(v) => Some(parse_max_devices(v, true).map_err(ApiError::bad)?),
    };
    let patch = UserPatch {
        username: b.get("username").map(|v| str_of(Some(v))),
        plan_id: plan_id.clone(),
        expires_at: expires_field(&b)?,
        active: b.get("active").map(crate::notify::notify::truthy),
        max_devices,
    };
    let renewed_field = patch.expires_at.is_some();
    let u = st.store.update_user(id, patch).await?.ok_or_else(ApiError::not_found)?;
    tracing::info!(target: "admin", user_id = u.id, username = %u.username, "user updated");
    spawn_regen(&st.channels, u.id, "admin user updated");
    // Renewal: the expiry moved later — mandatory notice.
    if renewed_field && before.expires_at.is_some() && u.expires_at.is_some() && u.expires_at > before.expires_at {
        spawn_renewal(&st, u.clone());
    }
    ok(decorate_user(&st, &u))
}

/// Push the expiry out by N billing periods and write a ledger row. Its own
/// endpoint so a payment bot can call it with `{}`.
async fn record_payment(State(st): State<AppState>, UrlPath(id): UrlPath<i64>, b: Option<Json<Value>>) -> ApiResult {
    let user = user_or_404(&st, id)?;
    let b = body(b);
    let plan = st.store.plan(&user.plan_id);
    let req = validate_payment(&b, plan.as_ref()).map_err(ApiError::bad)?;
    let (amount, note) = validate_payment_record(&b).map_err(ApiError::bad)?;
    let today = local_date_string(jiff::Timestamp::now(), &st.config.tz);
    let expires = payment_expiry(user.expires_at.as_deref(), &req, &today).ok_or_else(|| ApiError::bad("could not compute the new expiry date"))?;
    let updated = st
        .store
        .update_user(id, UserPatch { expires_at: Some(Some(expires.clone())), ..UserPatch::default() })
        .await?
        .ok_or_else(ApiError::not_found)?;
    let amount = amount.or_else(|| suggested_payment_cents(plan.as_ref(), req.count, &req.period));
    let payment = st
        .store
        .add_payment(Payment {
            user_id: id,
            username: updated.username.clone(),
            plan_id: user.plan_id.clone(),
            plan_name: user.plan_name.clone(),
            count: req.count,
            period: req.period.clone(),
            from: req.from.clone(),
            previous_expires_at: user.expires_at.clone(),
            expires_at: Some(expires.clone()),
            amount_cents: amount,
            currency: plan.as_ref().map_or_else(|| "EUR".to_owned(), |p| p.currency.clone()),
            note,
            ..Payment::default()
        })
        .await?;
    tracing::info!(target: "admin", user_id = id, count = req.count, period = %req.period, expires_at = %expires, payment_id = %payment.id, "payment recorded");
    spawn_regen(&st.channels, id, "admin payment recorded");
    if user.expires_at.as_ref().is_none_or(|e| expires > *e) {
        spawn_renewal(&st, updated.clone());
    }
    ok(json!({
        "ok": true, "previous_expires_at": user.expires_at, "count": req.count, "period": req.period, "from": req.from,
        "payment": payment_json(&payment), "user": decorate_user(&st, &updated),
    }))
}

async fn list_payments(State(st): State<AppState>) -> ApiResult {
    let payments = st.store.payments();
    let today = local_date_string(jiff::Timestamp::now(), &st.config.tz);
    ok(json!({ "payments": payments.iter().map(payment_json).collect::<Vec<_>>(), "summary": payments_summary(&payments, &today, &st.config.tz) }))
}

/// Undo a mistaken payment: only the customer's LATEST one, and only while
/// their expiry is still the date it set.
async fn undo_payment(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let payment = st.store.payment(&id).ok_or_else(ApiError::not_found)?;
    let user = st.store.user(payment.user_id);
    if let Some(u) = &user {
        let latest = st.store.last_payment_for(u.id).is_some_and(|p| p.id == payment.id);
        if !latest || u.expires_at != payment.expires_at {
            return Err(ApiError::conflict("отменить можно только последнюю оплату клиента, пока дата окончания не менялась"));
        }
        st.store.update_user(u.id, UserPatch { expires_at: Some(payment.previous_expires_at.clone()), ..UserPatch::default() }).await?;
        spawn_regen(&st.channels, u.id, "admin payment undone");
    }
    st.store.remove_payment(&payment.id).await?;
    tracing::info!(target: "admin", payment_id = %payment.id, user_id = payment.user_id, "payment undone");
    let user = user.and_then(|u| st.store.user(u.id)).map(|u| decorate_user(&st, &u));
    ok(json!({ "ok": true, "user": user }))
}

/// A new token invalidates the old playlist link.
async fn regenerate_token(State(st): State<AppState>, UrlPath(id): UrlPath<i64>) -> ApiResult {
    user_or_404(&st, id)?;
    let u = st.store.regenerate_token(id).await?.ok_or_else(ApiError::not_found)?;
    st.gateway.forget(id);
    tracing::info!(target: "admin", user_id = u.id, username = %u.username, "user access token regenerated");
    spawn_regen(&st.channels, u.id, "admin access token regenerated");
    ok(decorate_user(&st, &u))
}

async fn regenerate_user(State(st): State<AppState>, UrlPath(id): UrlPath<i64>) -> ApiResult {
    let u = user_or_404(&st, id)?;
    tracing::info!(target: "admin", user_id = id, username = %u.username, "manual user regeneration requested");
    st.channels.generate_for_user(id, "admin manual regeneration", false).await.map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    ok(json!({ "ok": true }))
}

async fn delete_user(State(st): State<AppState>, UrlPath(id): UrlPath<i64>) -> ApiResult {
    user_or_404(&st, id)?;
    // Pins and the subscriber row go with the account (FK cascade).
    st.store.remove_user(id).await?;
    st.catalog.reset_overrides(id).await?;
    st.channels.remove_user_hls(id);
    st.gateway.forget(id);
    tracing::info!(target: "admin", user_id = id, "user deleted");
    ok(json!({ "ok": true }))
}

/// The exact `.m3u` this customer's player receives.
async fn user_playlist(State(st): State<AppState>, UrlPath(id): UrlPath<i64>) -> ApiResult {
    let u = user_or_404(&st, id)?;
    ok(json!({ "text": render_user_playlist(&st, &u, "") }))
}

async fn user_devices(State(st): State<AppState>, UrlPath(id): UrlPath<i64>) -> ApiResult {
    let u = user_or_404(&st, id)?;
    ok(json!({
        "limit": u.device_limit, "plan_limit": u.plan_max_devices, "override": u.max_devices,
        "idle_seconds": st.config.gateway.device_idle_seconds, "gateway_enabled": st.config.gateway_enabled(),
        "devices": st.gateway.devices_of(&u),
    }))
}

/// Free stale slots; anything still playing re-claims its slot on refresh.
async fn reset_devices(State(st): State<AppState>, UrlPath(id): UrlPath<i64>) -> ApiResult {
    user_or_404(&st, id)?;
    st.gateway.forget(id);
    tracing::info!(target: "admin", user_id = id, "device slots reset");
    ok(json!({ "ok": true }))
}

async fn all_devices(State(st): State<AppState>) -> ApiResult {
    let clients: Vec<Value> = st
        .store
        .users()
        .iter()
        .filter_map(|u| {
            let devices = st.gateway.devices_of(u);
            (!devices.is_empty()).then(|| json!({ "user_id": u.id, "username": u.username, "plan_name": u.plan_name, "limit": u.device_limit, "devices": devices }))
        })
        .collect();
    ok(json!({ "gateway_enabled": st.config.gateway_enabled(), "idle_seconds": st.config.gateway.device_idle_seconds, "clients": clients }))
}

fn validate_plan_name(name: &str, plans: &[Plan], except: Option<&str>) -> Result<String, ApiError> {
    let clean = name.trim().to_owned();
    if clean.is_empty() {
        return Err(ApiError::bad("plan name required"));
    }
    if clean.chars().count() > 80 {
        return Err(ApiError::bad("plan name must be 80 characters or less"));
    }
    if duplicate_plan_name(plans, &clean, except) {
        return Err(ApiError::conflict("a plan with this name already exists"));
    }
    Ok(clean)
}

fn billing_period(v: Option<&Value>) -> Result<String, ApiError> {
    let p = str_of(v);
    if ["", "month", "year"].contains(&p.as_str()) { Ok(p) } else { Err(ApiError::bad("bad billing_period")) }
}

/// Expired accounts show every plan, so plan edits rebuild all streams.
async fn create_plan(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    let name = validate_plan_name(&str_of(b.get("name")), &st.store.plans(), None)?;
    let price = parse_price_cents(b.get("price_eur")).map_err(ApiError::bad)?;
    let period = billing_period(b.get("billing_period"))?;
    let known: HashSet<String> = category_names(&st).into_keys().collect();
    let categories = parse_plan_categories(b.get("category_ids").unwrap_or(&json!([])), &known).map_err(ApiError::bad)?;
    let max = parse_max_devices(b.get("max_devices").unwrap_or(&json!(0)), false).map_err(ApiError::bad)?.unwrap_or(0);
    let plan = st
        .store
        .create_plan(NewPlan { name, price_cents: price, currency: "EUR".into(), billing_period: period, category_ids: categories, max_devices: max })
        .await?;
    tracing::info!(target: "admin", plan_id = %plan.id, name = %plan.name, categories = plan.category_ids.len(), "plan created");
    spawn_regen_all(&st.channels, "admin plan created");
    created(plan_json(&plan, &category_names(&st)))
}

async fn update_plan(State(st): State<AppState>, UrlPath(id): UrlPath<String>, b: Option<Json<Value>>) -> ApiResult {
    let plan = st.store.plan(&id).ok_or_else(ApiError::not_found)?;
    let b = body(b);
    let mut patch = PlanPatch::default();
    if let Some(v) = b.get("max_devices") {
        patch.max_devices = Some(parse_max_devices(v, false).map_err(ApiError::bad)?.unwrap_or(0));
    }
    if b.get("billing_period").is_some() {
        patch.billing_period = Some(billing_period(b.get("billing_period"))?);
    }
    if b.get("price_eur").is_some() {
        patch.price_cents = Some(parse_price_cents(b.get("price_eur")).map_err(ApiError::bad)?);
    }
    if b.get("name").is_some() {
        patch.name = Some(validate_plan_name(&str_of(b.get("name")), &st.store.plans(), Some(&id))?);
    }
    if let Some(v) = b.get("category_ids") {
        let known: HashSet<String> = category_names(&st).into_keys().collect();
        patch.category_ids = Some(parse_plan_categories(v, &known).map_err(ApiError::bad)?);
    }
    let categories_changed = patch.category_ids.is_some();
    let updated = st.store.update_plan(&id, patch).await?.ok_or_else(ApiError::not_found)?;
    tracing::info!(target: "admin", plan_id = %id, "plan updated");
    spawn_regen_all(&st.channels, "admin plan updated");
    if categories_changed {
        let (added, removed) = plan_category_diff(&plan.category_ids, &updated.category_ids);
        if !added.is_empty() || !removed.is_empty() {
            notify_plan_category_change(&st, &updated, &added, &removed);
        }
    }
    ok(plan_json(&updated, &category_names(&st)))
}

/// Mail the customers of a plan whose package changed — except those with a
/// personal pin on the category (the plan edit changed nothing for them) and
/// locked accounts (they see only Информация either way).
fn notify_plan_category_change(st: &AppState, plan: &Plan, added: &[String], removed: &[String]) {
    let visible: HashMap<String, String> = st.catalog.categories().into_iter().filter(|c| !c.builtin && c.enabled).map(|c| (c.id, c.name)).collect();
    let jobs: Vec<(DecoratedUser, ContentChange)> = st
        .store
        .users()
        .into_iter()
        .filter(|u| u.plan_id == plan.id && !is_locked(st, u))
        .map(|u| {
            let pins = st.catalog.overrides(u.id).categories;
            let names = |ids: &[String]| ids.iter().filter(|id| !pins.contains_key(*id)).filter_map(|id| visible.get(id).cloned()).collect::<Vec<_>>();
            let change = ContentChange { added_categories: names(added), removed_categories: names(removed), ..ContentChange::default() };
            (u, change)
        })
        .collect();
    let notifier = Arc::clone(&st.notifier);
    let plan_name = plan.name.clone();
    tokio::spawn(async move {
        for (user, change) in jobs {
            notifier.notify_content_change(&user, &change, &plan_name).await;
        }
    });
}

/// Only unused plans can go, so every customer keeps a valid plan.
async fn delete_plan(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let plan = st.store.plan(&id).ok_or_else(ApiError::not_found)?;
    let assigned = st.store.users().iter().filter(|u| u.plan_id == id).count();
    if assigned > 0 {
        return Err(ApiError::conflict(format!("plan is assigned to {assigned} user{}", if assigned == 1 { "" } else { "s" })));
    }
    st.store.remove_plan(&id).await?;
    tracing::info!(target: "admin", plan_id = %id, name = %plan.name, "plan deleted");
    spawn_regen_all(&st.channels, "admin plan deleted");
    ok(json!({ "ok": true }))
}

async fn update_settings(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    for key in ["brand_name", "tagline"] {
        if let Some(v) = b.get(key) {
            st.store.set_setting(key, v.clone()).await?;
        }
    }
    tracing::info!(target: "admin", "branding settings updated");
    spawn_regen_all(&st.channels, "admin branding updated");
    ok(public_settings(&st.store.settings()))
}

/// Rebuild the streams only if what the status slide shows changed.
fn provider_news_response(st: &AppState) -> ApiResult {
    let regenerating = st.news.consume_shown_change() && st.config.status_slide.enabled;
    if regenerating {
        spawn_regen_all(&st.channels, "provider service notices changed");
    }
    let mut view = st.news.view();
    view["regenerating"] = json!(regenerating);
    ok(view)
}

async fn update_provider_news(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let patch = validate_provider_news(&body(b)).map_err(ApiError::bad)?;
    let wants_fetch = patch.enabled == Some(true) || patch.url.is_some() || patch.cookie.as_ref().is_some_and(|c| !c.is_empty()) || patch.ai_key.is_some();
    st.news.update_settings(patch).await;
    tracing::info!(target: "admin", "provider news settings updated");
    if st.news.settings().enabled && wants_fetch {
        st.news.refresh().await;
    }
    provider_news_response(&st)
}

async fn refresh_provider_news(State(st): State<AppState>) -> ApiResult {
    st.news.refresh().await;
    provider_news_response(&st)
}

/// Which URL NEW playlists carry. No regeneration: the `.m3u` is per request.
async fn toggle_gateway(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let Some(enabled) = body(b).get("enabled").and_then(Value::as_bool) else { return Err(ApiError::bad("enabled must be a boolean")) };
    st.store.set_setting("gateway_enabled", json!(enabled)).await?;
    st.config.set_gateway_enabled(enabled);
    tracing::info!(target: "admin", enabled, "stream gateway toggled");
    ok(json!({ "enabled": enabled }))
}

async fn create_incident(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let v = validate_incident(&body(b), false).map_err(ApiError::bad)?;
    if let (Some(Some(end)), Some(Some(start))) = (&v.ends_on, &v.starts_on)
        && end < start
    {
        return Err(ApiError::bad("ends_on cannot be before starts_on"));
    }
    let inc = st.store.create_incident(v).await?;
    tracing::info!(target: "admin", incident_id = %inc.id, severity = %inc.severity, "incident created");
    spawn_regen_all(&st.channels, "admin incident created");
    let (notifier, i) = (Arc::clone(&st.notifier), inc.clone());
    tokio::spawn(async move { notifier.notify_server_status(&i, false).await });
    created(incident_json(&inc))
}

async fn update_incident(State(st): State<AppState>, UrlPath(id): UrlPath<String>, b: Option<Json<Value>>) -> ApiResult {
    let existing = st.store.incident(&id).ok_or_else(ApiError::not_found)?;
    let v = validate_incident(&body(b), true).map_err(ApiError::bad)?;
    let start = v.starts_on.clone().flatten().or_else(|| existing.starts_on.clone());
    let end = v.ends_on.clone().unwrap_or_else(|| existing.ends_on.clone());
    if let (Some(e), Some(s)) = (end, start)
        && e < s
    {
        return Err(ApiError::bad("ends_on cannot be before starts_on"));
    }
    let inc = st.store.update_incident(&id, v).await?.ok_or_else(ApiError::not_found)?;
    tracing::info!(target: "admin", incident_id = %inc.id, "incident updated");
    spawn_regen_all(&st.channels, "admin incident updated");
    // First time an ongoing incident gets an end date -> "service restored".
    if existing.ends_on.is_none() && inc.ends_on.is_some() {
        let (notifier, i) = (Arc::clone(&st.notifier), inc.clone());
        tokio::spawn(async move { notifier.notify_server_status(&i, true).await });
    }
    ok(incident_json(&inc))
}

async fn delete_incident(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    if !st.store.remove_incident(&id).await? {
        return Err(ApiError::not_found());
    }
    tracing::info!(target: "admin", incident_id = %id, "incident deleted");
    spawn_regen_all(&st.channels, "admin incident deleted");
    ok(json!({ "ok": true }))
}

fn notifications_view(st: &AppState) -> Value {
    let subs: HashMap<i64, _> = st.store.subscribers().into_iter().map(|s| (s.user_id, s)).collect();
    let cfg = &st.config.notify;
    let list: Vec<Value> = st
        .store
        .users()
        .iter()
        .filter_map(|u| subs.get(&u.id).map(|s| json!({ "user_id": u.id, "username": u.username, "email": s.email, "options": s.options, "verified": s.verified, "created_at": s.created_at })))
        .collect();
    json!({
        "enabled": st.config.notify_enabled(),
        "provider": match cfg.provider { crate::config::MailProvider::Brevo => "brevo", crate::config::MailProvider::Resend => "resend" },
        "dryRun": cfg.dry_run,
        "configured": cfg.dry_run || (!cfg.api_key.is_empty() && !cfg.from.is_empty()),
        "subscribers": list,
        "log": st.store.notify_log_recent(30),
    })
}

async fn notifications(State(st): State<AppState>) -> ApiResult {
    ok(notifications_view(&st))
}

/// The QR on the intro slide appears/disappears, so this rebuilds everything.
async fn toggle_notifications(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let Some(enabled) = body(b).get("enabled").and_then(Value::as_bool) else { return Err(ApiError::bad("enabled must be a boolean")) };
    st.store.set_setting("notify_enabled", json!(enabled)).await?;
    st.config.set_notify_enabled(enabled);
    tracing::info!(target: "admin", enabled, "notifications toggled");
    spawn_regen_all(&st.channels, "admin notifications toggled");
    ok(json!({ "enabled": enabled }))
}

async fn test_email(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    st.notifier.send_test(&str_of(body(b).get("email"))).await.map_err(|e| ApiError::bad(e.to_string()))?;
    ok(json!({ "ok": true }))
}

/// Admin-managed subscriber: an unchanged verified address stays verified; a
/// new/changed one gets the verification link, or is marked verified at once
/// with `verified: true` (the admin vouches for it).
async fn put_subscriber(State(st): State<AppState>, UrlPath(id): UrlPath<i64>, b: Option<Json<Value>>) -> ApiResult {
    let user = user_or_404(&st, id)?;
    let b = body(b);
    let (email, options) = validate_subscription(&b).map_err(ApiError::bad)?;
    let vouch = b.get("verified") == Some(&Value::Bool(true));
    let mut sub = st.store.upsert_subscriber(id, &email, &options).await?;
    let mut sent_verification = false;
    if vouch {
        if !sub.verified {
            sub = st.store.mark_verified(id).await?.unwrap_or(sub);
        }
    } else if !sub.verified {
        let (notifier, u, s) = (Arc::clone(&st.notifier), user.clone(), sub.clone());
        tokio::spawn(async move {
            notifier.send_verification(&u, &s).await;
        });
        sent_verification = true;
    }
    tracing::info!(target: "admin", user_id = id, verified = sub.verified, vouch, "subscriber saved");
    ok(json!({ "ok": true, "email": sub.email, "options": sub.options, "verified": sub.verified, "sentVerification": sent_verification }))
}

async fn delete_subscriber(State(st): State<AppState>, UrlPath(id): UrlPath<i64>) -> ApiResult {
    user_or_404(&st, id)?;
    st.store.remove_subscriber(id).await?;
    tracing::info!(target: "admin", user_id = id, "subscriber removed");
    ok(json!({ "ok": true }))
}

async fn list_newsletters(State(st): State<AppState>) -> ApiResult {
    ok(json!({ "newsletters": st.store.newsletters().iter().map(newsletter_json).collect::<Vec<_>>() }))
}

/// Send now: answers at once with the newsletter `sending`; the dispatch
/// runs in the background and the counts land as it goes.
async fn send_newsletter(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let draft = validate_newsletter(&body(b)).map_err(ApiError::bad)?;
    if !st.config.notify_enabled() {
        return Err(ApiError::conflict("уведомления выключены — включите их, чтобы отправить рассылку"));
    }
    let (users, subs) = (st.store.users(), st.store.subscribers());
    let recipients = newsletter_recipients(draft.audience.as_ref(), &users, &subs).len();
    if recipients == 0 {
        return Err(ApiError::conflict("нет получателей: никто из выбранных клиентов не подписан на новости"));
    }
    let n = st
        .store
        .create_newsletter(Newsletter {
            subject: draft.subject.clone(),
            body: draft.body.clone(),
            important: draft.important,
            audience: draft.audience.clone(),
            status: "sending".into(),
            recipients,
            ..Newsletter::default()
        })
        .await?;
    tracing::info!(target: "admin", newsletter_id = %n.id, recipients, "newsletter sending");
    let (store, notifier, id) = (Arc::clone(&st.store), Arc::clone(&st.notifier), n.id.clone());
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let progress_store = Arc::clone(&store);
        let progress_id = id.clone();
        let writer = tokio::spawn(async move {
            while let Some(c) = rx.recv().await {
                let c: crate::notify::notify::SendCounts = c;
                let _ = progress_store.update_newsletter(&progress_id, |n| {
                    n.sent = c.sent;
                    n.failed = c.failed;
                }).await;
            }
        });
        let result = notifier.send_newsletter(&draft, |c| {
            let _ = tx.send(c);
        }).await;
        drop(tx);
        let _ = writer.await;
        let update = store
            .update_newsletter(&id, |n| match &result {
                Ok(c) => {
                    n.recipients = c.recipients;
                    n.sent = c.sent;
                    n.failed = c.failed;
                    "sent".clone_into(&mut n.status);
                    n.sent_at = Some(crate::core::util::iso_now());
                }
                Err(e) => {
                    "error".clone_into(&mut n.status);
                    n.error = Some(e.to_string());
                }
            })
            .await;
        if let Err(e) = update {
            tracing::error!(target: "admin", newsletter_id = %id, error = %e, "saving newsletter result failed");
        }
    });
    created(newsletter_json(&n))
}

async fn test_newsletter(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    let draft = validate_newsletter(&b).map_err(ApiError::bad)?;
    st.notifier.send_newsletter_test(&str_of(b.get("email")), &draft).await.map_err(|e| ApiError::bad(e.to_string()))?;
    ok(json!({ "ok": true }))
}

async fn delete_newsletter(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    if !st.store.remove_newsletter(&id).await? {
        return Err(ApiError::not_found());
    }
    ok(json!({ "ok": true }))
}

async fn regenerate_all(State(st): State<AppState>) -> ApiResult {
    tracing::info!(target: "admin", "manual bulk regeneration requested");
    let results = st.channels.generate_all("admin manual bulk regeneration").await;
    ok(json!({ "ok": true, "results": results }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(period: &str, price: i64) -> Plan {
        Plan { id: "p".into(), name: "P".into(), price_cents: price, currency: "EUR".into(), billing_period: period.into(), sort: 1.0, category_ids: vec![], max_devices: 0, extra: Map::new() }
    }

    #[test]
    fn payment_validation_and_expiry() {
        let v = validate_payment(&json!({}), Some(&plan("month", 1))).unwrap();
        assert_eq!(v, PaymentRequest { count: 1, period: "month".into(), from: "expiry".into() });
        assert_eq!(validate_payment(&json!({"count": 3}), Some(&plan("year", 1))).unwrap().period, "year");
        assert_eq!(validate_payment(&json!({}), Some(&plan("", 1))).unwrap().period, "month");
        assert_eq!(validate_payment(&json!({}), None).unwrap().period, "month");
        assert_eq!(validate_payment(&json!({"period": "day"}), Some(&plan("month", 1))).unwrap().period, "day");
        for bad in [json!({"count": 0}), json!({"count": 2.5}), json!({"count": 999})] {
            assert!(validate_payment(&bad, None).unwrap_err().contains("between 1 and"));
        }
        assert!(validate_payment(&json!({"period": "week"}), None).unwrap_err().contains("period must be one of"));
        assert!(validate_payment(&json!({"from": "yesterday"}), None).unwrap_err().contains("from must be"));

        let r = |p: &str, c: i64, from: &str| PaymentRequest { count: c, period: p.into(), from: from.into() };
        let today = "2026-08-10";
        assert_eq!(payment_expiry(Some("2026-09-01"), &r("month", 1, "expiry"), today).as_deref(), Some("2026-10-01"));
        assert_eq!(payment_expiry(Some("2026-05-01"), &r("month", 1, "expiry"), today).as_deref(), Some("2026-09-10"));
        assert_eq!(payment_expiry(None, &r("year", 1, "expiry"), today).as_deref(), Some("2027-08-10"));
        assert_eq!(payment_expiry(Some("2026-12-01"), &r("month", 1, "today"), today).as_deref(), Some("2026-09-10"));
    }

    #[test]
    fn prices_plans_and_devices() {
        assert_eq!(parse_price_cents(Some(&json!("4.99"))), Ok(499));
        assert_eq!(parse_price_cents(Some(&json!(10))), Ok(1000));
        for bad in [json!(""), json!("abc"), json!(-1), Value::Null] {
            assert!(parse_price_cents(Some(&bad)).is_err(), "{bad}");
        }
        let known: HashSet<String> = ["a".into(), "b".into()].into();
        assert_eq!(parse_plan_categories(&json!(["a", " a ", "b", ""]), &known), Ok(vec!["a".into(), "b".into()]));
        assert_eq!(parse_plan_categories(&json!(["zz"]), &known).unwrap_err(), "unknown category: zz");
        assert_eq!(plan_category_diff(&["a".into(), "b".into()], &["b".into(), "c".into()]), (vec!["c".into()], vec!["a".into()]));
        let plans = [plan("", 1)];
        assert!(duplicate_plan_name(&plans, " p ", None) && !duplicate_plan_name(&plans, "p", Some("p")));
        assert_eq!(parse_max_devices(&json!(0), false), Ok(Some(0)));
        assert_eq!(parse_max_devices(&json!("3"), false), Ok(Some(3)));
        for bad in [json!(-1), json!(1.5), json!(101), json!("x"), Value::Null, json!("")] {
            assert!(parse_max_devices(&bad, false).is_err(), "{bad}");
        }
        assert_eq!(parse_max_devices(&Value::Null, true), Ok(None));
    }

    #[test]
    fn payment_amounts_and_summary() {
        assert_eq!(suggested_payment_cents(Some(&plan("month", 500)), 3, "month"), Some(1500));
        assert_eq!(suggested_payment_cents(Some(&plan("month", 500)), 1, "year"), Some(6000));
        assert_eq!(suggested_payment_cents(Some(&plan("year", 6000)), 2, "month"), Some(1000));
        assert_eq!(suggested_payment_cents(Some(&plan("", 500)), 2, "month"), Some(1000));
        assert_eq!(suggested_payment_cents(Some(&plan("month", 500)), 10, "day"), None);
        assert_eq!(suggested_payment_cents(None, 1, "month"), None);
        assert_eq!(validate_payment_record(&json!({})), Ok((None, String::new())));
        assert_eq!(validate_payment_record(&json!({"amount_eur": "12.5"})).unwrap().0, Some(1250));
        assert_eq!(validate_payment_record(&json!({"amount_eur": 0})).unwrap().0, Some(0));
        assert!(validate_payment_record(&json!({"amount_eur": -1})).is_err());
        assert!(validate_payment_record(&json!({"note": "x".repeat(201)})).is_err());

        let p = |at: &str, c: Option<i64>| Payment { at: at.into(), amount_cents: c, ..Payment::default() };
        let list = [p("2026-10-08T10:00:00Z", Some(500)), p("2026-10-01T10:00:00Z", None), p("2026-09-20T10:00:00Z", Some(700)), p("2026-08-01T10:00:00Z", Some(900))];
        let s = payments_summary(&list, "2026-10-09", &jiff::tz::TimeZone::UTC);
        assert_eq!((s["month_count"].as_u64(), s["month_cents"].as_i64()), (Some(2), Some(500)));
        assert_eq!((s["last30_count"].as_u64(), s["last30_cents"].as_i64()), (Some(3), Some(1200)));
    }

    #[test]
    fn incident_validation() {
        let v = validate_incident(&json!({"title": "CDN", "severity": "outage", "starts_on": "2026-06-01"}), false).unwrap();
        assert_eq!((v.ends_on, v.note.as_deref()), (Some(None), Some("")));
        for bad in [json!({"title": "", "severity": "outage", "starts_on": "2026-06-01"}), json!({"title": "x", "severity": "meh", "starts_on": "2026-06-01"}), json!({"title": "x", "severity": "outage", "starts_on": "06/01"})] {
            assert!(validate_incident(&bad, false).is_err(), "{bad}");
        }
        let p = validate_incident(&json!({"note": "n"}), true).unwrap();
        assert!(p.title.is_none() && p.severity.is_none() && p.ends_on.is_none() && p.note.as_deref() == Some("n"));
        let open = incident_json(&Incident { id: "1".into(), severity: "outage".into(), starts_on: Some("2026-06-01".into()), ..Incident::default() });
        assert_eq!((open["ongoing"].as_bool(), open["ends_pretty"].is_null()), (Some(true), true));
    }

    #[test]
    fn provider_news_and_public_settings() {
        let v = validate_provider_news(&json!({"enabled": true, "url": " https://tv.team/v3/news?page=1 ", "cookie": "Cookie: a=1;\n b=2"})).unwrap();
        assert_eq!((v.enabled, v.url.as_deref(), v.cookie.as_deref()), (Some(true), Some("https://tv.team/v3/news?page=1"), Some("a=1; b=2")));
        assert_eq!(validate_provider_news(&json!({"enabled": "yes"})).unwrap_err(), "enabled must be a boolean");
        assert_eq!(validate_provider_news(&json!({"url": "file:///etc/passwd"})).unwrap_err(), "url must be an http(s) URL");
        assert_eq!(validate_provider_news(&json!({"ai_key": " sk-or-v1-abc "})).unwrap().ai_key.as_deref(), Some("sk-or-v1-abc"));
        assert_eq!(validate_provider_news(&json!({"ai_key": "sk or"})).unwrap_err(), "ai_key is not a valid API key");
        let mut s = Map::new();
        s.insert("brand_name".into(), json!("X"));
        s.insert("provider_news".into(), json!({"cookie": "secret=1"}));
        assert_eq!(public_settings(&s), json!({"brand_name": "X"}));
    }
}
