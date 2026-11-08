//! `/admin/api/diagnostics`: the Диагностика page. Live channel health from
//! the gateway's tracker (`playlist::diagnostics`), the problem register in
//! PostgreSQL, an on-demand check of a channel at the provider, and the
//! background jobs that write the tracker's incidents and take channels out
//! of the register once they are shown to work.
//!
//! Like the statistics, reads combine what is stored with what the tracker
//! has not written yet, so the register is current to the second.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde::Serialize;
use serde_json::{Value, json};

use super::AppState;
use super::api::{ApiError, ApiResult, ok};
use crate::core::fetch::fetch_bounded;
use crate::core::util::{iso, now_ms};
use crate::data::incidents::{ResolutionRow, load_open, prune, resolutions, resolve, save};
use crate::playlist::diagnostics::{
    CLOSE_AFTER_MS, ChannelView, IncidentRow, Kind, PROBE_EVERY_MS, Probe, Resolved, SLOW_MS, UNWATCHED_MS,
    VERIFY_PROBES, VERIFY_QUIET_MS, VERIFY_VIEWING_MS, Verdict, VerificationView,
};
use crate::playlist::hls::{is_hls_url, is_master_playlist, parse_media_playlist, rewrite_hls_manifest};

/// Incidents a channel's history lists (the count covers them all).
const HISTORY_MAX: usize = 50;

/// The longest the check waits to see a live playlist move.
const ADVANCE_WAIT_MAX: Duration = Duration::from_secs(10);

/// How far back the "Решены" list goes, and how long it is at most.
const RESOLVED_DAYS: i64 = 7;
const RESOLVED_MAX: i64 = 50;

/// Checks the background job runs at the provider at once.
const PROBES_AT_ONCE: usize = 4;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/diagnostics", get(overview))
        .route("/diagnostics/channels/{id}", get(channel))
        .route("/diagnostics/channels/{id}/check", post(check))
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

/// Whether the server can check a channel at the provider.
fn checkable(st: &AppState, channel_id: &str) -> bool {
    st.catalog
        .channel(channel_id)
        .is_some_and(|c| !c.builtin && is_hls_url(&c.url))
}

/// The register's way out, run every minute: check at the provider the
/// channels quiet long enough, then take out every channel shown to work
/// (and those deleted from the catalog). A failed write is tried again the
/// next minute.
pub async fn verify_register(st: &AppState) {
    let stored = match load_open(st.store.pool(), None).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(target: "diagnostics", error = %format!("{e:#}"), "loading the problem register failed");
            return;
        }
    };
    let mut kinds: BTreeMap<String, BTreeSet<Kind>> = BTreeMap::new();
    let due = {
        let mut d = st.gateway.diagnostics();
        for r in stored.into_iter().chain(d.unsaved()) {
            kinds.entry(r.channel_id).or_default().insert(r.kind);
        }
        let ids: BTreeSet<String> = kinds.keys().cloned().collect();
        d.track(&ids, now_ms());
        d.probe_due(now_ms())
    };

    let jobs: Vec<(String, String, bool)> = due
        .into_iter()
        .filter_map(|id| {
            let ch = st.catalog.channel(&id).filter(|c| !c.builtin && is_hls_url(&c.url))?;
            let strict = kinds.get(&id).is_some_and(|k| k.contains(&Kind::Slow));
            Some((id, ch.url, strict))
        })
        .collect();
    let done: Vec<(String, i64, Probe)> = futures_util::stream::iter(jobs)
        .map(|(id, url, strict)| async move {
            let started = now_ms();
            let checked = probe(st, &url).await;
            (id, started, checked.as_probe(strict))
        })
        .buffer_unordered(PROBES_AT_ONCE)
        .collect()
        .await;
    for (id, started, probe) in done {
        if !probe.passed {
            tracing::info!(target: "diagnostics", channel_id = %id, verdict = %probe.verdict, error = probe.error.as_deref().unwrap_or(""),
                "register channel failed its check");
        }
        st.gateway.diagnostics().probed(&id, started, probe);
    }

    let now = now_ms();
    let mut verdicts: Vec<Verdict> = kinds
        .keys()
        .filter(|id| st.catalog.channel(id).is_none())
        .map(|id| Verdict {
            channel_id: id.clone(),
            how: Resolved::Removed,
            probes: 0,
            viewing_ms: 0,
            viewers: 0,
        })
        .collect();
    let ready = st.gateway.diagnostics().ready(now, |id| checkable(st, id));
    verdicts.extend(
        ready
            .into_iter()
            .filter(|v| st.catalog.channel(&v.channel_id).is_some()),
    );
    for v in verdicts {
        resolve_channel(st, &v, now).await;
    }
}

/// Take one channel out of the register: stored first, then the tracker.
async fn resolve_channel(st: &AppState, v: &Verdict, at: i64) {
    let unsaved: Vec<IncidentRow> = st
        .gateway
        .diagnostics()
        .unsaved()
        .into_iter()
        .filter(|r| r.channel_id == v.channel_id && r.started <= at)
        .collect();
    match resolve(st.store.pool(), v, at, &unsaved).await {
        Ok(res) => {
            st.gateway.diagnostics().resolved(&v.channel_id, at);
            tracing::info!(target: "diagnostics", channel_id = %v.channel_id, how = v.how.as_str(), probes = v.probes,
                viewing_s = v.viewing_ms / 1000, viewers = v.viewers, incidents = res.map_or(0, |r| r.incidents),
                "channel left the problem register");
        }
        Err(e) => {
            tracing::error!(target: "diagnostics", channel_id = %v.channel_id, error = %format!("{e:#}"), "resolving channel failed; will retry");
        }
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

/// What a channel needs to leave the register (the same for every channel).
fn requirements() -> Value {
    json!({
        "quiet_ms": VERIFY_QUIET_MS,
        "probes": VERIFY_PROBES,
        "probe_every_ms": PROBE_EVERY_MS,
        "viewing_ms": VERIFY_VIEWING_MS,
        "unwatched_ms": UNWATCHED_MS,
    })
}

/// A register channel's way out so far; a channel the job has not picked up
/// yet is just starting.
fn verification_json(v: Option<VerificationView>, checkable: bool, now: i64) -> Value {
    let v = v.unwrap_or(VerificationView {
        since: now,
        probes_ok: 0,
        viewing_ms: 0,
        viewers: 0,
        last_probe: None,
    });
    json!({
        "since": iso_ms(v.since),
        "checkable": checkable,
        "probes_ok": v.probes_ok,
        "viewing_ms": v.viewing_ms,
        "viewers": v.viewers,
        "last_probe": v.last_probe.map(|p| json!({
            "at": iso_ms(p.at),
            "passed": p.passed,
            "verdict": p.verdict,
            "error": p.error,
        })),
    })
}

fn resolution_json(st: &AppState, r: &ResolutionRow) -> Value {
    let (name, group) = naming(st, &r.channel_id, &r.channel_name);
    json!({
        "channel_id": r.channel_id,
        "name": name,
        "group": group,
        "kinds": r.kinds,
        "count": r.incidents,
        "clients": r.users.len(),
        "first": iso_ms(r.first),
        "last": iso_ms(r.last),
        "resolved": iso_ms(r.resolved),
        "how": r.how,
        "probes": r.probes,
        "viewing_ms": r.viewing_ms,
        "viewers": r.viewers,
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
    verification: Value,
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
            let verification = verification_json(
                st.gateway.diagnostics().verification(&channel_id),
                checkable(st, &channel_id),
                now,
            );
            Problem {
                name,
                group,
                kinds: kinds.into_iter().collect(),
                count: rows.len(),
                clients: clients.len(),
                first: iso_ms(first),
                last: iso_ms(last),
                ongoing: rows.iter().any(|r| now - r.ended <= CLOSE_AFTER_MS),
                verification,
                last_ms: last,
                channel_id,
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
    let resolved = resolutions(st.store.pool(), now - RESOLVED_DAYS * 86_400_000, None, RESOLVED_MAX).await?;
    ok(json!({
        "gateway_enabled": st.config.gateway_enabled(),
        "slow_ms": SLOW_MS,
        "verify": requirements(),
        "channels": channels,
        "problems": problems(&st, register, now),
        "resolved": resolved.iter().map(|r| resolution_json(&st, r)).collect::<Vec<_>>(),
    }))
}

async fn channel(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let now = now_ms();
    let view = st.gateway.diagnostics().channel(&id, now);
    let mut history = register(&st, Some(&id)).await?;
    let last_resolved = resolutions(st.store.pool(), 0, Some(&id), 1).await?;
    if view.is_none() && history.is_empty() && last_resolved.is_empty() && st.catalog.channel(&id).is_none() {
        return Err(ApiError::not_found());
    }
    history.sort_by_key(|r| std::cmp::Reverse(r.started));
    let clients: BTreeSet<i64> = history.iter().flat_map(|r| r.users.iter().copied()).collect();
    let since = history.iter().map(|r| r.started).min();
    let seen = view
        .as_ref()
        .map(|v| v.name.clone())
        .or_else(|| history.first().map(|r| r.channel_name.clone()))
        .or_else(|| last_resolved.first().map(|r| r.channel_name.clone()))
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
    let checkable = checkable(&st, &id);
    let verification =
        (!history.is_empty()).then(|| verification_json(st.gateway.diagnostics().verification(&id), checkable, now));
    ok(json!({
        "channel_id": id,
        "name": name,
        "group": group,
        "checkable": checkable,
        "slow_ms": SLOW_MS,
        "verify": requirements(),
        "live": view.map(|v| channel_json(&st, &v, &names)),
        "history": incidents,
        "count": history.len(),
        "clients": clients.len(),
        "since": since.map(iso_ms),
        "ongoing": history.iter().any(|r| now - r.ended <= CLOSE_AFTER_MS),
        "verification": verification,
        "last_resolved": last_resolved.first().map(|r| resolution_json(&st, r)),
    }))
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

/// What a check found.
#[derive(Debug, Serialize)]
struct Checked {
    /// `ok`, `slow`, `frozen`, `error`, `empty`.
    verdict: &'static str,
    steps: Vec<Step>,
    target_ms: i64,
    segments: usize,
}

impl Checked {
    /// As a check towards a register channel's way out. A slow answer passes
    /// unless slowness is what the channel had (`strict`).
    fn as_probe(&self, strict: bool) -> Probe {
        Probe {
            at: now_ms(),
            passed: self.verdict == "ok" || (self.verdict == "slow" && !strict),
            verdict: self.verdict.to_owned(),
            error: self.steps.iter().find_map(|s| s.error.clone()),
        }
    }
}

/// Check a channel at the provider now: its playlist, the quality a player
/// would pick first, the newest segment, and whether the playlist moves.
/// It counts towards the channel's way out of the register, like the
/// background job's checks.
async fn check(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let ch = st.catalog.channel(&id).ok_or_else(ApiError::not_found)?;
    if ch.builtin || !is_hls_url(&ch.url) {
        return Err(ApiError::bad("only HLS provider channels can be checked"));
    }
    let strict = register(&st, Some(&id)).await?.iter().any(|r| r.kind == Kind::Slow);
    let started = now_ms();
    let checked = probe(&st, &ch.url).await;
    st.gateway.diagnostics().probed(&id, started, checked.as_probe(strict));
    ok(json!(checked))
}

/// Check one HLS channel URL at the provider.
async fn probe(st: &AppState, url: &str) -> Checked {
    let timeout = Duration::from_millis(st.config.gateway.manifest_timeout_ms);
    let max = st.config.gateway.manifest_max_bytes;
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("VLC/3.0.20 LibVLC/3.0.20"));
    let mut steps: Vec<Step> = Vec::new();
    let verdict = |steps: Vec<Step>, verdict: &'static str, target_ms: i64, segments: usize| Checked {
        verdict,
        steps,
        target_ms,
        segments,
    };
    let fetch = |url: String| {
        let headers = headers.clone();
        let http = st.http.clone();
        async move {
            let started = std::time::Instant::now();
            let res = fetch_bounded(&http, &url, headers, timeout, max).await;
            (res, elapsed_ms(started))
        }
    };

    let (entry, ms) = fetch(url.to_owned()).await;
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
            return verdict(steps, "error", 0, 0);
        }
    };
    let mut media_url = url.to_owned();
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
            return verdict(steps, "empty", 0, 0);
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
                return verdict(steps, "error", 0, 0);
            }
        }
    }
    let text = media.text();
    let playlist = parse_media_playlist(&rewrite_hls_manifest(&text, &media.final_url, None));
    let target_ms = (playlist.target_duration * 1000.0) as i64;
    let Some(last) = playlist.segments.last() else {
        return verdict(steps, "empty", target_ms, 0);
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
        return verdict(steps, "error", target_ms, playlist.segments.len());
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
                    || next.last_segment_id() != playlist.last_segment_id();
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
    verdict(steps, outcome, target_ms, playlist.segments.len())
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
