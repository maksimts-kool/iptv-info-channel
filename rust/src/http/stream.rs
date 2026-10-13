//! Public, token-scoped routes: the `.m3u`, the XMLTV guide, the stream
//! gateway, the HLS loops (with `Range`), and the OTT-play FOSS endpoints.

use std::io::SeekFrom;
use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path as UrlPath, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use super::gateway::{GateRequest, gate, is_locked};
use super::playlist::{PlaylistCfg, build_user_playlist, foss_logo_url, foss_provider_base_url, playlist_disposition, user_epg_url, user_stream_url};
use super::{AppState, client_ip, manifest, no_store, redirect, text, user_agent};
use crate::data::model::DecoratedUser;
use crate::data::store::setting_str;
use crate::encode::liveloop::build_live_playlist;
use crate::epg::epg::{EpgOptions, build_epg_xml};
use crate::epg::foss::{
    MatchHit, build_foss_channels_json, build_foss_epg_json, build_foss_logo_svg, build_match_channels_response,
    empty_logo_match_response, foss_id_hash, merge_match_channels_responses, normalize_foss_provider_id, parse_match_request,
};
use crate::playlist::devices::device_tag;
use crate::playlist::model::{INFO_MEDIA_CHANNEL_ID, Resolve, resolve_channel_access, resolve_user_channels};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/playlist.m3u", get(playlist_query))
        .route("/u/{token}/playlist.m3u", get(playlist_path))
        .route("/epg.xml", get(epg_query))
        .route("/u/{token}/epg.xml", get(epg_path))
        .route("/c/{token}/{id}", get(gate_legacy))
        .route("/c/{token}/{tag}/{id}", get(gate_tagged))
        .route("/c/{token}/{tag}/{id}/{sig}/{reference}", get(gate_variant))
        .route("/hls/{token}/{file}", get(hls_file))
        .route("/notice/devices/{file}", get(notice_file))
        .route("/m/{token}/{file}", get(media_file))
}

/// The OTT-play FOSS endpoints (mounted when FOSS EPG is enabled).
pub fn foss_router() -> Router<AppState> {
    Router::new()
        .route("/m3u/match-channels", post(match_channels).options(cors_preflight))
        .route("/m3u/match-logos", post(match_logos).options(cors_preflight))
        .route("/foss-epg/u/{token}/channels.json", get(foss_channels).options(cors_preflight))
        .route("/foss-epg/u/{token}/epg/{file}", get(foss_epg).options(cors_preflight))
        .route("/foss-epg/u/{token}/logo.svg", get(foss_logo).options(cors_preflight))
}

fn brand(st: &AppState) -> String {
    setting_str(&st.store.settings(), "brand_name").filter(|b| !b.is_empty()).unwrap_or("Мой IPTV-сервис").to_owned()
}

pub fn playlist_cfg(st: &AppState) -> PlaylistCfg<'_> {
    PlaylistCfg {
        base_url: &st.config.public_base_url,
        epg_enabled: st.config.epg.enabled,
        foss_enabled: st.config.epg.foss.enabled,
        foss_provider_id: &st.config.epg.foss.provider_id,
        gateway_enabled: st.config.gateway_enabled(),
    }
}

/// The customer's whole channel list, resolved on every request: the plan's
/// categories, their personal exceptions, the expiry gate, and the media
/// channel only once there is a loop for them. Also the admin's preview.
pub fn render_user_playlist(st: &AppState, user: &DecoratedUser, tag: &str) -> String {
    let catalog = st.catalog.read();
    let overrides = st.catalog.overrides(user.id);
    let plan = user.plan_category_set();
    let has_media = st.media.loop_dir_for(user).is_some();
    let entries: Vec<_> = resolve_user_channels(&catalog, Resolve { overrides: Some(&overrides), locked: is_locked(st, user), plan: Some(&plan) })
        .into_iter()
        .filter(|e| e.channel.id != INFO_MEDIA_CHANNEL_ID || has_media)
        .collect();
    let used: std::collections::HashSet<&str> = entries.iter().filter_map(|e| e.channel.source_id.as_deref()).collect();
    let epg_urls: Vec<String> =
        catalog.sources.iter().filter(|s| !s.epg_url.is_empty() && used.contains(s.id.as_str())).map(|s| s.epg_url.clone()).collect();
    build_user_playlist(&user.token, &user.username, &brand(st), &playlist_cfg(st), &entries, &epg_urls, tag)
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: String,
}

fn send_playlist(st: &AppState, headers: &HeaderMap, token: &str) -> Response {
    let Some(user) = st.store.user_by_token(token) else {
        tracing::warn!(target: "stream", "playlist requested with unknown token");
        return text(StatusCode::NOT_FOUND, "Unknown token");
    };
    let body = render_user_playlist(st, &user, &device_tag(&user_agent(headers)));
    let mut res = ([(header::CONTENT_TYPE, "application/x-mpegurl")], body).into_response();
    no_store(res.headers_mut());
    if let Ok(v) = HeaderValue::from_str(&playlist_disposition(&user.username)) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

async fn playlist_query(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<TokenQuery>) -> Response {
    if q.token.is_empty() {
        return text(StatusCode::BAD_REQUEST, "Missing ?token=");
    }
    send_playlist(&st, &headers, &q.token)
}

/// The clean per-user URL (preferred: a query string leaks via logs/Referer).
async fn playlist_path(State(st): State<AppState>, headers: HeaderMap, UrlPath(token): UrlPath<String>) -> Response {
    send_playlist(&st, &headers, &token)
}

fn epg_options<'a>(st: &'a AppState, brand: &'a str, incidents: &'a [crate::data::model::Incident], ahead: i64) -> EpgOptions<'a> {
    EpgOptions {
        brand,
        incidents,
        now: jiff::Timestamp::now(),
        tz: &st.config.tz,
        days_ahead: ahead,
        days_behind: st.config.epg.days_behind,
        expiring_threshold_days: st.config.expiring_threshold_days,
    }
}

fn send_epg(st: &AppState, token: &str) -> Response {
    if !st.config.epg.enabled {
        return text(StatusCode::NOT_FOUND, "EPG disabled");
    }
    let Some(user) = st.store.user_by_token(token) else {
        tracing::warn!(target: "stream", "EPG requested with unknown token");
        return text(StatusCode::NOT_FOUND, "Unknown token");
    };
    let (brand, incidents) = (brand(st), st.store.incidents());
    let xml = build_epg_xml(&user, &epg_options(st, &brand, &incidents, st.config.epg.days_ahead));
    let mut res = ([(header::CONTENT_TYPE, "application/xml; charset=utf-8")], xml).into_response();
    no_store(res.headers_mut());
    res
}

async fn epg_query(State(st): State<AppState>, Query(q): Query<TokenQuery>) -> Response {
    if q.token.is_empty() {
        return text(StatusCode::BAD_REQUEST, "Missing ?token=");
    }
    send_epg(&st, &q.token)
}

async fn epg_path(State(st): State<AppState>, UrlPath(token): UrlPath<String>) -> Response {
    send_epg(&st, &token)
}

// ---- Gateway routes ----

/// The ".m3u8" ending is required by ExoPlayer; older playlists carry the
/// extensionless form, so both are accepted.
fn strip_ext(s: &str) -> &str {
    s.strip_suffix(".m3u8").or_else(|| s.strip_suffix(".M3U8")).unwrap_or(s)
}

fn valid_tag(tag: &str) -> bool {
    (1..=40).contains(&tag.len()) && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

async fn gate_legacy(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    UrlPath((token, id)): UrlPath<(String, String)>,
) -> Response {
    let req = GateRequest {
        token: &token,
        tag: "",
        channel_id: strip_ext(&id),
        variant: None,
        ip: client_ip(&headers, peer, st.config.trust_proxy),
        user_agent: user_agent(&headers),
    };
    gate(&st, req).await
}

async fn gate_tagged(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    UrlPath((token, tag, id)): UrlPath<(String, String, String)>,
) -> Response {
    if !valid_tag(&tag) {
        return text(StatusCode::NOT_FOUND, "Not found");
    }
    let req = GateRequest {
        token: &token,
        tag: if tag == "_" { "" } else { &tag },
        channel_id: strip_ext(&id),
        variant: None,
        ip: client_ip(&headers, peer, st.config.trust_proxy),
        user_agent: user_agent(&headers),
    };
    gate(&st, req).await
}

async fn gate_variant(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    UrlPath((token, tag, id, sig, reference)): UrlPath<(String, String, String, String, String)>,
) -> Response {
    if !valid_tag(&tag) {
        return text(StatusCode::NOT_FOUND, "Not found");
    }
    let req = GateRequest {
        token: &token,
        tag: if tag == "_" { "" } else { &tag },
        channel_id: strip_ext(&id),
        variant: Some((&sig, &reference)),
        ip: client_ip(&headers, peer, st.config.trust_proxy),
        user_agent: user_agent(&headers),
    };
    gate(&st, req).await
}

// ---- Loop files ----

/// Only the playlist and numbered segments.
fn safe_file(file: &str) -> bool {
    file == "index.m3u8"
        || file
            .strip_prefix("seg_")
            .and_then(|r| r.strip_suffix(".ts"))
            .is_some_and(|n| n.len() >= 3 && n.bytes().all(|b| b.is_ascii_digit()))
}

async fn hls_file(State(st): State<AppState>, method: Method, headers: HeaderMap, UrlPath((token, file)): UrlPath<(String, String)>) -> Response {
    if !safe_file(&file) {
        return text(StatusCode::BAD_REQUEST, "Bad file");
    }
    let Some(user) = st.store.user_by_token(&token) else {
        tracing::warn!(target: "stream", %file, "HLS file requested with unknown token");
        return text(StatusCode::NOT_FOUND, "Unknown token");
    };
    if let Err(e) = st.channels.ensure_user_stream(&user).await {
        tracing::error!(target: "stream", user_id = user.id, username = %user.username, error = %e, "generation failed");
        return text(StatusCode::INTERNAL_SERVER_ERROR, "Stream generation failed");
    }
    serve_loop_file(&st, &method, &headers, &st.channels.user_hls_dir(user.id), &file).await
}

/// The global device-limit notice loop (no token: it carries only the brand).
async fn notice_file(State(st): State<AppState>, method: Method, headers: HeaderMap, UrlPath(file): UrlPath<String>) -> Response {
    if !safe_file(&file) {
        return text(StatusCode::BAD_REQUEST, "Bad file");
    }
    let dir = st.channels.notice_hls_dir();
    if !dir.join("index.m3u8").exists()
        && let Err(e) = st.channels.ensure_device_notice(false).await
    {
        tracing::error!(target: "stream", error = %e, "device-limit notice generation failed");
        return text(StatusCode::INTERNAL_SERVER_ERROR, "Stream generation failed");
    }
    serve_loop_file(&st, &method, &headers, &dir, &file).await
}

/// The media channel. The playlist is re-checked against the customer's
/// access on every refresh, so switching the channel off ends playback by
/// sending the player to their own info card.
async fn media_file(State(st): State<AppState>, method: Method, headers: HeaderMap, UrlPath((token, file)): UrlPath<(String, String)>) -> Response {
    if !safe_file(&file) {
        return text(StatusCode::BAD_REQUEST, "Bad file");
    }
    let Some(user) = st.store.user_by_token(&token) else {
        tracing::warn!(target: "stream", %file, "media channel requested with unknown token");
        return text(StatusCode::NOT_FOUND, "Unknown token");
    };
    let dir = st.media.loop_dir_for(&user);
    if file == "index.m3u8" {
        let allowed = {
            let catalog = st.catalog.read();
            let overrides = st.catalog.overrides(user.id);
            let plan = user.plan_category_set();
            resolve_channel_access(&catalog, INFO_MEDIA_CHANNEL_ID, Resolve { overrides: Some(&overrides), locked: is_locked(&st, &user), plan: Some(&plan) })
                .allowed
        };
        if !allowed || dir.is_none() {
            return redirect(&user_stream_url(&user.token, &st.config.public_base_url));
        }
    }
    let Some(dir) = dir else { return text(StatusCode::NOT_FOUND, "Not found") };
    serve_loop_file(&st, &method, &headers, &dir, &file).await
}

/// The playlist is served as an endless live loop (one shared timeline);
/// segments are served from disk with `Range`.
async fn serve_loop_file(st: &AppState, method: &Method, headers: &HeaderMap, dir: &Path, file: &str) -> Response {
    if file == "index.m3u8" && st.config.channel.live_loop {
        let d = dir.to_path_buf();
        let playlist = tokio::task::spawn_blocking(move || build_live_playlist(&d, crate::core::util::now_ms())).await.ok().flatten();
        if let Some(p) = playlist {
            return manifest(p);
        }
    }
    let path = dir.join(file);
    let content_type = if file.ends_with(".m3u8") { "application/vnd.apple.mpegurl" } else { "video/mp2t" };
    send_file_with_range(method, headers, &path, content_type).await
}

/// Parse `bytes=a-b` / `bytes=-n` against `total`. `Err(())` = unsatisfiable.
pub fn parse_range(header: &str, total: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let num = |s: &str| if s.is_empty() { Some(None) } else { s.parse::<u64>().ok().map(Some) };
    let (a, b) = (num(a)?, num(b)?);
    let (start, end) = match (a, b) {
        (None, None) => return None,
        // Suffix range: the final N bytes.
        (None, Some(n)) => (total.saturating_sub(n), total.saturating_sub(1)),
        (Some(s), None) => (s, total.saturating_sub(1)),
        (Some(s), Some(e)) => (s, e.min(total.saturating_sub(1))),
    };
    if total == 0 || start > end || start >= total {
        return Some(Err(()));
    }
    Some(Ok((start, end)))
}

/// Strict players (ExoPlayer/IJK) probe segments with `Range:` and stall on
/// a plain 200 that ignores it, so honour it with a 206.
pub async fn send_file_with_range(method: &Method, headers: &HeaderMap, path: &Path, content_type: &'static str) -> Response {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        tracing::warn!(target: "stream", path = %path.display(), "requested HLS file is missing");
        return text(StatusCode::NOT_FOUND, "Not found");
    };
    let total = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|h| parse_range(h, total));
    let (status, start, len) = match range {
        Some(Err(())) => {
            let mut res = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            if let Ok(v) = HeaderValue::from_str(&format!("bytes */{total}")) {
                res.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            return res;
        }
        Some(Ok((s, e))) => (StatusCode::PARTIAL_CONTENT, s, e - s + 1),
        None => (StatusCode::OK, 0, total),
    };
    let body = if *method == Method::HEAD {
        Body::empty()
    } else {
        if file.seek(SeekFrom::Start(start)).await.is_err() {
            return text(StatusCode::INTERNAL_SERVER_ERROR, "Read failed");
        }
        Body::from_stream(ReaderStream::new(file.take(len)))
    };
    let mut res = (status, body).into_response();
    let h = res.headers_mut();
    no_store(h);
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(v) = HeaderValue::from_str(&len.to_string()) {
        h.insert(header::CONTENT_LENGTH, v);
    }
    if status == StatusCode::PARTIAL_CONTENT
        && let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{}/{total}", start + len - 1))
    {
        h.insert(header::CONTENT_RANGE, v);
    }
    res
}

// ---- OTT-play FOSS ----

fn public(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    no_store(h);
    h.insert(header::EXPIRES, HeaderValue::from_static("0"));
    res
}

async fn cors_preflight() -> Response {
    let mut res = public(StatusCode::NO_CONTENT.into_response());
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
    res
}

fn plain(status: StatusCode, body: String) -> Response {
    public((status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response())
}

/// Resolves our own channels locally and merges OTT-play's own answer, so
/// this server works as a drop-in `!epg-server` in a combined playlist.
async fn match_channels(State(st): State<AppState>, body: Bytes) -> Response {
    let request = String::from_utf8_lossy(&body[..body.len().min(1 << 20)]).into_owned();
    let Some(parsed) = parse_match_request(&request) else { return plain(StatusCode::BAD_REQUEST, "Bad Request".into()) };
    let base = st.config.public_base_url.clone();
    let by_hash: std::collections::HashMap<u32, String> =
        st.store.users().into_iter().map(|u| (foss_id_hash(&u.token), u.token.clone())).collect();
    let provider = normalize_foss_provider_id(&st.config.epg.foss.provider_id);
    let local = build_match_channels_response(
        &parsed.channels,
        |c| {
            let hash: u32 = c.tvg_id_hash.parse().ok()?;
            let token = by_hash.get(&hash)?;
            Some(MatchHit { id_hash: hash.to_string(), provider_url: foss_provider_base_url(token, &base) })
        },
        &provider,
    );
    let mut out = local.clone();
    let upstream = &st.config.epg.foss.upstream_match_url;
    if !upstream.is_empty() {
        let res = st
            .http
            .post(format!("{upstream}/m3u/match-channels"))
            .header(header::CONTENT_TYPE, "text/plain")
            .body(request)
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => {
                if let Ok(t) = r.text().await {
                    out = merge_match_channels_responses(&local, &t);
                }
            }
            Ok(r) => tracing::warn!(target: "foss-epg", status = r.status().as_u16(), "upstream match server returned an error"),
            Err(e) => tracing::warn!(target: "foss-epg", error = %e, "upstream match server unavailable"),
        }
    }
    plain(StatusCode::OK, out)
}

async fn match_logos() -> Response {
    plain(StatusCode::OK, empty_logo_match_response())
}

async fn foss_channels(State(st): State<AppState>, UrlPath(token): UrlPath<String>) -> Response {
    let Some(user) = st.store.user_by_token(&token) else { return plain(StatusCode::NOT_FOUND, "Unknown token".into()) };
    let (brand, incidents) = (brand(&st), st.store.incidents());
    // channels.json matching needs the newest programme start in the future.
    let opts = epg_options(&st, &brand, &incidents, st.config.epg.days_ahead.max(1));
    let base = &st.config.public_base_url;
    // Exactly the url-tvg this customer's .m3u advertises.
    let epg_urls = if st.config.epg.enabled { vec![user_epg_url(&user.token, base)] } else { vec![] };
    let json = build_foss_channels_json(&user, &opts, &st.config.epg.foss.provider_id, &epg_urls, &foss_logo_url(&user.token, base));
    public(axum::Json(json).into_response())
}

async fn foss_epg(State(st): State<AppState>, UrlPath((token, file)): UrlPath<(String, String)>) -> Response {
    let Some(hash) = file.strip_suffix(".json").filter(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_digit())) else {
        return plain(StatusCode::BAD_REQUEST, "Bad file".into());
    };
    let Some(user) = st.store.user_by_token(&token) else { return plain(StatusCode::NOT_FOUND, "Unknown token".into()) };
    if hash.parse::<u64>().ok() != Some(u64::from(foss_id_hash(&user.token))) {
        tracing::warn!(target: "foss-epg", "EPG requested with mismatched hash");
        return plain(StatusCode::NOT_FOUND, "Not found".into());
    }
    let (brand, incidents) = (brand(&st), st.store.incidents());
    let opts = epg_options(&st, &brand, &incidents, st.config.epg.days_ahead.max(1));
    public(axum::Json(build_foss_epg_json(&user, &opts)).into_response())
}

async fn foss_logo(State(st): State<AppState>, UrlPath(token): UrlPath<String>) -> Response {
    if st.store.user_by_token(&token).is_none() {
        return plain(StatusCode::NOT_FOUND, "Unknown token".into());
    }
    let brand = setting_str(&st.store.settings(), "brand_name").unwrap_or("").to_owned();
    public(([(header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")], build_foss_logo_svg(&brand)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some(Ok((0, 99))));
        assert_eq!(parse_range("bytes=900-", 1000), Some(Ok((900, 999))));
        assert_eq!(parse_range("bytes=-100", 1000), Some(Ok((900, 999))));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some(Ok((0, 999))));
        assert_eq!(parse_range("bytes=1000-", 1000), Some(Err(())));
        assert_eq!(parse_range("bytes=-", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }

    #[test]
    fn file_and_tag_guards() {
        assert!(safe_file("index.m3u8") && safe_file("seg_000.ts") && safe_file("seg_1234.ts"));
        assert!(!safe_file("../db.json") && !safe_file("seg_1.ts") && !safe_file("loop.json"));
        assert!(valid_tag("_") && valid_tag("aB-9_x") && !valid_tag("") && !valid_tag("a/b"));
        assert_eq!(strip_ext("ch1.m3u8"), "ch1");
        assert_eq!(strip_ext("ch1"), "ch1");
    }
}
