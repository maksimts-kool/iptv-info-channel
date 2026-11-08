//! `/admin/api/stats`: the viewing statistics, and the background job that
//! writes the gateway's recorded watches to `watch_sessions`.
//!
//! The numbers combine the stored history with the watches still in
//! progress, so the page is current to the second rather than to the last
//! flush. Who is watching right now comes from the device list, which every
//! screen shares; this only flags the running watches.
//!
//! A channel is one line however many ids it had: history of an id the
//! catalog no longer has counts under the current channel of that name
//! ([`merge_renumbered`]).

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
use crate::playlist::model::normalize_name;
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
    let of_user = |r: &WatchRow| user_filter.is_none_or(|id| r.user_id == id);
    // The in-memory copy of a watch is newer than its last flush.
    let mut rows: HashMap<String, WatchRow> = stored.into_iter().map(|r| (r.id.clone(), r)).collect();
    for r in st
        .gateway
        .open_watches()
        .into_iter()
        .filter(|r| of_user(r) && r.duration_ms() >= MIN_WATCH_MS)
    {
        rows.insert(r.id.clone(), r);
    }
    let mut rows: Vec<WatchRow> = rows.into_values().collect();
    let catalog = st.catalog.read();
    let current: Vec<(&str, &str)> = catalog
        .channels
        .iter()
        .filter(|c| !c.missing)
        .map(|c| (c.id.as_str(), c.name.as_str()))
        .collect();
    merge_renumbered(&mut rows, &current);

    let usernames: HashMap<i64, String> = st
        .store
        .users()
        .into_iter()
        .map(|u| (u.id, u.username.clone()))
        .collect();
    // Who is watching right now is the device list's business
    // (`/admin/api/devices`); here it only marks the watches still running.
    let live_ids: HashSet<String> = st
        .gateway
        .live_watches()
        .into_iter()
        .filter(of_user)
        .map(|r| r.id)
        .collect();
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
    }
    ok(out)
}

/// Watches of a channel the catalog no longer has (deleted, or marked
/// missing) count under the current channel of the same name: a provider
/// source added again gives every channel a new id, and the history under
/// the old one is still that channel's. A name two current channels share
/// says nothing, so those watches stay as they are. `current`: the catalog's
/// channels that are not missing, as (id, name).
fn merge_renumbered(rows: &mut [WatchRow], current: &[(&str, &str)]) {
    let ids: HashSet<&str> = current.iter().map(|(id, _)| *id).collect();
    let mut by_name: HashMap<String, Option<&str>> = HashMap::new();
    for (id, name) in current {
        by_name
            .entry(normalize_name(name).to_lowercase())
            .and_modify(|only| *only = None)
            .or_insert(Some(id));
    }
    for r in rows.iter_mut().filter(|r| !ids.contains(r.channel_id.as_str())) {
        if let Some(Some(id)) = by_name.get(&normalize_name(&r.channel_name).to_lowercase()) {
            (*id).clone_into(&mut r.channel_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch(id: &str, channel_id: &str, channel_name: &str) -> WatchRow {
        WatchRow {
            id: id.into(),
            user_id: 1,
            channel_id: channel_id.into(),
            channel_name: channel_name.into(),
            player: String::new(),
            user_agent: String::new(),
            ip: String::new(),
            started: 0,
            ended: 60_000,
        }
    }

    #[test]
    fn history_of_an_old_id_merges_into_the_current_channel() {
        let mut rows = vec![
            // The source was added again: Россия 1 HD had another id before.
            watch("a", "old-r1hd", "Россия 1 HD"),
            watch("b", "new-r1hd", "Россия 1 HD"),
            // Spacing and case differences are the same name.
            watch("c", "older-r1hd", "россия  1 HD"),
            // Gone for good: nothing current is called that.
            watch("d", "old-gone", "Старый канал"),
            // Two current channels carry the name: no telling which.
            watch("e", "old-ntv", "НТВ"),
            // A current channel keeps its own history, whatever it was called.
            watch("f", "sts", "Россия 1 HD"),
        ];
        let current = [
            ("new-r1hd", "Россия 1 HD"),
            ("ntv-1", "НТВ"),
            ("ntv-2", "НТВ"),
            ("sts", "СТС"),
        ];
        merge_renumbered(&mut rows, &current);
        let ids: Vec<&str> = rows.iter().map(|r| r.channel_id.as_str()).collect();
        assert_eq!(ids, ["new-r1hd", "new-r1hd", "new-r1hd", "old-gone", "old-ntv", "sts"]);
    }

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
