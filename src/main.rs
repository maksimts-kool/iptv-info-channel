//! IPTV subscription server: curated provider catalog, per-customer `.m3u`
//! playlists, and the built-in info and media channels.
//!
//! ```text
//! iptv-server                         run the server
//! iptv-server import-json [DIR] [--force]   move db.json/catalog.json into PostgreSQL
//! iptv-server seed                    create demo customers (no-op if any exist)
//! ```

// Tests favour readability over these pedantic lints.
#![cfg_attr(
    test,
    allow(
        clippy::assert_is_empty,
        clippy::bool_assert_comparison,
        clippy::cloned_ref_to_slice_refs,
        clippy::inconsistent_struct_constructor,
        clippy::needless_pass_by_value,
        clippy::semicolon_if_nothing_returned
    )
)]

mod config;
mod core;
mod data;
mod encode;
mod epg;
mod http;
mod media;
mod news;
mod notify;
mod playlist;
mod render;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::Router;
use axum::http::header;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use jiff::{ToSpan, Zoned};
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::data::store::Store;
use crate::encode::channel::ChannelEncoder;
use crate::http::AppState;
use crate::playlist::catalog::{Catalog, CatalogSettings};

fn init_logging() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,tower_http=warn")),
        )
        .with_target(true)
        .init();
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_logging();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = Arc::new(Config::from_env());
    config.ensure_dirs().context("creating runtime directories")?;
    anyhow::ensure!(
        !config.database_url.is_empty(),
        "DATABASE_URL is not set (postgres://user:pass@host:5432/db)"
    );
    let pool = data::db::connect(&config.database_url).await?;

    match args.first().map(String::as_str) {
        Some("import-json") => {
            let force = args.iter().any(|a| a == "--force");
            let dir = args
                .iter()
                .skip(1)
                .find(|a| !a.starts_with("--"))
                .map_or_else(|| config.data_dir.clone(), Into::into);
            let report = data::import::import_json(&pool, &dir, force, &config.catalog.info_category_name).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Some("seed") => {
            let store = Store::open(pool).await?;
            let created = store.seed_demo().await?;
            if created.is_empty() {
                println!("customers already exist; nothing seeded");
            }
            for u in created {
                println!(
                    "created {} -> {}/u/{}/playlist.m3u",
                    u.username, config.public_base_url, u.token
                );
            }
            Ok(())
        }
        Some(other) if other != "serve" => {
            anyhow::bail!("unknown command {other:?} (expected serve, import-json or seed)")
        }
        _ => serve(config, pool).await,
    }
}

pub(crate) async fn build_state(config: Arc<Config>, pool: sqlx::PgPool) -> anyhow::Result<AppState> {
    let http = reqwest::Client::builder()
        .user_agent("iptv-server")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .context("building the HTTP client")?;
    let store = Arc::new(Store::open(pool.clone()).await?);
    let catalog = Arc::new(
        Catalog::open(
            pool.clone(),
            CatalogSettings {
                info_category_name: config.catalog.info_category_name.clone(),
                default_interval_hours: config.catalog.default_interval_hours,
                fetch_timeout: Duration::from_millis(config.catalog.fetch_timeout_ms),
                max_bytes: config.catalog.max_bytes,
            },
            http.clone(),
        )
        .await?,
    );
    // Admin toggles overlay the env defaults.
    if let Some(on) = store.setting("notify_enabled").and_then(|v| v.as_bool()) {
        config.set_notify_enabled(on);
    }
    if let Some(on) = store.setting("gateway_enabled").and_then(|v| v.as_bool()) {
        config.set_gateway_enabled(on);
    }
    let news = Arc::new(news::providernews::ProviderNews::new(
        Arc::clone(&config),
        Arc::clone(&store),
        http.clone(),
    ));
    let notifier = Arc::new(notify::notify::Notifier::new(
        Arc::clone(&config),
        Arc::clone(&store),
        http.clone(),
    ));
    let raster = render::raster::Rasterizer::new(&config.media.font_dir);
    let channels = Arc::new(ChannelEncoder::new(
        Arc::clone(&config),
        Arc::clone(&store),
        Arc::clone(&catalog),
        Arc::clone(&news),
        Arc::clone(&notifier),
        raster,
    ));
    channels.start();
    let media_store = Arc::new(
        media::store::MediaStore::open(pool, media::store::MediaDirs::new(&config.media_dir, &config.hls_dir)).await?,
    );
    let media = Arc::new(media::build::MediaChannel::new(
        Arc::clone(&config),
        media_store,
        Arc::clone(&store),
        Arc::clone(&channels),
    ));
    let gateway = Arc::new(http::gateway::Gateway::new(config.gateway.device_idle_seconds));
    gateway.load_player_agents(data::watch::load_player_agents(store.pool()).await?);
    Ok(AppState {
        config,
        store,
        catalog,
        http,
        news,
        notifier,
        channels,
        media,
        gateway,
    })
}

const LANDING: &str = r#"<!doctype html><meta charset="utf-8">
  <title>IPTV Panel</title>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f5f5f5;color:rgba(0,0,0,0.88);display:grid;place-items:center;height:100vh;margin:0">
    <div style="text-align:center;background:#fff;border:1px solid #f0f0f0;border-radius:12px;padding:40px 48px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
      <h1 style="font-weight:600;margin:0 0 8px">IPTV Panel</h1>
      <p style="color:rgba(0,0,0,0.45);margin:0 0 16px">Per-customer playlist server is running.</p>
      <p style="margin:0"><a style="color:#2563eb;text-decoration:none;font-weight:500" href="/admin">Open admin panel →</a></p>
    </div>
  </body>"#;

pub fn app(state: AppState) -> Router {
    let mut router = Router::new().route("/", get(|| async { Html(LANDING) })).route(
        "/healthz",
        get(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":true}"#).into_response() }),
    );
    if state.config.epg.enabled && state.config.epg.foss.enabled {
        router = router.merge(http::stream::foss_router());
    }
    router
        .nest("/admin", http::admin::router(&state))
        .merge(http::subscribe::router())
        .merge(http::stream::router())
        .with_state(state)
}

/// Sleep until the next 00:05 in the configured zone, forever, then rebuild.
fn start_daily_refresh(st: AppState) {
    tokio::spawn(async move {
        loop {
            let now = Zoned::now().with_time_zone(st.config.tz.clone());
            let today = now.date().at(0, 5, 0, 0).to_zoned(st.config.tz.clone());
            let next = match today {
                Ok(t) if t > now => Some(t),
                Ok(t) => t.checked_add(1.day()).ok(),
                Err(_) => None,
            };
            let wait = next
                .and_then(|n| now.until(&n).ok())
                .and_then(|s| Duration::try_from(s).ok())
                .unwrap_or(Duration::from_secs(3600));
            tokio::time::sleep(wait).await;
            tracing::info!(target: "scheduler", "daily refresh triggered");
            // Safety net for source intervals that elapsed while we were down.
            if st.config.catalog.auto_refresh {
                let results = st.catalog.refresh_due().await;
                tracing::info!(target: "scheduler", sources = results.len(), failed = results.iter().filter(|r| !r.ok).count(), "playlist sources refreshed");
            }
            st.channels.generate_all("daily refresh").await;
            let sent = st.notifier.expiry_sweep().await;
            if sent > 0 {
                tracing::info!(target: "notify", count = sent, "expiry warnings sent");
            }
        }
    });
}

fn start_background(st: &AppState) {
    start_daily_refresh(st.clone());
    if st.config.catalog.auto_refresh {
        let s = st.clone();
        let every = Duration::from_secs(st.config.catalog.refresh_check_minutes.max(1) * 60);
        tracing::info!(target: "catalog", check_every_minutes = every.as_secs() / 60, "source auto-refresh scheduler started");
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            tick.tick().await;
            loop {
                tick.tick().await;
                s.catalog.refresh_due().await;
            }
        });
    }
    if st.config.status_slide.enabled {
        let channels = Arc::clone(&st.channels);
        st.news.start_watcher(move || {
            encode::channel::spawn_regen_all(&channels, "provider service notices changed");
        });
    }
    let gw = Arc::clone(&st.gateway);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            gw.sweep();
        }
    });
}

/// Write the viewing history every 30 seconds; prune it once an hour.
fn start_watch_history(st: &AppState) {
    let st = st.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        let mut ticks: u64 = 0;
        loop {
            tick.tick().await;
            http::stats::flush_history(&st).await;
            if ticks.is_multiple_of(120) {
                http::stats::prune_history(&st).await;
            }
            ticks += 1;
        }
    });
}

async fn serve(config: Arc<Config>, pool: sqlx::PgPool) -> anyhow::Result<()> {
    let st = build_state(Arc::clone(&config), pool).await?;
    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!(target: "startup", listening = %addr, admin = %format!("{}/admin", config.public_base_url), "server started");
    tracing::info!(target: "startup",
        users = st.store.users().len(), plans = st.store.plans().len(),
        channels = st.catalog.read().channels.iter().filter(|c| !c.missing).count(),
        sources = st.catalog.read().sources.len(),
        resolution = %format!("{}x{}", config.channel.width, config.channel.height),
        intro = config.intro.enabled, stream_gateway = config.gateway_enabled(), timezone = %config.tz_name,
        "configuration");

    // Startup pre-generation runs in the background so the server answers
    // right away; a request for a missing stream generates it on demand.
    let pregen = st.clone();
    tokio::spawn(async move {
        if let Err(e) = pregen.channels.ensure_music().await {
            tracing::error!(target: "startup", error = %e, "background music unavailable");
        }
        pregen.channels.generate_all("startup pre-generation").await;
        // The media channel: clear half-received uploads and unreferenced
        // files, then make sure the loops match the articles.
        match pregen.media.store.sweep_orphans().await {
            Ok(n) if n > 0 => tracing::info!(target: "media", files = n, "removed unreferenced media files"),
            Ok(_) => {}
            Err(e) => tracing::error!(target: "startup", error = %e, "media sweep failed"),
        }
        if let Err(e) = pregen.media.build("startup", false).await {
            tracing::error!(target: "startup", error = %e, "media channel build issue");
        }
        start_background(&pregen);
        tracing::info!(target: "startup", "ready");
    });

    start_watch_history(&st);
    let history = st.clone();
    let activity = Arc::clone(st.channels.activity());
    axum::serve(listener, app(st).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            // Live job feeds end so open admin tabs don't hold the drain.
            activity.close();
        })
        .await
        .context("HTTP server")?;
    // Queued encodes are dropped and running ffmpeg stopped; the next start
    // rebuilds whatever is stale.
    history.channels.queue().close();
    tracing::info!(target: "shutdown", "HTTP server closed");
    // Watches still open are written up to their last request.
    http::stats::flush_history(&history).await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = term => {},
    }
    tracing::warn!(target: "shutdown", "signal received; closing HTTP server");
}
