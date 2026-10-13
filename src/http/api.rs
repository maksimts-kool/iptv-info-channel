//! Shared plumbing for the JSON admin API: the error type every handler
//! returns, and small readers for loosely-typed request bodies (the admin UI
//! sends JSON whose types the validators check and report on, so bodies are
//! read as `Value` and validated explicitly).

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

/// A JSON `{ "error": … }` response.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not found")
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

/// Persistence and other unexpected failures: logged, reported as a 500.
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(target: "admin", error = %format!("{e:#}"), "request failed");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

pub type ApiResult = Result<Response, ApiError>;

/// `Json(value)` as an `Ok` response.
pub fn ok(value: Value) -> ApiResult {
    Ok(Json(value).into_response())
}

pub fn created(value: Value) -> ApiResult {
    Ok((StatusCode::CREATED, Json(value)).into_response())
}

/// An optional JSON body as a `Value` (`{}` when absent or not an object).
pub fn body(b: Option<Json<Value>>) -> Value {
    match b {
        Some(Json(v)) if v.is_object() => v,
        _ => json!({}),
    }
}

/// JS `String(x ?? '')` for a body field.
pub fn str_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// JS `Number(x)` for a body field (`None` = NaN).
pub fn num_of(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// Exact `YYYY-MM-DD`.
pub fn is_date(s: &str) -> bool {
    crate::core::util::parse_ymd(s).is_some()
}
