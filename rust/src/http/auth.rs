//! The single admin user's session and the API's CSRF guard.
//!
//! The session cookie is an HMAC of the admin password keyed by the session
//! secret, so changing `ADMIN_PASSWORD` (or the secret) invalidates every
//! session. The CSRF token is derived the same way under a distinct label: a
//! cross-site page can neither read it (it comes from `/api/state`) nor set
//! the custom header, so a forged request can't carry it.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use hmac::{KeyInit, Mac};
use serde_json::json;
use sha2::Sha256;

use super::AppState;
use super::gateway::constant_time_eq;
use crate::config::Config;

pub const COOKIE_NAME: &str = "admin_session";
const MAX_AGE_SECONDS: u64 = 7 * 24 * 60 * 60;

fn hmac_hex(config: &Config, label: &str) -> String {
    let Ok(mut mac) = hmac::Hmac::<Sha256>::new_from_slice(config.session_secret.as_bytes()) else {
        return String::new();
    };
    mac.update(format!("{label}:{}", config.admin_password).as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn session_value(config: &Config) -> String {
    hmac_hex(config, "admin")
}

pub fn csrf_token(config: &Config) -> String {
    hmac_hex(config, "csrf")
}

pub fn check_password(config: &Config, given: &str) -> bool {
    constant_time_eq(given.as_bytes(), config.admin_password.as_bytes())
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

pub fn is_authed(config: &Config, headers: &HeaderMap) -> bool {
    cookie(headers, COOKIE_NAME).is_some_and(|v| constant_time_eq(v.as_bytes(), session_value(config).as_bytes()))
}

/// `Set-Cookie` for a fresh session (`HttpOnly`, `SameSite=Lax`, 7 days).
pub fn session_cookie(config: &Config) -> HeaderValue {
    let value = format!(
        "{COOKIE_NAME}={}; Path=/; Max-Age={MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax",
        session_value(config)
    );
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

pub fn clear_cookie() -> HeaderValue {
    HeaderValue::from_static("admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
}

/// Auth then CSRF for `/admin/api`: unauthenticated -> 401, authenticated but
/// forged -> 403. Safe methods pass the CSRF check so the SPA can read
/// `/api/state` to learn the token.
pub async fn require_admin(State(st): State<AppState>, req: Request, next: Next) -> Response {
    if !is_authed(&st.config, req.headers()) {
        return (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": "unauthorized" }))).into_response();
    }
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe {
        let given = req
            .headers()
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !constant_time_eq(given.as_bytes(), csrf_token(&st.config).as_bytes()) {
            return (
                StatusCode::FORBIDDEN,
                axum::Json(json!({ "error": "bad or missing CSRF token" })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(password: &str) -> Config {
        let mut c = Config::load(std::path::PathBuf::from("/nonexistent"));
        c.admin_password = password.into();
        c.session_secret = "secret".into();
        c
    }

    #[test]
    fn session_and_csrf_are_distinct_and_rotate_with_the_password() {
        let a = cfg("one");
        assert_ne!(session_value(&a), csrf_token(&a));
        assert_ne!(session_value(&a), session_value(&cfg("two")));
        assert!(check_password(&a, "one") && !check_password(&a, "on") && !check_password(&a, "two"));
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("x=1; {COOKIE_NAME}={}", session_value(&a))).unwrap(),
        );
        assert!(is_authed(&a, &h));
        assert!(!is_authed(&cfg("two"), &h));
    }
}
