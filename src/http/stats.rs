//! `/admin/api/stats`: the viewing statistics, and the background job that
//! writes the gateway's recorded watches to `watch_sessions`.
//!
//! The numbers combine the stored history with the watches still in
//! progress, so the page is current to the second rather than to the last
//! flush.

use std::collections::{HashMap, HashSet};

use axum::Router;
use axum::extract::{Query, State};
use axum::routing::get;
use jiff::{Timestamp, ToSpan};
use serde_json::{Value, json};

use super::AppState;
use super::api::{ApiError, ApiResult, ok};
use crate::core::util::{iso, local_date, local_time_to_timestamp, now_ms};
use crate::data::watch::{Window, load, prune, save, summarize};
use crate::playlist::watch::{MIN_WATCH_MS, WatchRow};

pub fn router() -> Router<AppState> {
    Router::new().route("/stats", get(stats))
}

/// Write what the recorder collected since the last call. A failed write is
/// handed back to the recorder and retried on the next call.
pub async fn flush_history(st: &AppState) {
    let rows = st.gateway.take_watch_rows();
    if rows.is_empty() {
        return;
    }
    if let Err(e) = save(st.store.pool(), &rows).await {
        tracing::error!(target: "stats", rows = rows.len(), error = %format!("{e:#}"), "saving viewing history failed; will retry");
        st.gateway.requeue_watch_rows(rows);
    }
}

/// Delete history older than the retention.
pub async fn prune_history(st: &AppState) {
    let keep_ms = i64::try_from(st.config.gateway.stats_retention_days).unwrap_or(90) * 86_400_000;
    match prune(st.store.pool(), now_ms() - keep_ms).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(target: "stats", rows = n, "pruned old viewing history"),
        Err(e) => tracing::error!(target: "stats", error = %format!("{e:#}"), "pruning viewing history failed"),
    }
}

/// `?days=N` (today = 1) and an optional `?user=ID`.
fn parse_query(q: &HashMap<String, String>, retention_days: i64) -> Result<(i64, Option<i64>), ApiError> {
    let days = match q.get("days").map(|d| d.trim()).filter(|d| !d.is_empty()) {
        None => 7,
        Some(d) => d.parse::<i64>().map_err(|_| ApiError::bad("days must be a number"))?,
    };
    if days < 1 {
        return Err(ApiError::bad("days must be at least 1"));
    }
    let user = match q.get("user").map(|u| u.trim()).filter(|u| !u.is_empty()) {
        None => None,
        Some(u) => Some(u.parse::<i64>().map_err(|_| ApiError::bad("bad user"))?),
    };
    Ok((days.min(retention_days), user))
}

async fn stats(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let retention = i64::try_from(st.config.gateway.stats_retention_days).unwrap_or(90);
    let (days, user_filter) = parse_query(&q, retention)?;
    let user = match user_filter {
        Some(id) => Some(st.store.user(id).ok_or_else(ApiError::not_found)?),
        None => None,
    };

    // From the local midnight `days - 1` days ago up to now.
    let tz = &st.config.tz;
    let now = Timestamp::now();
    let first_day = local_date(now, tz)
        .checked_sub((days - 1).days())
        .unwrap_or_else(|_| local_date(now, tz));
    let from_ms = local_time_to_timestamp(first_day, 0, 0, 0, tz).as_millisecond();
    let to_ms = now.as_millisecond();

    let stored = load(st.store.pool(), from_ms, to_ms, user_filter).await?;
    let live: Vec<WatchRow> = st
        .gateway
        .live_watches()
        .into_iter()
        .filter(|r| user_filter.is_none_or(|id| r.user_id == id))
        .collect();
    // The in-memory copy of a watch is newer than its last flush.
    let mut rows: HashMap<String, WatchRow> = stored.into_iter().map(|r| (r.id.clone(), r)).collect();
    for r in live.iter().filter(|r| r.duration_ms() >= MIN_WATCH_MS) {
        rows.insert(r.id.clone(), r.clone());
    }
    let rows: Vec<WatchRow> = rows.into_values().collect();

    let usernames: HashMap<i64, String> = st
        .store
        .users()
        .into_iter()
        .map(|u| (u.id, u.username.clone()))
        .collect();
    let live_ids: HashSet<String> = live.iter().map(|r| r.id.clone()).collect();
    let summary = summarize(
        &rows,
        &Window {
            from_ms,
            to_ms,
            tz,
            usernames: &usernames,
            live: &live_ids,
        },
    );

    let now_watching: Vec<Value> = live
        .iter()
        .map(|r| {
            json!({
                "user_id": r.user_id,
                "username": usernames.get(&r.user_id).cloned().unwrap_or_default(),
                "channel_id": r.channel_id, "channel": r.channel_name, "player": r.player, "ip": r.ip,
                "since": Timestamp::from_millisecond(r.started).map(iso).unwrap_or_default(),
            })
        })
        .collect();

    let mut out = serde_json::to_value(summary).map_err(anyhow::Error::from)?;
    if let Value::Object(map) = &mut out {
        map.insert(
            "range".into(),
            json!({
                "days": days,
                "from": Timestamp::from_millisecond(from_ms).map(iso).unwrap_or_default(),
                "to": iso(now),
                "timezone": st.config.tz_name,
            }),
        );
        map.insert("retention_days".into(), json!(retention));
        map.insert("gateway_enabled".into(), json!(st.config.gateway_enabled()));
        map.insert(
            "user".into(),
            user.map_or(Value::Null, |u| json!({ "id": u.id, "username": u.username })),
        );
        map.insert("live".into(), Value::Array(now_watching));
    }
    ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn query_defaults_and_limits() {
        assert_eq!(parse_query(&q(&[]), 90).unwrap(), (7, None));
        assert_eq!(
            parse_query(&q(&[("days", "1"), ("user", "12")]), 90).unwrap(),
            (1, Some(12))
        );
        assert_eq!(parse_query(&q(&[("days", "365")]), 90).unwrap(), (90, None));
        assert!(parse_query(&q(&[("days", "0")]), 90).is_err());
        assert!(parse_query(&q(&[("days", "x")]), 90).is_err());
        assert!(parse_query(&q(&[("user", "abc")]), 90).is_err());
    }
}
