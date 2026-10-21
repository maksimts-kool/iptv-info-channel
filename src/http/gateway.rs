//! The stream gateway: `/c/:token[/:tag]/:id.m3u8` and the signed variant
//! playlists behind it.
//!
//! It re-resolves the customer's entitlement on EVERY manifest fetch, then
//! serves the provider's manifest with its URIs rewritten to absolute provider
//! URLs (no redirect — a cross-protocol 302 is refused by Android players).
//! Only the manifest passes through; segments go provider -> player.
//!
//! - Master playlists hand out their variants as signed `/c/…/<sig>/<ref>`
//!   links back here, so a revocation lands while the customer watches.
//! - A refusal mid-view is a SPLICE (provider's last window + our own loop as
//!   the continuation), sticky until a fresh tune-in. A refusal at tune-in is
//!   a 302 to the customer's own info card (same origin, so no protocol issue).
//! - The device limit is enforced here (`playlist::devices`).
//! - Deliberately NOT gated on the gateway flag: playlists handed out while it
//!   was on stay in players and must keep working.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{KeyInit, Mac};
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use sha2::Sha256;

use super::playlist::{media_stream_url, notice_stream_url, user_stream_url};
use super::{AppState, enc, manifest, redirect, text};
use crate::core::fetch::fetch_bounded;
use crate::core::util::{AccountStatus, account_status, now_ms};
use crate::data::model::DecoratedUser;
use crate::encode::liveloop::{LIVE_WINDOW_SEGMENTS, Segment, loop_segments};
use crate::playlist::devices::{DeviceInfo, DeviceTracker, ListedDevice, device_key};
use crate::playlist::hls::{
    MediaPlaylist, Splice, build_spliced_playlist, is_hls_url, is_master_playlist, parse_media_playlist,
    rewrite_hls_manifest,
};
use crate::playlist::model::{
    INFO_CHANNEL_ID, INFO_MEDIA_CHANNEL_ID, INFO_MEDIA_DEFAULT_NAME, Resolve, resolve_channel_access,
};
use crate::playlist::watch::{WatchHit, WatchRow, WatchTracker};

const SESSION_TTL_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    Access,
    Devices,
}

#[derive(Debug, Clone)]
enum Session {
    Master {
        last_seen: i64,
    },
    Media {
        last_seen: i64,
        snapshot: MediaPlaylist,
        snapshot_text: String,
        splice: Option<(i64, Refusal)>,
    },
}

impl Session {
    fn last_seen(&self) -> i64 {
        match self {
            Self::Master { last_seen } | Self::Media { last_seen, .. } => *last_seen,
        }
    }

    /// A refresh arrives every target duration; a much longer gap is a new
    /// tune-in, which starts clean (and ends any cut-over).
    fn is_stale(&self, now: i64) -> bool {
        let td = match self {
            Self::Media { snapshot, .. } => snapshot.target_duration,
            Self::Master { .. } => 6.0,
        };
        now - self.last_seen() > 15_000_i64.max((3.0 * td * 1000.0) as i64)
    }
}

/// In-memory gateway state: device slots, per-player playlist sessions and
/// the viewing history still being recorded.
#[derive(Debug)]
pub struct Gateway {
    devices: Mutex<DeviceTracker>,
    sessions: Mutex<HashMap<String, Session>>,
    watch: Mutex<WatchTracker>,
}

/// One device as the admin sees it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceView {
    pub ip: String,
    pub user_agent: String,
    pub channel: String,
    pub first_seen: String,
    pub last_seen: String,
    pub allowed: bool,
}

fn iso_ms(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms)
        .map(crate::core::util::iso)
        .unwrap_or_default()
}

impl Gateway {
    pub fn new(idle_seconds: u64) -> Self {
        Self {
            devices: Mutex::new(DeviceTracker::new(i64::try_from(idle_seconds).unwrap_or(60) * 1000)),
            sessions: Mutex::default(),
            watch: Mutex::default(),
        }
    }

    fn watch(&self) -> std::sync::MutexGuard<'_, WatchTracker> {
        self.watch.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Note that a device is playing a channel (any manifest or loop file).
    pub fn record_watch(&self, hit: &WatchHit<'_>) {
        self.watch().touch(hit, now_ms());
    }

    /// The watches changed since the last call, for the history table.
    pub fn take_watch_rows(&self) -> Vec<WatchRow> {
        self.watch().take_dirty(now_ms())
    }

    /// Rows whose write failed, to be retried.
    pub fn requeue_watch_rows(&self, rows: Vec<WatchRow>) {
        self.watch().requeue(rows);
    }

    /// The watches in progress right now.
    pub fn live_watches(&self) -> Vec<WatchRow> {
        self.watch().live(now_ms())
    }

    fn devices(&self) -> std::sync::MutexGuard<'_, DeviceTracker> {
        self.devices.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Who is watching one customer right now, oldest first.
    pub fn devices_of(&self, user: &DecoratedUser) -> Vec<DeviceView> {
        self.devices()
            .list(user.id, user.device_limit, now_ms())
            .into_iter()
            .map(|ListedDevice { device, allowed }| DeviceView {
                ip: device.info.ip,
                user_agent: device.info.ua,
                channel: device.info.channel,
                first_seen: iso_ms(device.first_seen),
                last_seen: iso_ms(device.last_seen),
                allowed,
            })
            .collect()
    }

    pub fn device_count(&self, user_id: i64) -> usize {
        self.devices().count(user_id, now_ms())
    }

    /// Drop a customer's devices and sessions (deleted account, new token).
    pub fn forget(&self, user_id: i64) {
        self.devices().forget(user_id);
        self.watch().forget(user_id);
        let prefix = format!("{user_id}|");
        self.sessions().retain(|k, _| !k.starts_with(&prefix));
    }

    /// Periodic cleanup of abandoned sessions.
    pub fn sweep(&self) {
        let cutoff = now_ms() - SESSION_TTL_MS;
        self.sessions().retain(|_, s| s.last_seen() >= cutoff);
    }
}

fn variant_signature(secret: &str, token: &str, channel_id: &str, url: &str) -> String {
    let Ok(mut mac) = hmac::Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return String::new();
    };
    mac.update(format!("gate:{token}:{channel_id}:{url}").as_bytes());
    let mut sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    sig.truncate(22);
    sig
}

fn variant_gate_url(st: &AppState, user: &DecoratedUser, tag: &str, channel_id: &str, url: &str) -> String {
    let tag = if tag.is_empty() { "_" } else { tag };
    format!(
        "{}/c/{}/{}/{}/{}/{}.m3u8",
        st.config.public_base_url,
        enc(&user.token),
        enc(tag),
        enc(channel_id),
        variant_signature(&st.config.session_secret, &user.token, channel_id, url),
        URL_SAFE_NO_PAD.encode(url)
    )
}

/// Verify a signed variant link; without the signature the route would be an
/// open fetch proxy.
fn decode_variant(st: &AppState, user: &DecoratedUser, channel_id: &str, sig: &str, reference: &str) -> Option<String> {
    let raw = reference
        .strip_suffix(".m3u8")
        .or_else(|| reference.strip_suffix(".M3U8"))
        .unwrap_or(reference);
    let url = String::from_utf8(URL_SAFE_NO_PAD.decode(raw.trim_end_matches('=')).ok()?).ok()?;
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return None;
    }
    let expected = variant_signature(&st.config.session_secret, &user.token, channel_id, &url);
    constant_time_eq(expected.as_bytes(), sig.as_bytes()).then_some(url)
}

/// The name a built-in channel is listed under in the statistics (the
/// account channel's playlist name is per customer, so it gets a fixed one).
pub fn builtin_channel_name(st: &AppState, channel_id: &str) -> String {
    let name = st.catalog.channel(channel_id).map(|c| c.name).unwrap_or_default();
    match channel_id {
        _ if !name.is_empty() => name,
        INFO_CHANNEL_ID => "Инфоканал".to_owned(),
        INFO_MEDIA_CHANNEL_ID => INFO_MEDIA_DEFAULT_NAME.to_owned(),
        _ => channel_id.to_owned(),
    }
}

/// Record a request for one of the built-in loops.
pub fn record_builtin_watch(st: &AppState, user: &DecoratedUser, channel_id: &str, ip: &str, user_agent: &str) {
    st.gateway.record_watch(&WatchHit {
        user_id: user.id,
        device: &device_key(ip, "", user_agent),
        channel_id,
        channel_name: &builtin_channel_name(st, channel_id),
        user_agent,
        ip,
    });
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether the account is expired or deactivated (the expiry gate).
pub fn is_locked(st: &AppState, user: &DecoratedUser) -> bool {
    matches!(
        account_status(
            user.active,
            user.expires_at.as_deref(),
            st.config.expiring_threshold_days,
            jiff::Timestamp::now(),
            &st.config.tz
        ),
        AccountStatus::Expired | AccountStatus::Disabled
    )
}

struct Filler {
    segments: Vec<Segment>,
    base: String,
}

/// The loop a refused viewer is cut over to, or `None` while it is not
/// encoded yet (an encode is started meanwhile).
fn filler_for(st: &AppState, user: &DecoratedUser, refusal: Refusal) -> Option<Filler> {
    let (dir, base): (PathBuf, String) = match refusal {
        Refusal::Devices => (
            st.channels.notice_hls_dir(),
            format!("{}/notice/devices/", st.config.public_base_url),
        ),
        Refusal::Access => (
            st.channels.user_hls_dir(user.id),
            format!("{}/hls/{}/", st.config.public_base_url, enc(&user.token)),
        ),
    };
    if let Some(segments) = loop_segments(&dir) {
        return Some(Filler { segments, base });
    }
    let channels = std::sync::Arc::clone(&st.channels);
    let user_id = user.id;
    tokio::spawn(async move {
        let result = match refusal {
            Refusal::Devices => channels.ensure_device_notice(false).await.map(|_| ()),
            Refusal::Access => channels
                .generate_for_user(user_id, "gateway filler", false)
                .await
                .map(|_| ()),
        };
        if let Err(e) = result {
            tracing::error!(target: "gateway", user_id, error = %e, "filler loop generation failed");
        }
    });
    None
}

/// The gate's inputs, from the route.
#[derive(Debug)]
pub struct GateRequest<'a> {
    pub token: &'a str,
    pub tag: &'a str,
    pub channel_id: &'a str,
    pub variant: Option<(&'a str, &'a str)>,
    pub ip: String,
    pub user_agent: String,
}

pub async fn gate(st: &AppState, req: GateRequest<'_>) -> Response {
    let Some(user) = st.store.user_by_token(req.token) else {
        tracing::warn!(target: "gateway", channel_id = req.channel_id, "channel requested with unknown token");
        return text(StatusCode::NOT_FOUND, "Unknown token");
    };
    let upstream = match req.variant {
        Some((sig, reference)) => match decode_variant(st, &user, req.channel_id, sig, reference) {
            Some(url) => Some(url),
            None => return text(StatusCode::NOT_FOUND, "Unknown playlist"),
        },
        None => None,
    };

    let now = now_ms();
    let device = device_key(&req.ip, req.tag, &req.user_agent);
    let prefix = format!("{}|{device}|{}|", user.id, req.channel_id);
    let session_key = format!("{prefix}{}", upstream.as_deref().unwrap_or(""));
    let session = {
        let mut sessions = st.gateway.sessions();
        if sessions.get(&session_key).is_some_and(|s| s.is_stale(now)) {
            sessions.remove(&session_key);
        }
        let current = sessions.get(&session_key).cloned();
        // The entry URL of a master is only fetched at tune-in: this is a zap
        // back onto the channel, so its variants start over.
        if req.variant.is_none() && !matches!(current, Some(Session::Media { .. })) {
            sessions.retain(|k, _| !k.starts_with(&prefix) || *k == session_key);
        }
        current
    };

    let (allowed, reason, channel_name, channel_url, is_info, is_media) = {
        let catalog = st.catalog.read();
        let plan = user.plan_category_set();
        let overrides = st.catalog.overrides(user.id);
        let access = resolve_channel_access(
            &catalog,
            req.channel_id,
            Resolve {
                overrides: Some(&overrides),
                locked: is_locked(st, &user),
                plan: Some(&plan),
            },
        );
        let ch = access.channel;
        (
            access.allowed,
            access.reason,
            ch.map(|c| {
                if c.name.is_empty() {
                    c.id.clone()
                } else {
                    c.name.clone()
                }
            })
            .unwrap_or_default(),
            ch.map(|c| c.url.clone()).unwrap_or_default(),
            ch.is_some_and(|c| c.id == INFO_CHANNEL_ID),
            ch.is_some_and(|c| c.id == INFO_MEDIA_CHANNEL_ID),
        )
    };
    let base = &st.config.public_base_url;
    if allowed && is_info {
        return redirect(&user_stream_url(&user.token, base));
    }
    if allowed && is_media {
        return redirect(&media_stream_url(&user.token, base));
    }
    // Non-HLS: nothing to rewrite. New playlists no longer point here for
    // those, but links already in players keep doing what they always did.
    if allowed && req.variant.is_none() && !is_hls_url(&channel_url) {
        return redirect(&channel_url);
    }

    let existing_splice = match &session {
        Some(Session::Media { splice, .. }) => *splice,
        _ => None,
    };
    let refusal = if !allowed {
        Some(Refusal::Access)
    } else if let Some((_, r)) = existing_splice {
        Some(r)
    } else {
        let info = DeviceInfo {
            ip: req.ip.clone(),
            ua: req.user_agent.clone(),
            channel: channel_name.clone(),
        };
        let slot = st
            .gateway
            .devices()
            .admit(user.id, &device, user.device_limit, info, now);
        (!slot.allowed).then_some(Refusal::Devices)
    };

    if let Some(refusal) = refusal {
        // Mid-view: continue the stream into our own loop instead of breaking it.
        if let Some(Session::Media {
            snapshot,
            snapshot_text,
            splice,
            ..
        }) = session
        {
            let (at, why) = splice.unwrap_or((now, refusal));
            if splice.is_none() {
                tracing::info!(target: "gateway", user_id = user.id, username = %user.username, channel_id = req.channel_id, reason = reason.as_str(),
                    "{}", if why == Refusal::Devices { "device limit reached; cutting the viewer over to the notice" } else { "channel revoked mid-view; cutting the viewer over to the info channel" });
            }
            st.gateway.sessions().insert(
                session_key,
                Session::Media {
                    last_seen: now,
                    snapshot: snapshot.clone(),
                    snapshot_text: snapshot_text.clone(),
                    splice: Some((at, why)),
                },
            );
            let Some(filler) = filler_for(st, &user, why) else {
                return manifest(snapshot_text);
            };
            let uri = |seg: &Segment, seq: i64| format!("{}{}?s={seq}", filler.base, seg.file);
            return manifest(build_spliced_playlist(&Splice {
                provider: &snapshot,
                filler: &filler.segments,
                filler_uri: &uri,
                start_index: 0,
                elapsed_seconds: (now - at) as f64 / 1000.0,
                window: LIVE_WINDOW_SEGMENTS as usize,
            }));
        }
        // Tune-in: send them to the card that explains it (a 403 reads as a
        // broken server in a player).
        tracing::info!(target: "gateway", user_id = user.id, username = %user.username, channel_id = req.channel_id, reason = reason.as_str(),
            "{}", if refusal == Refusal::Devices { "device limit reached" } else { "channel denied" });
        if refusal == Refusal::Devices {
            let channels = std::sync::Arc::clone(&st.channels);
            tokio::spawn(async move {
                if let Err(e) = channels.ensure_device_notice(false).await {
                    tracing::error!(target: "gateway", error = %e, "device-limit notice failed");
                }
            });
            return redirect(&notice_stream_url(base));
        }
        return redirect(&user_stream_url(&user.token, base));
    }

    if st.config.gateway.log_requests {
        tracing::info!(target: "gateway", user_id = user.id, username = %user.username, channel = %channel_name, ua = %req.user_agent,
            "{}", if req.variant.is_some() { "variant refreshed" } else { "channel opened" });
    }

    let url = upstream.unwrap_or(channel_url);
    let mut headers = HeaderMap::new();
    // Providers routinely gate on the User-Agent; forward the player's.
    let ua = if req.user_agent.is_empty() {
        "VLC/3.0.20 LibVLC/3.0.20"
    } else {
        req.user_agent.as_str()
    };
    if let Ok(v) = HeaderValue::from_str(ua) {
        headers.insert(USER_AGENT, v);
    }
    let fetched = fetch_bounded(
        &st.http,
        &url,
        headers,
        Duration::from_millis(st.config.gateway.manifest_timeout_ms),
        st.config.gateway.manifest_max_bytes,
    )
    .await;
    match fetched {
        Ok(f) => {
            st.gateway.record_watch(&WatchHit {
                user_id: user.id,
                device: &device,
                channel_id: req.channel_id,
                channel_name: &channel_name,
                user_agent: &req.user_agent,
                ip: &req.ip,
            });
            let body = f.text();
            if is_master_playlist(&body) {
                st.gateway
                    .sessions()
                    .insert(session_key, Session::Master { last_seen: now });
                let gate = |abs: &str| variant_gate_url(st, &user, req.tag, req.channel_id, abs);
                return manifest(rewrite_hls_manifest(&body, &f.final_url, Some(&gate)));
            }
            let rewritten = rewrite_hls_manifest(&body, &f.final_url, None);
            st.gateway.sessions().insert(
                session_key,
                Session::Media {
                    last_seen: now,
                    snapshot: parse_media_playlist(&rewritten),
                    snapshot_text: rewritten.clone(),
                    splice: None,
                },
            );
            manifest(rewritten)
        }
        Err(e) => {
            tracing::error!(target: "gateway", user_id = user.id, channel_id = req.channel_id, error = %e, "upstream manifest fetch failed");
            text(StatusCode::BAD_GATEWAY, "Upstream unavailable")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_bind_token_channel_and_url() {
        let a = variant_signature("s", "tok", "ch", "http://p/v.m3u8");
        assert_eq!(a.len(), 22);
        assert_ne!(a, variant_signature("s", "tok2", "ch", "http://p/v.m3u8"));
        assert_ne!(a, variant_signature("s", "tok", "ch2", "http://p/v.m3u8"));
        assert_ne!(a, variant_signature("s", "tok", "ch", "http://evil/"));
        assert!(
            constant_time_eq(b"abc", b"abc") && !constant_time_eq(b"abc", b"abd") && !constant_time_eq(b"a", b"ab")
        );
    }
}
