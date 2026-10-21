//! Every HTTP surface: the public playlist/stream routes, the FOSS guide, the
//! email sign-up page and the admin API. Handlers share one [`AppState`].

pub mod admin;
pub mod api;
pub mod auth;
pub mod catalog;
pub mod gateway;
pub mod media;
pub mod playlist;
pub mod ratelimit;
pub mod stats;
pub mod stream;
pub mod subscribe;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::config::{Config, TrustProxy};
use crate::data::store::Store;
use crate::encode::channel::ChannelEncoder;
use crate::media::build::MediaChannel;
use crate::news::providernews::ProviderNews;
use crate::notify::notify::Notifier;
use crate::playlist::catalog::Catalog;

/// Shared services, cheap to clone into every handler.
#[derive(Debug, Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Arc<Store>,
    pub catalog: Arc<Catalog>,
    pub http: reqwest::Client,
    pub news: Arc<ProviderNews>,
    pub notifier: Arc<Notifier>,
    pub channels: Arc<ChannelEncoder>,
    pub media: Arc<MediaChannel>,
    pub gateway: Arc<gateway::Gateway>,
}

/// `text/plain` response with a status.
pub fn text(status: StatusCode, body: impl Into<String>) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body.into(),
    )
        .into_response()
}

/// The no-store header trio every playlist/manifest carries: players cache
/// aggressively, and a cached answer would outlive a revocation.
pub fn no_store(headers: &mut HeaderMap) {
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
}

/// An HLS manifest response.
pub fn manifest(body: String) -> Response {
    let mut res = ([(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")], body).into_response();
    no_store(res.headers_mut());
    res
}

/// 302 + no-store. The provider URL is passed through byte for byte when it
/// is header-safe printable ASCII, because IPTV links carry characters
/// (`url|User-Agent=…`) that percent-encoding would break; anything else is
/// percent-encoded so the header stays valid.
pub fn redirect(url: &str) -> Response {
    let header_safe = !url.is_empty() && url.bytes().all(|b| (0x21..=0x7e).contains(&b));
    let location = if header_safe {
        url.to_owned()
    } else {
        percent_encoding::utf8_percent_encode(url, &LOCATION_ENCODE).to_string()
    };
    let mut res = text(StatusCode::FOUND, format!("Redirecting to {location}"));
    if let Ok(v) = HeaderValue::from_str(&location) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    no_store(res.headers_mut());
    res
}

/// What `encodeurl` escapes: controls, space, non-ASCII and a few delimiters.
const LOCATION_ENCODE: percent_encoding::AsciiSet = percent_encoding::CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'<')
    .add(b'>')
    .add(b'\\')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// `encodeURIComponent`.
pub fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, crate::encode::liveloop::NON_ALPHANUMERIC_KEEP_SAFE).to_string()
}

/// The client address, honouring the configured number of trusted proxies
/// (Express `trust proxy` semantics): with N hops, the address N entries back
/// from the socket in `X-Forwarded-For`.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr, trust: TrustProxy) -> String {
    let forwarded: Vec<String> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    let socket = match peer.ip() {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or_else(|| v6.to_string(), |v4| v4.to_string()),
        IpAddr::V4(v4) => v4.to_string(),
    };
    match trust {
        TrustProxy::None => socket,
        TrustProxy::All => forwarded.first().cloned().unwrap_or(socket),
        TrustProxy::Hops(n) => {
            // [socket, xff last, xff second-to-last, ...]
            let chain: Vec<String> = std::iter::once(socket).chain(forwarded.into_iter().rev()).collect();
            chain.get(n).or_else(|| chain.last()).cloned().unwrap_or_default()
        }
    }
}

/// The request's User-Agent ('' when absent).
pub fn user_agent(headers: &HeaderMap) -> String {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_proxy_hops() {
        let peer: SocketAddr = "10.0.0.1:5000".parse().unwrap();
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("1.1.1.1, 2.2.2.2"));
        assert_eq!(client_ip(&h, peer, TrustProxy::None), "10.0.0.1");
        assert_eq!(client_ip(&h, peer, TrustProxy::Hops(1)), "2.2.2.2");
        assert_eq!(client_ip(&h, peer, TrustProxy::Hops(2)), "1.1.1.1");
        assert_eq!(client_ip(&h, peer, TrustProxy::Hops(9)), "1.1.1.1");
        assert_eq!(client_ip(&h, peer, TrustProxy::All), "1.1.1.1");
    }

    #[test]
    fn redirect_keeps_iptv_suffix_verbatim() {
        let r = redirect("http://p/1.ts|User-Agent=VLC");
        assert_eq!(r.status(), StatusCode::FOUND);
        assert_eq!(r.headers()[header::LOCATION], "http://p/1.ts|User-Agent=VLC");
        let r = redirect("http://p/a b/канал.ts");
        assert_eq!(
            r.headers()[header::LOCATION],
            "http://p/a%20b/%D0%BA%D0%B0%D0%BD%D0%B0%D0%BB.ts"
        );
    }
}

#[cfg(test)]
mod route_tests;
