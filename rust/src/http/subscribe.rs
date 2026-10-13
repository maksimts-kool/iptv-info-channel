//! Public, token-scoped email sign-up, reached from the intro-slide QR at
//! `/sub/:token`. The token is the customer's separate `notify_token` (never
//! the stream token), so photographing the QR grants no stream access.
//! Double opt-in: a new/changed address gets a verification link and nothing
//! else until it is confirmed. The write endpoints are rate-limited per IP and
//! per customer so the confirmation mail can't be used as a spam relay.

use std::net::SocketAddr;
use std::sync::{Arc, LazyLock};

use axum::extract::{ConnectInfo, Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use super::ratelimit::RateLimiter;
use super::{AppState, client_ip};
use crate::data::store::setting_str;
use crate::notify::notify::validate_subscription;

const PAGE: &str = include_str!("assets/subscribe.html");
static LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter::new(10 * 60 * 1000, 5));

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sub/verify/{vtoken}", get(verify))
        .route("/sub/{token}", get(page).post(subscribe))
        .route("/sub/{token}/status", get(status))
        .route("/sub/{token}/unsubscribe", post(unsubscribe))
}

/// Minimal centered message page; the message is fixed server-side text.
fn result_page(message: &str) -> String {
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>Уведомления</title>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f5f5f5;color:rgba(0,0,0,0.88);display:grid;place-items:center;min-height:100vh;margin:0;padding:20px;text-align:center">
    <div style="max-width:420px;background:#fff;border:1px solid #f0f0f0;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#2563eb">Уведомления</div>
      <p style="font-size:16px;line-height:1.6;margin:14px 0 0">{message}</p>
    </div></body>"#
    )
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn page(State(st): State<AppState>, UrlPath(token): UrlPath<String>) -> Response {
    if st.store.user_by_notify_token(&token).is_none() {
        return (StatusCode::NOT_FOUND, Html(result_page("Ссылка недействительна."))).into_response();
    }
    // Embedded as a JSON string literal; the page renders all state through
    // textContent, so nothing is reflected as HTML.
    let literal = serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into()).replace('<', "\\u003c");
    Html(PAGE.replace("__TOKEN_JSON__", &literal)).into_response()
}

async fn status(State(st): State<AppState>, UrlPath(token): UrlPath<String>) -> Response {
    let Some(user) = st.store.user_by_notify_token(&token) else { return error(StatusCode::NOT_FOUND, "not found") };
    let sub = st.store.subscriber(user.id);
    let brand = setting_str(&st.store.settings(), "brand_name").filter(|b| !b.is_empty()).unwrap_or("IPTV-сервис").to_owned();
    let options = sub.as_ref().map_or_else(
        || json!({ "server": false, "expiry": true, "content": true, "news": true, "renewal": true }),
        |s| json!(s.options),
    );
    Json(json!({
        "brand": brand,
        "subscribed": sub.is_some(),
        "verified": sub.as_ref().is_some_and(|s| s.verified),
        "email": sub.as_ref().map(|s| s.email.clone()).unwrap_or_default(),
        "options": options,
    }))
    .into_response()
}

async fn subscribe(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    UrlPath(token): UrlPath<String>,
    body: Option<Json<Value>>,
) -> Response {
    let Some(user) = st.store.user_by_notify_token(&token) else { return error(StatusCode::NOT_FOUND, "not found") };
    let ip = client_ip(&headers, peer, st.config.trust_proxy);
    if LIMITER.hit(&format!("ip:{ip}")) || LIMITER.hit(&format!("uid:{}", user.id)) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много попыток. Попробуйте позже.");
    }
    let body = body.map_or(Value::Null, |Json(v)| v);
    let (email, options) = match validate_subscription(&body) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    let sub = match st.store.upsert_subscriber(user.id, &email, &options).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(target: "subscribe", error = %e, "saving subscription failed");
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Не удалось сохранить подписку");
        }
    };
    tracing::info!(target: "subscribe", user_id = user.id, verified = sub.verified, "subscription saved");
    if !sub.verified {
        st.notifier.send_verification(&user, &sub).await;
        return Json(json!({ "ok": true, "message": "Мы отправили письмо со ссылкой для подтверждения адреса. Уведомления начнут приходить после подтверждения." })).into_response();
    }
    Json(json!({ "ok": true, "message": "Настройки подписки сохранены." })).into_response()
}

/// The link from the verification email (a single-use token of its own).
async fn verify(State(st): State<AppState>, UrlPath(vtoken): UrlPath<String>) -> Response {
    let Some(sub) = st.store.subscriber_by_verify_token(&vtoken) else {
        return (StatusCode::NOT_FOUND, Html(result_page("Ссылка недействительна или уже использована."))).into_response();
    };
    let verified = match st.store.mark_verified(sub.user_id).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(target: "subscribe", error = %e, "verification failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Html(result_page("Не удалось подтвердить адрес. Попробуйте позже."))).into_response();
        }
    };
    tracing::info!(target: "subscribe", user_id = sub.user_id, "email verified");
    if let (Some(user), Some(v)) = (st.store.user(sub.user_id), verified) {
        // Best-effort "you're subscribed" mail.
        let notifier = Arc::clone(&st.notifier);
        tokio::spawn(async move {
            notifier.send_confirmation(&user, &v).await;
        });
    }
    Html(result_page("Адрес подтверждён. Подписка активна — теперь вы будете получать уведомления.")).into_response()
}

async fn unsubscribe(State(st): State<AppState>, UrlPath(token): UrlPath<String>) -> Response {
    let Some(user) = st.store.user_by_notify_token(&token) else { return error(StatusCode::NOT_FOUND, "not found") };
    if LIMITER.hit(&format!("uid:{}", user.id)) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много попыток. Попробуйте позже.");
    }
    if let Err(e) = st.store.remove_subscriber(user.id).await {
        tracing::error!(target: "subscribe", error = %e, "unsubscribe failed");
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Не удалось отписаться");
    }
    tracing::info!(target: "subscribe", user_id = user.id, "unsubscribed");
    Json(json!({ "ok": true, "message": "Вы отписались от уведомлений." })).into_response()
}
