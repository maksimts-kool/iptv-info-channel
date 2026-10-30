//! Bounded upstream HTTP fetches: every download has a timeout and a hard
//! byte cap, so a hostile or broken URL can't hang a request or exhaust
//! memory. Shared by the catalog refresh, the stream gateway and the provider
//! news watcher.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::HeaderMap;

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("upstream responded {0}")]
    Status(u16),
    #[error("response is larger than the {0} byte limit")]
    TooLarge(usize),
    #[error("{}", describe_http(.0))]
    Http(reqwest::Error),
}

impl FetchError {
    /// The failure in one word, for the channel diagnostics: the HTTP status
    /// ("502"), or `timeout`, `connect`, `too_large`.
    pub fn code(&self) -> String {
        match self {
            Self::Status(status) => status.to_string(),
            Self::TooLarge(_) => "too_large".to_owned(),
            Self::Http(e) if e.is_timeout() => "timeout".to_owned(),
            Self::Http(_) => "connect".to_owned(),
        }
    }
}

impl From<reqwest::Error> for FetchError {
    /// Upstream URLs carry provider credentials, so the URL is dropped
    /// before the error reaches a log line or the admin.
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e.without_url())
    }
}

/// reqwest's own message ("error sending request") plus its source chain,
/// which holds the actual cause: a timeout, refused connection, DNS failure.
fn describe_http(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        let msg = s.to_string();
        if !out.contains(&msg) {
            out.push_str(": ");
            out.push_str(&msg);
        }
        source = s.source();
    }
    out
}

/// A fetched body plus where it finally came from (after redirects) — HLS
/// relative URIs resolve against the final URL, not the requested one.
#[derive(Debug)]
pub struct Fetched {
    pub final_url: String,
    pub body: Vec<u8>,
}

impl Fetched {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// GET `url`, failing on a non-2xx status or a body over `max_bytes`.
pub async fn fetch_bounded(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Fetched, FetchError> {
    let res = client.get(url).headers(headers).timeout(timeout).send().await?;
    read_bounded(res, max_bytes, true).await
}

/// Read a response body under a byte cap. With `require_ok`, a non-2xx
/// status is an error.
pub async fn read_bounded(res: reqwest::Response, max_bytes: usize, require_ok: bool) -> Result<Fetched, FetchError> {
    if require_ok && !res.status().is_success() {
        return Err(FetchError::Status(res.status().as_u16()));
    }
    if res.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err(FetchError::TooLarge(max_bytes));
    }
    let final_url = res.url().to_string();
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len() + chunk.len() > max_bytes {
            return Err(FetchError::TooLarge(max_bytes));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Fetched { final_url, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transport_errors_name_the_cause_without_the_url() {
        // A port nothing listens on: the connection is refused.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let url = format!("http://127.0.0.1:{port}/ch1/mono.m3u8?token=secret-token");
        let err = fetch_bounded(
            &reqwest::Client::new(),
            &url,
            HeaderMap::new(),
            Duration::from_secs(5),
            1024,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(!err.contains("secret-token") && !err.contains("mono.m3u8"), "{err}");
        assert!(err.starts_with("error sending request: "), "{err}");
    }
}
