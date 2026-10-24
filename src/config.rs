//! Loads a `.env` file (if present) without external deps, then exposes a
//! typed config. A variable already set in the environment wins over the
//! `.env` file, so Docker/compose `environment:` values override it.
//!
//! The project root (data dir, music file, `.env`) is `APP_ROOT`, else the
//! working directory — the Docker image runs from `/app`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use jiff::tz::TimeZone;

/// Environment lookup with the `.env` file underneath it.
#[derive(Debug, Default)]
struct Env {
    file: HashMap<String, String>,
}

impl Env {
    fn load(root: &Path) -> Self {
        let mut file = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(root.join(".env")) {
            for raw in text.lines() {
                let line = raw.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let Some((key, val)) = line.split_once('=') else {
                    continue;
                };
                let mut val = val.trim();
                if val.len() >= 2
                    && ((val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')))
                {
                    val = &val[1..val.len() - 1];
                }
                file.insert(key.trim().to_owned(), val.to_owned());
            }
        }
        Self { file }
    }

    fn raw(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().or_else(|| self.file.get(key).cloned())
    }

    fn str(&self, key: &str, default: &str) -> String {
        self.raw(key)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| default.to_owned())
    }

    fn num<T: std::str::FromStr>(&self, key: &str, default: T) -> T {
        self.raw(key).and_then(|v| v.trim().parse().ok()).unwrap_or(default)
    }

    /// Defaults to `default` unless explicitly set to "false" (or "true").
    fn flag(&self, key: &str, default: bool) -> bool {
        match self.raw(key).map(|v| v.to_lowercase()) {
            Some(v) if v == "false" => false,
            Some(v) if !v.is_empty() => true,
            _ => default,
        }
    }
}

/// Express `trust proxy`: how many proxy hops to trust for the client IP.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustProxy {
    None,
    All,
    Hops(usize),
}

#[derive(Debug)]
pub struct SlideTimer {
    pub enabled: bool,
    pub font_file: String,
}

#[derive(Debug)]
pub struct Channel {
    pub account_slide_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub still_fps: u32,
    pub preset: String,
    pub hls_time: u32,
    pub live_loop: bool,
    pub slide_timer: SlideTimer,
    /// Info-channel encodes run at once (the queue holds the rest).
    pub workers: usize,
}

#[derive(Debug)]
pub struct Intro {
    pub enabled: bool,
    pub slide_seconds: f64,
    pub transition: String,
}

#[derive(Debug)]
pub struct StatusSlide {
    pub enabled: bool,
    pub seconds: f64,
}

#[derive(Debug)]
pub struct ProviderNews {
    pub enabled: bool,
    pub url: String,
    pub cookie: String,
    pub refresh_url: String,
    pub check_minutes: u64,
    pub max_age_hours: f64,
    pub timeout_ms: u64,
    pub ai_key: String,
    pub ai_model: String,
    pub ai_timeout_ms: u64,
}

#[derive(Debug)]
pub struct Catalog {
    pub fetch_timeout_ms: u64,
    pub max_bytes: usize,
    pub auto_refresh: bool,
    pub refresh_check_minutes: u64,
    pub default_interval_hours: f64,
    pub info_category_name: String,
}

#[derive(Debug)]
pub struct Gateway {
    /// Env default, overlaid at runtime by the admin's `gateway_enabled`.
    pub enabled: AtomicBool,
    pub log_requests: bool,
    pub device_idle_seconds: u64,
    /// How long the viewing history behind Статистика is kept.
    pub stats_retention_days: u64,
    pub manifest_timeout_ms: u64,
    pub manifest_max_bytes: usize,
}

#[derive(Debug)]
pub struct Foss {
    pub enabled: bool,
    pub provider_id: String,
    pub upstream_match_url: String,
}

#[derive(Debug)]
pub struct Epg {
    pub enabled: bool,
    pub days_ahead: i64,
    pub days_behind: i64,
    pub foss: Foss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailProvider {
    Brevo,
    Resend,
}

#[derive(Debug)]
pub struct Notify {
    /// Env default, overlaid at runtime by the admin's `notify_enabled`.
    pub enabled: AtomicBool,
    pub provider: MailProvider,
    pub api_key: String,
    pub from: String,
    pub from_name: String,
    pub dry_run: bool,
}

#[derive(Debug)]
pub struct Media {
    pub max_video_mb: u64,
    pub max_image_mb: u64,
    pub quota_mb: u64,
    pub fps: u32,
    pub preset: String,
    pub crf: u32,
    pub maxrate: String,
    pub font_dir: PathBuf,
}

#[derive(Debug)]
pub struct Config {
    pub root: PathBuf,
    pub database_url: String,
    pub port: u16,
    pub tz: TimeZone,
    pub tz_name: String,
    /// Baked into every generated `.m3u`/HLS URL. On a LAN this MUST be the
    /// host IP the box can reach, never localhost; off-LAN an https origin.
    pub public_base_url: String,
    pub admin_password: String,
    pub session_secret: String,
    pub trust_proxy: TrustProxy,
    pub ffmpeg_path: String,
    pub channel: Channel,
    pub intro: Intro,
    pub status_slide: StatusSlide,
    pub provider_news: ProviderNews,
    pub catalog: Catalog,
    pub gateway: Gateway,
    pub epg: Epg,
    pub notify: Notify,
    pub media: Media,
    pub expiring_threshold_days: i64,
    pub data_dir: PathBuf,
    pub media_dir: PathBuf,
    pub hls_dir: PathBuf,
    pub music_file: PathBuf,
    pub default_music_file: PathBuf,
    pub public_dir: PathBuf,
}

fn resolve(root: &Path, value: &str) -> PathBuf {
    let p = Path::new(value);
    if p.is_absolute() { p.to_path_buf() } else { root.join(p) }
}

impl Config {
    /// Read the environment (+ `.env`) into a config. Does no I/O beyond that.
    pub fn from_env() -> Self {
        let root = std::env::var_os("APP_ROOT")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        Self::load(root)
    }

    pub fn load(root: PathBuf) -> Self {
        let env = Env::load(&root);
        let tz_name = env.str("TZ", "Europe/Tallinn");
        let tz = TimeZone::get(&tz_name).unwrap_or(TimeZone::UTC);
        let port: u16 = env.num("PORT", 9222);
        let data_dir = resolve(&root, &env.str("DATA_DIR", "data"));
        let default_music_file = root.join("assets/music/background.mp3");
        let music_file = env
            .raw("MUSIC_FILE")
            .filter(|v| !v.is_empty())
            .map_or_else(|| default_music_file.clone(), |v| resolve(&root, &v));
        let trust_proxy = match env.raw("TRUST_PROXY").as_deref() {
            None | Some("" | "false") => TrustProxy::None,
            Some("true") => TrustProxy::All,
            Some(v) => v.parse().map_or(TrustProxy::None, TrustProxy::Hops),
        };

        Self {
            port,
            database_url: env.str("DATABASE_URL", ""),
            public_base_url: env
                .str("PUBLIC_BASE_URL", &format!("http://localhost:{port}"))
                .trim_end_matches('/')
                .to_owned(),
            admin_password: env.str("ADMIN_PASSWORD", "changeme"),
            session_secret: env.str("SESSION_SECRET", "please-change-this-to-a-long-random-string"),
            trust_proxy,
            ffmpeg_path: env.str("FFMPEG_PATH", "ffmpeg"),
            channel: Channel {
                account_slide_seconds: env.num("ACCOUNT_SLIDE_SECONDS", 15.0),
                width: env.num("CHANNEL_WIDTH", 1280),
                height: env.num("CHANNEL_HEIGHT", 720),
                fps: env.num("CHANNEL_FPS", 12),
                still_fps: env.num("CHANNEL_STILL_FPS", 4),
                preset: env.str("FFMPEG_PRESET", "ultrafast"),
                hls_time: env.num("HLS_TIME", 6),
                live_loop: env.flag("CHANNEL_LIVE_LOOP", true),
                workers: env.num("ENCODE_WORKERS", 2),
                slide_timer: SlideTimer {
                    enabled: env.flag("SLIDE_TIMER_ENABLED", true),
                    font_file: env.str("TIMER_FONT_FILE", ""),
                },
            },
            intro: Intro {
                enabled: env.flag("INTRO_ENABLED", true),
                slide_seconds: env.num("INTRO_SLIDE_SECONDS", 4.0),
                transition: env.str("INTRO_TRANSITION", "slideleft"),
            },
            status_slide: StatusSlide {
                enabled: env.flag("STATUS_SLIDE_ENABLED", true),
                seconds: env.num("STATUS_SLIDE_SECONDS", 12.0),
            },
            provider_news: ProviderNews {
                enabled: env.flag("PROVIDER_NEWS_ENABLED", false),
                url: env.str("PROVIDER_NEWS_URL", "https://tv.team/v3/news?page=1"),
                cookie: env.str("PROVIDER_NEWS_COOKIE", ""),
                refresh_url: env.str("PROVIDER_NEWS_REFRESH_URL", ""),
                check_minutes: env.num("PROVIDER_NEWS_CHECK_MINUTES", 15),
                max_age_hours: env.num("PROVIDER_NEWS_MAX_AGE_HOURS", 24.0),
                timeout_ms: env.num("PROVIDER_NEWS_TIMEOUT_MS", 15_000),
                ai_key: env.str("OPENROUTER_API_KEY", ""),
                ai_model: env.str("PROVIDER_NEWS_AI_MODEL", "openrouter/free"),
                ai_timeout_ms: env.num("PROVIDER_NEWS_AI_TIMEOUT_MS", 30_000),
            },
            catalog: Catalog {
                fetch_timeout_ms: env.num("CATALOG_FETCH_TIMEOUT_MS", 30_000),
                max_bytes: env.num("CATALOG_MAX_BYTES", 32 * 1024 * 1024),
                auto_refresh: env.flag("CATALOG_AUTO_REFRESH", true),
                refresh_check_minutes: env.num("CATALOG_REFRESH_CHECK_MINUTES", 5),
                default_interval_hours: env.num("CATALOG_REFRESH_INTERVAL_HOURS", 24.0),
                info_category_name: env.str("INFO_CATEGORY_NAME", "Информация"),
            },
            gateway: Gateway {
                enabled: AtomicBool::new(env.flag("STREAM_GATEWAY_ENABLED", false)),
                log_requests: env.flag("STREAM_GATEWAY_LOG", false),
                device_idle_seconds: env.num("STREAM_DEVICE_IDLE_SECONDS", 60),
                stats_retention_days: env.num::<u64>("STATS_RETENTION_DAYS", 90).clamp(1, 3650),
                manifest_timeout_ms: env.num("STREAM_GATEWAY_TIMEOUT_MS", 10_000),
                manifest_max_bytes: env.num("STREAM_GATEWAY_MAX_BYTES", 4 * 1024 * 1024),
            },
            epg: Epg {
                enabled: env.flag("EPG_ENABLED", true),
                days_ahead: env.num("EPG_DAYS_AHEAD", 7),
                days_behind: env.num("EPG_DAYS_BEHIND", 1),
                foss: Foss {
                    enabled: env.flag("EPG_FOSS_ENABLED", true),
                    provider_id: env.str("EPG_FOSS_PROVIDER_ID", "infochannel"),
                    upstream_match_url: env
                        .str("EPG_FOSS_UPSTREAM_MATCH_URL", "https://ottp.eu.org")
                        .trim_end_matches('/')
                        .to_owned(),
                },
            },
            notify: Notify {
                enabled: AtomicBool::new(env.flag("NOTIFY_ENABLED", false)),
                provider: if env.str("NOTIFY_PROVIDER", "brevo").eq_ignore_ascii_case("resend") {
                    MailProvider::Resend
                } else {
                    MailProvider::Brevo
                },
                api_key: env.str("NOTIFY_API_KEY", ""),
                from: env.str("NOTIFY_FROM", ""),
                from_name: env.str("NOTIFY_FROM_NAME", "IPTV Info Channel"),
                dry_run: env.flag("NOTIFY_DRY_RUN", false),
            },
            media: Media {
                max_video_mb: env.num("MEDIA_MAX_VIDEO_MB", 300),
                max_image_mb: env.num("MEDIA_MAX_IMAGE_MB", 20),
                quota_mb: env.num("MEDIA_QUOTA_MB", 2048),
                fps: env.num("MEDIA_FPS", 25),
                preset: env.str("MEDIA_PRESET", "veryfast"),
                crf: env.num("MEDIA_CRF", 24),
                maxrate: env.str("MEDIA_MAXRATE", "2500k"),
                font_dir: PathBuf::from(env.str("MEDIA_FONT_DIR", "/usr/share/fonts/opentype/inter")),
            },
            expiring_threshold_days: env.num("EXPIRING_THRESHOLD_DAYS", 7),
            media_dir: data_dir.join("media"),
            hls_dir: data_dir.join("hls"),
            public_dir: root.join("public/admin"),
            data_dir,
            music_file,
            default_music_file,
            tz,
            tz_name,
            root,
        }
    }

    /// Create the runtime directories.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for dir in [&self.data_dir, &self.hls_dir, &self.media_dir] {
            std::fs::create_dir_all(dir)?;
        }
        if let Some(parent) = self.music_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    pub fn gateway_enabled(&self) -> bool {
        self.gateway.enabled.load(Ordering::Relaxed)
    }

    pub fn set_gateway_enabled(&self, on: bool) {
        self.gateway.enabled.store(on, Ordering::Relaxed);
    }

    pub fn notify_enabled(&self) -> bool {
        self.notify.enabled.load(Ordering::Relaxed)
    }

    pub fn set_notify_enabled(&self, on: bool) {
        self.notify.enabled.store(on, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotenv_values_and_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "# c\nHLS_TIME=4\nINTRO_TRANSITION='fade'\nEPG_ENABLED=false\nPUBLIC_BASE_URL=https://x.example/\nDATABASE_URL=postgres://iptv:iptv@localhost/iptv\n",
        )
        .unwrap();
        let c = Config::load(dir.path().to_path_buf());
        assert_eq!(c.channel.hls_time, 4);
        assert_eq!(c.intro.transition, "fade");
        assert!(!c.epg.enabled);
        assert!(c.status_slide.enabled);
        assert_eq!(c.public_base_url, "https://x.example");
        assert_eq!(c.database_url, "postgres://iptv:iptv@localhost/iptv");
        assert_eq!(c.hls_dir, dir.path().join("data/hls"));
    }
}
