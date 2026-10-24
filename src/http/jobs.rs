//! `/admin/api/jobs`: the background work the admin can watch and steer —
//! the info channel's encode queue and the media channel's builds — as a
//! snapshot, a live server-sent event feed, and cancel / retry / clear.

use std::convert::Infallible;
use std::time::Duration;

use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderValue, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::StreamExt;
use serde_json::{Value, json};

use super::AppState;
use super::api::{ApiError, ApiResult, ok};
use crate::core::util::iso_now;

/// While anything runs, the feed re-sends this often so elapsed times move.
const REFRESH: Duration = Duration::from_secs(3);
/// A burst of changes (a bulk rebuild queueing hundreds of jobs) is one event.
const SETTLE: Duration = Duration::from_millis(250);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/jobs", get(view))
        .route("/jobs/events", get(events))
        .route("/jobs/clear", post(clear))
        .route("/jobs/{id}/cancel", post(cancel))
        .route("/jobs/{id}/retry", post(retry))
}

/// Everything the job panel shows, and whether any of it is still working.
fn snapshot(st: &AppState) -> (Value, bool) {
    let queue = st.channels.queue().snapshot();
    let media = st.media.jobs_json();
    let busy = !queue.running.is_empty()
        || queue.queued_total > 0
        || media["build"]["state"] == "building"
        || media["build"]["pending"] == true
        || media["videos"].as_array().is_some_and(|v| !v.is_empty());
    (
        json!({ "queue": queue, "media": media, "busy": busy, "server_time": iso_now() }),
        busy,
    )
}

async fn view(State(st): State<AppState>) -> ApiResult {
    ok(snapshot(&st).0)
}

/// `text/event-stream` of `jobs` events, each a full snapshot: one now, then
/// one after every change. Ends on shutdown so the server can drain.
async fn events(State(st): State<AppState>) -> Response {
    let rx = st.channels.activity().subscribe();
    let closing = st.channels.activity().closing();
    let feed = futures_util::stream::unfold((st, rx, true), |(st, mut rx, first)| async move {
        if !first {
            loop {
                match tokio::time::timeout(REFRESH, rx.changed()).await {
                    Ok(Err(_)) => return None,
                    Ok(Ok(())) => break,
                    Err(_) if snapshot(&st).1 => break,
                    Err(_) => {}
                }
            }
            tokio::time::sleep(SETTLE).await;
            rx.mark_unchanged();
        }
        let event = Event::default().event("jobs").json_data(snapshot(&st).0).ok()?;
        Some((Ok::<_, Infallible>(event), (st, rx, false)))
    })
    .take_until(closing.cancelled_owned());
    let mut res = Sse::new(feed).keep_alive(KeepAlive::default()).into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    // nginx would otherwise hold events back in its buffer.
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    res
}

async fn cancel(State(st): State<AppState>, UrlPath(id): UrlPath<u64>) -> ApiResult {
    if !st.channels.queue().cancel(id) {
        return Err(ApiError::not_found());
    }
    tracing::info!(target: "admin", job_id = id, "encode job cancelled");
    ok(snapshot(&st).0)
}

async fn retry(State(st): State<AppState>, UrlPath(id): UrlPath<u64>) -> ApiResult {
    if !st.channels.queue().retry(id) {
        return Err(ApiError::not_found());
    }
    tracing::info!(target: "admin", job_id = id, "encode job retried");
    ok(snapshot(&st).0)
}

async fn clear(State(st): State<AppState>) -> ApiResult {
    let dropped = st.channels.queue().clear_queued();
    tracing::info!(target: "admin", dropped, "encode queue cleared");
    let (mut v, _) = snapshot(&st);
    v["dropped"] = json!(dropped);
    ok(v)
}
