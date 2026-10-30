//! `/admin/api/diagnostics`: the Диагностика page. Live channel health from
//! the gateway's tracker (`playlist::diagnostics`), the problem register in
//! PostgreSQL, an on-demand check of a channel at the provider, and the
//! background job that writes the tracker's incidents.
//!
//! Like the statistics, reads combine what is stored with what the tracker
//! has not written yet, so the register is current to the second.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde::Serialize;
use serde_json::{Value, json};

use super::AppState;
use super::api::{ApiError, ApiResult, body, num_of, ok};
use crate::core::fetch::fetch_bounded;
use crate::core::util::{iso, now_ms};
use crate::data::incidents::{clear, load_open, prune, restore, save};
use crate::playlist::diagnostics::{CLOSE_AFTER_MS, ChannelView, IncidentRow, Kind, SLOW_MS};
use crate::playlist::hls::{is_hls_url, is_master_playlist, parse_media_playlist, rewrite_hls_manifest};

/// Incidents a channel's history lists (the count covers them all).
const HISTORY_MAX: usize = 50;

/// The longest the check waits to see a live playlist move.
const ADVANCE_WAIT_MAX: Duration = Duration::from_secs(10);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/diagnostics", get(overview))
        .route("/diagnostics/channels/{id}", get(channel))
        .route("/diagnostics/channels/{id}/check", post(check))
        .route("/diagnostics/channels/{id}/resolve", post(resolve))
        .route("/diagnostics/channels/{id}/restore", post(restore_channel))
}

/// Write the incidents the tracker collected since the last call. A failed
/// write is handed back and retried on the next call.
pub async fn flush_incidents(st: &AppState) {
    let rows = st.gateway.diagnostics().take_dirty(now_ms());
    if rows.is_empty() {
        return;
    }
    if let Err(e) = save(st.store.pool(), &rows).await {
        tracing::error!(target: "diagnostics", rows = rows.len(), error = %format!("{e:#}"), "saving channel incidents failed; will retry");
        st.gateway.diagnostics().requeue(rows);
    }
}

/// Delete incidents cleared longer ago than the statistics retention.
pub async fn prune_incidents(st: &AppState) {
    let keep_ms = i64::try_from(st.config.gateway.stats_retention_days).unwrap_or(90) * 86_400_000;
    match prune(st.store.pool(), now_ms() - keep_ms).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(target: "diagnostics", rows = n, "pruned cleared channel incidents"),
        Err(e) => tracing::error!(target: "diagnostics", error = %format!("{e:#}"), "pruning channel incidents failed"),
    }
}

fn iso_ms(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map(iso).unwrap_or_default()
}

/// The stored register of one channel or all, with what the tracker holds
/// on top (its copy of an incident is newer than the last flush).
async fn register(st: &AppState, channel_id: Option<&str>) -> Result<Vec<IncidentRow>, ApiError> {
    let stored = load_open(st.store.pool(), channel_id).await?;
    let mut rows: HashMap<String, IncidentRow> = stored.into_iter().map(|r| (r.id.clone(), r)).collect();
    for r in st
        .gateway
        .diagnostics()
        .unsaved()
        .into_iter()
        .filter(|r| channel_id.is_none_or(|id| r.channel_id == id))
    {
        rows.insert(r.id.clone(), r);
    }
    Ok(rows.into_values().collect())
}

/// A channel's name and group as the catalog has them now; the name the
/// tracker or an incident saw otherwise (a channel since deleted).
fn naming(st: &AppState, channel_id: &str, seen: &str) -> (String, String) {
    match st.catalog.channel(channel_id) {
        Some(ch) => {
            let group = st.catalog.category(&ch.category_id).map(|c| c.name).unwrap_or_default();
            let name = if ch.name.is_empty() { seen.to_owned() } else { ch.name };
            (name, group)
        }
        None => (seen.to_owned(), String::new()),
    }
}

fn usernames(st: &AppState) -> HashMap<i64, String> {
    st.store
        .users()
        .into_iter()
        .map(|u| (u.id, u.username.clone()))
        .collect()
}

fn channel_json(st: &AppState, v: &ChannelView, names: &HashMap<i64, String>) -> Value {
    let (name, group) = naming(st, &v.channel_id, &v.name);
    let viewers: Vec<Value> = v
        .viewers
        .iter()
        .map(|w| {
            json!({
                "user_id": w.user_id,
                "username": names.get(&w.user_id).cloned().unwrap_or_default(),
                "player": w.player,
                "ip": w.ip,
                "since": iso_ms(w.since),
                "state": w.state,
                "late_ms": w.late_ms,
                "retunes": w.retunes,
                "error": w.error,
            })
        })
        .collect();
    let minutes: Vec<Value> = v
        .minutes
        .iter()
        .map(|m| {
            json!({
                "at": iso_ms(m.at),
                "state": m.state,
                "viewers": m.viewers,
                "troubled": m.troubled,
                "latency_ms": m.latency_ms,
            })
        })
        .collect();
    json!({
        "channel_id": v.channel_id,
        "name": name,
        "group": group,
        "state": v.state,
        "latency_ms": v.latency_ms,
        "usual_ms": v.usual_ms,
        "requests": v.requests,
        "failures": v.failures,
        "error": v.error,
        "frozen_ms": v.frozen_ms,
        "target_ms": v.target_ms,
        "viewers": viewers,
        "minutes": minutes,
    })
}

/// One channel's line in the register.
#[derive(Debug, Serialize)]
struct Problem {
    channel_id: String,
    name: String,
    group: String,
    kinds: Vec<Kind>,
    count: usize,
    clients: usize,
    first: String,
    last: String,
    ongoing: bool,
    #[serde(skip)]
    last_ms: i64,
}

fn problems(st: &AppState, rows: Vec<IncidentRow>, now: i64) -> Vec<Problem> {
    let mut by_channel: HashMap<String, Vec<IncidentRow>> = HashMap::new();
    for r in rows {
        by_channel.entry(r.channel_id.clone()).or_default().push(r);
    }
    let mut out: Vec<Problem> = by_channel
        .into_iter()
        .map(|(channel_id, rows)| {
            let latest = rows
                .iter()
                .max_by_key(|r| r.ended)
                .map(|r| r.channel_name.clone())
                .unwrap_or_default();
            let (name, group) = naming(st, &channel_id, &latest);
            let kinds: BTreeSet<Kind> = rows.iter().map(|r| r.kind).collect();
            let clients: BTreeSet<i64> = rows.iter().flat_map(|r| r.users.iter().copied()).collect();
            let first = rows.iter().map(|r| r.started).min().unwrap_or(now);
            let last = rows.iter().map(|r| r.ended).max().unwrap_or(now);
            Problem {
                channel_id,
                name,
                group,
                kinds: kinds.into_iter().collect(),
                count: rows.len(),
                clients: clients.len(),
                first: iso_ms(first),
                last: iso_ms(last),
                ongoing: now - last <= CLOSE_AFTER_MS,
                last_ms: last,
            }
        })
        .collect();
    out.sort_by(|a, b| b.ongoing.cmp(&a.ongoing).then(b.last_ms.cmp(&a.last_ms)));
    out
}

async fn overview(State(st): State<AppState>) -> ApiResult {
    let now = now_ms();
    let live = st.gateway.diagnostics().live(now);
    let names = usernames(&st);
    let channels: Vec<Value> = live.iter().map(|v| channel_json(&st, v, &names)).collect();
    let register = register(&st, None).await?;
    ok(json!({
        "gateway_enabled": st.config.gateway_enabled(),
        "slow_ms": SLOW_MS,
        "channels": channels,
        "problems": problems(&st, register, now),
    }))
}

async fn channel(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let now = now_ms();
    let view = st.gateway.diagnostics().channel(&id, now);
    let mut history = register(&st, Some(&id)).await?;
    if view.is_none() && history.is_empty() && st.catalog.channel(&id).is_none() {
        return Err(ApiError::not_found());
    }
    history.sort_by_key(|r| std::cmp::Reverse(r.started));
    let clients: BTreeSet<i64> = history.iter().flat_map(|r| r.users.iter().copied()).collect();
    let since = history.iter().map(|r| r.started).min();
    let seen = view
        .as_ref()
        .map(|v| v.name.clone())
        .or_else(|| history.first().map(|r| r.channel_name.clone()))
        .unwrap_or_default();
    let (name, group) = naming(&st, &id, &seen);
    let names = usernames(&st);
    let incidents: Vec<Value> = history
        .iter()
        .take(HISTORY_MAX)
        .map(|r| {
            json!({
                "id": r.id,
                "kind": r.kind,
                "detail": r.detail,
                "peak": r.peak,
                "clients": r.users.len(),
                "started": iso_ms(r.started),
                "ended": iso_ms(r.ended),
                "ongoing": now - r.ended <= CLOSE_AFTER_MS,
            })
        })
        .collect();
    ok(json!({
        "channel_id": id,
        "name": name,
        "group": group,
        "checkable": st.catalog.channel(&id).is_some_and(|c| !c.builtin && is_hls_url(&c.url)),
        "slow_ms": SLOW_MS,
        "live": view.map(|v| channel_json(&st, &v, &names)),
        "history": incidents,
        "count": history.len(),
        "clients": clients.len(),
        "since": since.map(iso_ms),
    }))
}

async fn resolve(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let at = now_ms();
    // What the tracker has not written yet goes in first, so the stamp covers it.
    let unsaved: Vec<IncidentRow> = st
        .gateway
        .diagnostics()
        .unsaved()
        .into_iter()
        .filter(|r| r.channel_id == id)
        .collect();
    save(st.store.pool(), &unsaved).await?;
    let cleared = clear(st.store.pool(), &id, at).await?;
    st.gateway.diagnostics().clear_channel(&id, at);
    tracing::info!(target: "diagnostics", channel_id = %id, incidents = cleared, "channel marked fixed");
    ok(json!({ "cleared_at": at, "cleared": cleared }))
}

async fn restore_channel(State(st): State<AppState>, Path(id): Path<String>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    let Some(at) = num_of(b.get("cleared_at")).filter(|n| *n > 0.0).map(|n| n as i64) else {
        return Err(ApiError::bad("cleared_at required"));
    };
    let restored = restore(st.store.pool(), &id, at).await?;
    if restored > 0 {
        st.gateway.diagnostics().restore_channel(&id);
    }
    ok(json!({ "restored": restored }))
}

/// One step of a check.
#[derive(Debug, Serialize)]
struct Step {
    #[serde(rename = "step")]
    name: &'static str,
    ok: bool,
    ms: i64,
    error: Option<String>,
}

fn elapsed_ms(started: std::time::Instant) -> i64 {
    i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
}

/// Check a channel at the provider now: its playlist, the quality a player
/// would pick first, the newest segment, and whether the playlist moves.
async fn check(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let ch = st.catalog.channel(&id).ok_or_else(ApiError::not_found)?;
    if ch.builtin || !is_hls_url(&ch.url) {
        return Err(ApiError::bad("only HLS provider channels can be checked"));
    }
    let timeout = Duration::from_millis(st.config.gateway.manifest_timeout_ms);
    let max = st.config.gateway.manifest_max_bytes;
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("VLC/3.0.20 LibVLC/3.0.20"));
    let mut steps: Vec<Step> = Vec::new();
    let verdict = |steps: &[Step], verdict: &str, target_ms: i64, segments: usize| json!({ "verdict": verdict, "steps": steps, "target_ms": target_ms, "segments": segments });

    let fetch = |url: String| {
        let headers = headers.clone();
        let http = st.http.clone();
        async move {
            let started = std::time::Instant::now();
            let res = fetch_bounded(&http, &url, headers, timeout, max).await;
            (res, elapsed_ms(started))
        }
    };

    let (entry, ms) = fetch(ch.url.clone()).await;
    let entry = match entry {
        Ok(f) => {
            steps.push(Step {
                name: "playlist",
                ok: true,
                ms,
                error: None,
            });
            f
        }
        Err(e) => {
            steps.push(Step {
                name: "playlist",
                ok: false,
                ms,
                error: Some(e.code()),
            });
            return ok(verdict(&steps, "error", 0, 0));
        }
    };
    let mut media_url = ch.url.clone();
    let mut media = entry;
    let entry_text = media.text();
    if is_master_playlist(&entry_text) {
        let absolute = rewrite_hls_manifest(&entry_text, &media.final_url, None);
        let Some(variant) = first_variant(&absolute) else {
            steps.push(Step {
                name: "variant",
                ok: false,
                ms: 0,
                error: Some("empty".into()),
            });
            return ok(verdict(&steps, "empty", 0, 0));
        };
        let (res, ms) = fetch(variant.clone()).await;
        match res {
            Ok(f) => {
                steps.push(Step {
                    name: "variant",
                    ok: true,
                    ms,
                    error: None,
                });
                media_url = variant;
                media = f;
            }
            Err(e) => {
                steps.push(Step {
                    name: "variant",
                    ok: false,
                    ms,
                    error: Some(e.code()),
                });
                return ok(verdict(&steps, "error", 0, 0));
            }
        }
    }
    let text = media.text();
    let playlist = parse_media_playlist(&rewrite_hls_manifest(&text, &media.final_url, None));
    let target_ms = (playlist.target_duration * 1000.0) as i64;
    let Some(last) = playlist.segments.last() else {
        return ok(verdict(&steps, "empty", target_ms, 0));
    };

    let started = std::time::Instant::now();
    let segment = st
        .http
        .get(&last.uri)
        .headers(headers.clone())
        .timeout(timeout)
        .send()
        .await;
    let segment = match segment {
        Ok(mut res) if res.status().is_success() => match res.chunk().await {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err("empty".to_owned()),
            Err(e) => Err(crate::core::fetch::FetchError::from(e).code()),
        },
        Ok(res) => Err(res.status().as_u16().to_string()),
        Err(e) => Err(crate::core::fetch::FetchError::from(e).code()),
    };
    let ms = elapsed_ms(started);
    steps.push(Step {
        name: "segment",
        ok: segment.is_ok(),
        ms,
        error: segment.err(),
    });
    if steps.iter().any(|s| !s.ok) {
        return ok(verdict(&steps, "error", target_ms, playlist.segments.len()));
    }

    let mut outcome = if steps.iter().any(|s| s.ms > SLOW_MS) {
        "slow"
    } else {
        "ok"
    };
    // A live playlist gains a segment every target duration: give it one and a half.
    if !text.contains("#EXT-X-ENDLIST") {
        let wait = Duration::from_millis((target_ms.max(1_000) * 3 / 2) as u64).min(ADVANCE_WAIT_MAX);
        tokio::time::sleep(wait).await;
        let (again, ms) = fetch(media_url).await;
        match again {
            Ok(f) => {
                let next = parse_media_playlist(&rewrite_hls_manifest(&f.text(), &f.final_url, None));
                let moved = next.media_sequence != playlist.media_sequence
                    || next.segments.last().map(|s| &s.uri) != Some(&last.uri);
                steps.push(Step {
                    name: "advance",
                    ok: moved,
                    ms,
                    error: None,
                });
                if !moved {
                    outcome = "frozen";
                }
            }
            Err(e) => {
                steps.push(Step {
                    name: "advance",
                    ok: false,
                    ms,
                    error: Some(e.code()),
                });
                outcome = "error";
            }
        }
    }
    ok(verdict(&steps, outcome, target_ms, playlist.segments.len()))
}

/// The first quality of a master playlist with absolute URIs.
fn first_variant(master: &str) -> Option<String> {
    let mut lines = master.lines().map(str::trim);
    while let Some(line) = lines.next() {
        if line.starts_with("#EXT-X-STREAM-INF") {
            return lines.find(|l| !l.is_empty() && !l.starts_with('#')).map(str::to_owned);
        }
    }
    None
}
