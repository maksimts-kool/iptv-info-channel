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
    #[error("{0}")]
    Http(#[from] reqwest::Error),
}

impl FetchError {
    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Http(e) if e.is_timeout())
    }
}

/// A fetched body plus where it finally came from (after redirects) — HLS
/// relative URIs resolve against the final URL, not the requested one.
#[derive(Debug)]
pub struct Fetched {
    pub final_url: String,
    pub status: u16,
    pub headers: HeaderMap,
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
    let status = res.status().as_u16();
    if require_ok && !res.status().is_success() {
        return Err(FetchError::Status(status));
    }
    if res.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err(FetchError::TooLarge(max_bytes));
    }
    let final_url = res.url().to_string();
    let headers = res.headers().clone();
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len() + chunk.len() > max_bytes {
            return Err(FetchError::TooLarge(max_bytes));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Fetched { final_url, status, headers, body })
}
