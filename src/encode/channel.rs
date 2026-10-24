//! Generates each customer's looping HLS info channel (rendered frames +
//! background music, via ffmpeg) and keeps it fresh daily so "days left"
//! stays accurate.
//!
//! Behaviours to preserve:
//! - **Content-hash skip**: an unchanged stream (same SVGs, encode params and
//!   music) is not re-encoded unless forced.
//! - **In-flight abort**: a newer request for the same user cancels the
//!   running ffmpeg so the latest data wins.
//! - **One queue**: every encode goes through [`EncodeQueue`] (merged repeat
//!   requests, priorities, bounded workers, one retry) — see `queue`.
//! - **Atomic swap**: build in a temp dir on the SAME filesystem as the target
//!   (a cross-device rename fails with a mounted data volume), then replace.
//! - **Monotonic live counters**: a new generation starts past the previous
//!   one's window so open players reload instead of treating it as old.

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::FutureExt;
use jiff::Timestamp;
use serde::Serialize;
use serde_json::json;
use sha1::{Digest, Sha1};
use tokio::sync::{Mutex as AsyncMutex, OnceCell};
use tokio_util::sync::CancellationToken;

use super::channel_args::{EncodeParams, Extra, Slides, intro_ffmpeg_args, still_ffmpeg_args};
use super::ffmpeg::{RunError, run};
use super::liveloop::{LIVE_WINDOW_SEGMENTS, LoopStart, current_loop_position, write_loop_state};
use super::queue::{EncodeQueue, JobResult, Priority, Request};
use crate::config::Config;
use crate::core::activity::Activity;
use crate::core::util::now_ms;
use crate::data::model::DecoratedUser;
use crate::data::store::{Store, setting_str};
use crate::news::providernews::ProviderNews;
use crate::notify::notify::Notifier;
use crate::playlist::catalog::Catalog;
use crate::render::overlay::{
    Branding, PlanCard, RenderCtx, build_body_svg, build_brand_slide1_svg, build_device_limit_svg,
    build_status_slide_svg,
};
use crate::render::raster::Rasterizer;
use crate::render::status::{StatusSummary, status_summary, with_provider_notices};

const SIG_FILE: &str = "sig";

#[derive(Debug, thiserror::Error)]
pub enum GenError {
    #[error("user not found")]
    UserNotFound,
    #[error(transparent)]
    Run(#[from] RunError),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl GenError {
    pub fn is_aborted(&self) -> bool {
        matches!(self, Self::Run(e) if e.is_aborted())
    }
}

impl From<std::io::Error> for GenError {
    fn from(e: std::io::Error) -> Self {
        Self::Other(e.into())
    }
}

impl From<JobResult> for Result<PathBuf, GenError> {
    fn from(r: JobResult) -> Self {
        match r {
            JobResult::Encoded(p) | JobResult::UpToDate(p) => Ok(p),
            JobResult::Cancelled => Err(RunError::Aborted.into()),
            JobResult::NotFound => Err(GenError::UserNotFound),
            JobResult::Failed(e) => Err(GenError::Other(anyhow::anyhow!(e))),
        }
    }
}

/// A bulk rebuild in the queue, awaited by [`ChannelEncoder::finish_all`].
#[derive(Debug)]
pub struct QueuedBulk {
    pub batch_id: u64,
    pub users: usize,
    waiting: Vec<(i64, tokio::sync::oneshot::Receiver<JobResult>)>,
}

/// Result of one user in a bulk rebuild.
#[derive(Debug, Clone, Serialize)]
pub struct GenResult {
    pub id: i64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct ChannelEncoder {
    config: Arc<Config>,
    store: Arc<Store>,
    catalog: Arc<Catalog>,
    news: Arc<ProviderNews>,
    notifier: Arc<Notifier>,
    raster: Rasterizer,
    activity: Arc<Activity>,
    queue: EncodeQueue,
    music: OnceCell<PathBuf>,
    notice_lock: AsyncMutex<()>,
}

/// Remove a directory tree, ignoring "not there".
pub fn remove_dir(path: &Path) {
    if let Err(e) = std::fs::remove_dir_all(path)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), error = %e, "could not remove directory");
    }
}

/// A fresh build directory inside `parent` (same filesystem as the target).
pub fn make_build_dir(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(parent)?;
    let dir = parent.join(format!("{prefix}{}", crate::core::util::make_token(8)));
    std::fs::create_dir(&dir)?;
    Ok(dir)
}

/// Replace `final_dir` with `tmp` (remove + rename on the same filesystem).
pub fn swap_dir(tmp: &Path, final_dir: &Path) -> std::io::Result<()> {
    remove_dir(final_dir);
    std::fs::rename(tmp, final_dir)
}

fn mtime_ms(path: &Path) -> f64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn read_sig(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(SIG_FILE))
        .ok()
        .map(|s| s.trim().to_owned())
}

/// Starting counters past the previous generation's window.
pub fn next_loop_start(previous: Option<crate::encode::liveloop::Position>) -> LoopStart {
    previous.map_or_else(LoopStart::default, |p| LoopStart {
        base_seq: p.media_sequence + LIVE_WINDOW_SEGMENTS,
        base_discontinuity: p.discontinuity_sequence + 1,
        version: None,
    })
}

impl ChannelEncoder {
    pub fn new(
        config: Arc<Config>,
        store: Arc<Store>,
        catalog: Arc<Catalog>,
        news: Arc<ProviderNews>,
        notifier: Arc<Notifier>,
        raster: Rasterizer,
    ) -> Self {
        let activity = Arc::new(Activity::default());
        let queue = EncodeQueue::new(config.channel.workers, Arc::clone(&activity));
        Self {
            activity,
            queue,
            config,
            store,
            catalog,
            news,
            notifier,
            raster,
            music: OnceCell::new(),
            notice_lock: AsyncMutex::new(()),
        }
    }

    /// Start the queue's workers; each runs one encode at a time until the
    /// queue closes.
    pub fn start(self: &Arc<Self>) {
        for _ in 0..self.queue.workers() {
            let me = Arc::clone(self);
            tokio::spawn(async move {
                while let Some(job) = me.queue.next().await {
                    let run = me.encode_user(job.user_id, &job.reason, job.force, &job.cancel);
                    let result = match AssertUnwindSafe(run).catch_unwind().await {
                        Ok(Ok((path, true))) => JobResult::Encoded(path),
                        Ok(Ok((path, false))) => JobResult::UpToDate(path),
                        Ok(Err(e)) if e.is_aborted() => JobResult::Cancelled,
                        Ok(Err(GenError::UserNotFound)) => JobResult::NotFound,
                        Ok(Err(e)) => {
                            tracing::error!(target: "channel", user_id = job.user_id, reason = %job.reason, error = %e, "generation failed");
                            JobResult::Failed(e.to_string().chars().take(300).collect())
                        }
                        Err(_) => {
                            tracing::error!(target: "channel", user_id = job.user_id, "generation panicked");
                            JobResult::Failed("encoder panicked".to_owned())
                        }
                    };
                    me.queue.finish(job.id, &result);
                }
            });
        }
    }

    pub fn queue(&self) -> &EncodeQueue {
        &self.queue
    }

    /// Poked whenever background work the admin can watch changes.
    pub fn activity(&self) -> &Arc<Activity> {
        &self.activity
    }

    /// Queue one customer's stream without waiting for it.
    pub fn enqueue(&self, user_id: i64, reason: &str, priority: Priority) {
        if let Some(user) = self.store.user(user_id) {
            drop(self.queue.enqueue(&Request {
                user_id,
                label: user.username.clone(),
                reason: reason.to_owned(),
                priority,
                force: false,
            }));
        }
    }

    pub fn user_hls_dir(&self, user_id: i64) -> PathBuf {
        self.config.hls_dir.join(user_id.to_string())
    }

    pub fn playlist_path(&self, user_id: i64) -> PathBuf {
        self.user_hls_dir(user_id).join("index.m3u8")
    }

    pub fn notice_hls_dir(&self) -> PathBuf {
        self.config.hls_dir.join("_devices")
    }

    pub fn ctx(&self, now: Timestamp) -> RenderCtx<'_> {
        RenderCtx {
            width: self.config.channel.width,
            height: self.config.channel.height,
            now,
            tz: &self.config.tz,
            expiring_threshold_days: self.config.expiring_threshold_days,
        }
    }

    pub fn rasterizer(&self) -> &Rasterizer {
        &self.raster
    }

    /// Plans as the frames show them: their granted category names.
    pub fn plan_cards(&self) -> Vec<PlanCard> {
        self.store
            .plans()
            .into_iter()
            .map(|p| PlanCard {
                features: self.catalog.plan_category_names(&p.category_ids),
                id: p.id,
                name: p.name,
                price_cents: p.price_cents,
                currency: p.currency,
                billing_period: p.billing_period,
            })
            .collect()
    }

    /// The global status board model (`None` when the slide is off).
    pub fn status_model(&self, now: Timestamp) -> Option<StatusSummary> {
        self.config.status_slide.enabled.then(|| {
            with_provider_notices(
                status_summary(&self.store.incidents(), now, &self.config.tz, 90),
                &self.news.current_notices(),
                &self.config.tz,
            )
        })
    }

    /// The configured track, then the bundled one, with a synthesized
    /// placeholder as a last resort so a broken install can still encode.
    pub async fn ensure_music(&self) -> Result<PathBuf, GenError> {
        self.music
            .get_or_try_init(|| async {
                let usable = |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.len() > 0);
                let cfg = &self.config;
                if usable(&cfg.music_file) {
                    return Ok(cfg.music_file.clone());
                }
                if cfg.music_file != cfg.default_music_file && usable(&cfg.default_music_file) {
                    tracing::warn!(target: "music", configured = %cfg.music_file.display(), fallback = %cfg.default_music_file.display(), "configured background track missing; using bundled track");
                    return Ok(cfg.default_music_file.clone());
                }
                tracing::warn!(target: "music", file = %cfg.music_file.display(), "background track missing; synthesizing placeholder");
                if let Some(parent) = cfg.music_file.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let args: Vec<String> = [
                    "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=30", "-f", "lavfi", "-i", "sine=frequency=329.63:duration=30",
                    "-filter_complex",
                    "[0:a][1:a]amix=inputs=2,volume=0.18,afade=t=in:d=3,afade=t=out:st=27:d=3,aformat=channel_layouts=stereo",
                    "-c:a", "libmp3lame", "-q:a", "5",
                ]
                .iter()
                .map(|s| (*s).to_owned())
                .chain(std::iter::once(cfg.music_file.to_string_lossy().into_owned()))
                .collect();
                run(&cfg.ffmpeg_path, &args, "placeholder music synthesis", None).await?;
                Ok(cfg.music_file.clone())
            })
            .await
            .cloned()
    }

    /// Everything that affects a user's rendered stream, hashed. Hashing the
    /// SVG content (username, plan, status, days-left, date) plus the encode
    /// parameters lets an unchanged stream skip a fresh encode.
    fn stream_signature(&self, svgs: &[String], music: &Path, with_status: bool) -> String {
        let c = &self.config.channel;
        let payload = json!({
            // Bump when the encode math changes so existing streams re-encode.
            "v": 3,
            "svgs": svgs,
            "enc": {
                "W": c.width, "H": c.height, "fps": c.fps, "stillFps": c.still_fps, "preset": c.preset,
                "accountSlideSeconds": c.account_slide_seconds, "hlsTime": c.hls_time, "liveLoop": c.live_loop,
                "slideTimer": { "enabled": c.slide_timer.enabled, "fontFile": c.slide_timer.font_file },
                "intro": if self.config.intro.enabled { json!({ "slide": self.config.intro.slide_seconds, "transition": self.config.intro.transition }) } else { json!(false) },
                "status": if with_status { json!({ "seconds": self.config.status_slide.seconds }) } else { json!(false) },
            },
            "musicMtime": mtime_ms(music),
        });
        hex::encode(Sha1::digest(payload.to_string().as_bytes()))
    }

    /// Admin-panel view of running encodes (the original summary shape, plus
    /// the full queue under `queue`).
    pub fn generation_status(&self) -> serde_json::Value {
        let q = self.queue.snapshot();
        let active_batch = q.batches.iter().rfind(|b| b.finished_at.is_none());
        let started = q
            .running
            .iter()
            .map(|r| r.started_at.clone())
            .chain(active_batch.map(|b| b.started_at.clone()))
            .min();
        json!({
            "active": !q.running.is_empty() || q.queued_total > 0,
            "started_at": started,
            "reason": active_batch.map(|b| b.reason.clone()).or_else(|| q.running.last().and_then(|r| r.reasons.last().cloned())),
            "active_users": q.running.iter().map(|r| json!({ "id": r.user_id, "username": r.label })).collect::<Vec<_>>(),
            "bulk": active_batch.map(|b| json!({ "total": b.total, "completed": b.done })),
            "queued": q.queued_total,
            "queue": q,
        })
    }

    /// (Re)generate one customer's stream at admin priority. A newer request
    /// for the same user supersedes this one, and this call gets its result.
    pub async fn generate_for_user(&self, user_id: i64, reason: &str, force: bool) -> Result<PathBuf, GenError> {
        self.generate_with(user_id, reason, Priority::Admin, force).await
    }

    pub async fn generate_with(
        &self,
        user_id: i64,
        reason: &str,
        priority: Priority,
        force: bool,
    ) -> Result<PathBuf, GenError> {
        let user = self.store.user(user_id).ok_or(GenError::UserNotFound)?;
        let rx = self.queue.enqueue(&Request {
            user_id,
            label: user.username.clone(),
            reason: reason.to_owned(),
            priority,
            force,
        });
        rx.await.unwrap_or(JobResult::Cancelled).into()
    }

    async fn encode_user(
        &self,
        user_id: i64,
        reason: &str,
        force: bool,
        cancel: &CancellationToken,
    ) -> Result<(PathBuf, bool), GenError> {
        let started = Instant::now();
        // Re-read so the latest values are encoded, not a caller's snapshot.
        let user = self.store.user(user_id).ok_or(GenError::UserNotFound)?;
        let settings = self.store.settings();
        let brand = setting_str(&settings, "brand_name")
            .filter(|s| !s.is_empty())
            .unwrap_or("Мой IPTV-сервис")
            .to_owned();
        let tagline = setting_str(&settings, "tagline")
            .filter(|s| !s.is_empty())
            .unwrap_or("Информационный канал аккаунта")
            .to_owned();
        let plans = self.plan_cards();
        let music = self.ensure_music().await?;
        let now = Timestamp::now();
        let summary = self.status_model(now);
        // The sign-up QR only when the intro is on AND notifications are.
        let subscribe_url =
            (self.config.intro.enabled && self.notifier.enabled()).then(|| self.notifier.subscribe_url_for(&user));

        let ctx = self.ctx(now);
        let b = Branding {
            brand: &brand,
            tagline: &tagline,
        };
        let slide_svg = self
            .config
            .intro
            .enabled
            .then(|| build_brand_slide1_svg(&ctx, b, subscribe_url.as_deref()));
        let body_svg = build_body_svg(&ctx, &user, &plans, b);
        let status_svg = summary.as_ref().map(|s| build_status_slide_svg(&ctx, s, &brand));
        let svgs: Vec<String> = slide_svg
            .iter()
            .chain([&body_svg])
            .chain(status_svg.iter())
            .cloned()
            .collect();

        let final_dir = self.user_hls_dir(user.id);
        let signature = self.stream_signature(&svgs, &music, summary.is_some());
        if !force && self.playlist_path(user.id).exists() && read_sig(&final_dir).as_deref() == Some(signature.as_str())
        {
            tracing::info!(target: "channel", user_id = user.id, username = %user.username, %reason, "stream up to date; skipping encode");
            return Ok((self.playlist_path(user.id), false));
        }
        if cancel.is_cancelled() {
            return Err(RunError::Aborted.into());
        }
        tracing::info!(target: "channel", user_id = user.id, username = %user.username, %reason, "generating stream");

        let live = self.config.channel.live_loop;
        let previous = live.then(|| current_loop_position(&final_dir, now_ms())).flatten();
        let tmp = make_build_dir(&self.config.hls_dir, &format!(".build-{}-", user.id))?;
        let outcome = self
            .render_and_encode(&tmp, &music, slide_svg, body_svg, status_svg, &format!("HLS encode for user {}", user.id), cancel)
            .await
            .and_then(|()| {
                if live {
                    write_loop_state(&tmp, next_loop_start(previous), now_ms())?;
                }
                std::fs::write(tmp.join(SIG_FILE), &signature)?;
                let segments = std::fs::read_dir(&tmp)?.filter_map(Result::ok).filter(|e| e.path().extension().is_some_and(|x| x == "ts")).count();
                swap_dir(&tmp, &final_dir)?;
                tracing::info!(target: "channel", user_id = user.id, segments, duration_ms = started.elapsed().as_millis() as u64, "stream ready");
                Ok(())
            });
        if let Err(e) = outcome {
            remove_dir(&tmp);
            return Err(e);
        }
        Ok((self.playlist_path(user.id), true))
    }

    /// Rasterize the frames (off the async runtime) and run the encode.
    #[allow(clippy::too_many_arguments)]
    async fn render_and_encode(
        &self,
        tmp: &Path,
        music: &Path,
        slide_svg: Option<String>,
        body_svg: String,
        status_svg: Option<String>,
        label: &str,
        cancel: &CancellationToken,
    ) -> Result<(), GenError> {
        let (w, h) = (self.config.channel.width, self.config.channel.height);
        let raster = self.raster.clone();
        let dir = tmp.to_path_buf();
        let frames =
            tokio::task::spawn_blocking(move || -> anyhow::Result<(Option<PathBuf>, PathBuf, Option<PathBuf>)> {
                let render = |svg: &str, name: &str| -> anyhow::Result<PathBuf> {
                    let path = dir.join(name);
                    raster.render_to_file(svg, w, h, &path)?;
                    Ok(path)
                };
                let slide = slide_svg.as_deref().map(|s| render(s, "slide1.png")).transpose()?;
                let card = render(&body_svg, "card.png")?;
                let status = status_svg.as_deref().map(|s| render(s, "status.png")).transpose()?;
                Ok((slide, card, status))
            })
            .await
            .map_err(anyhow::Error::from)??;

        let params = EncodeParams::from_config(&self.config);
        let args = match &frames {
            (Some(slide), card, status) => intro_ffmpeg_args(
                &params,
                &Slides {
                    slide1: slide,
                    card,
                    status: status.as_deref(),
                },
                music,
                tmp,
            ),
            (None, card, status) => {
                let extras: Vec<Extra<'_>> = status
                    .iter()
                    .map(|f| Extra {
                        file: f,
                        seconds: params.status_seconds,
                    })
                    .collect();
                still_ffmpeg_args(&params, card, &extras, music, tmp)
            }
        };
        run(&self.config.ffmpeg_path, &args, label, Some(cancel)).await?;
        Ok(())
    }

    /// Rebuild every customer's stream through the queue and wait for it.
    pub async fn generate_all(&self, reason: &str) -> Vec<GenResult> {
        let bulk = self.queue_all(reason);
        self.finish_all(reason, bulk).await
    }

    /// Queue every customer's stream as one batch (behind single-customer
    /// work), without waiting.
    pub fn queue_all(&self, reason: &str) -> QueuedBulk {
        let users: Vec<(i64, String)> = self
            .store
            .users()
            .into_iter()
            .map(|u| (u.id, u.username.clone()))
            .collect();
        if users.len() > 1 {
            tracing::info!(target: "channel", %reason, users = users.len(), "rebuilding streams");
        }
        let (batch_id, waiting) = self.queue.enqueue_batch(reason, &users, Priority::Background);
        QueuedBulk {
            batch_id,
            users: users.len(),
            waiting,
        }
    }

    /// Wait for a queued bulk rebuild (and refresh the device-limit notice,
    /// which carries the brand too) and report each customer.
    pub async fn finish_all(&self, reason: &str, bulk: QueuedBulk) -> Vec<GenResult> {
        let started = Instant::now();
        // Skipped by its own signature when nothing it shows changed.
        if let Err(e) = self.ensure_device_notice(false).await {
            tracing::error!(target: "channel", error = %e, "device-limit notice generation failed");
        }
        let mut results = Vec::with_capacity(bulk.waiting.len());
        for (id, rx) in bulk.waiting {
            let result: Result<PathBuf, GenError> = rx.await.unwrap_or(JobResult::Cancelled).into();
            results.push(GenResult {
                id,
                ok: result.is_ok(),
                error: result.err().map(|e| e.to_string()),
            });
        }
        if bulk.users != 1 {
            let ok = results.iter().filter(|r| r.ok).count();
            tracing::info!(target: "channel", %reason, succeeded = ok, failed = results.len() - ok, duration_ms = started.elapsed().as_millis() as u64, "stream rebuild complete");
        }
        results
    }

    pub fn remove_user_hls(&self, user_id: i64) {
        self.queue.forget_user(user_id);
        remove_dir(&self.user_hls_dir(user_id));
    }

    /// Ensure a user's stream exists; generate it if missing.
    pub async fn ensure_user_stream(&self, user: &DecoratedUser) -> Result<PathBuf, GenError> {
        if self.playlist_path(user.id).exists() {
            return Ok(self.playlist_path(user.id));
        }
        tracing::warn!(target: "stream", user_id = user.id, username = %user.username, "playlist missing; starting lazy generation");
        self.generate_with(user.id, "lazy stream request", Priority::Viewer, false)
            .await
    }

    /// The global "too many devices" loop. Same still-card encode and live
    /// serving as an account card; re-encodes only when its look changes.
    pub async fn ensure_device_notice(&self, force: bool) -> Result<PathBuf, GenError> {
        let _guard = self.notice_lock.lock().await;
        let settings = self.store.settings();
        let brand = setting_str(&settings, "brand_name")
            .filter(|s| !s.is_empty())
            .unwrap_or("Мой IPTV-сервис")
            .to_owned();
        let music = self.ensure_music().await?;
        let now = Timestamp::now();
        let idle = self.config.gateway.device_idle_seconds;
        let svg = build_device_limit_svg(&self.ctx(now), &brand, idle);
        let c = &self.config.channel;
        let signature = hex::encode(Sha1::digest(
            json!({
                "v": 1,
                "svg": svg,
                "enc": { "W": c.width, "H": c.height, "stillFps": c.still_fps, "preset": c.preset, "accountSlideSeconds": c.account_slide_seconds, "hlsTime": c.hls_time, "liveLoop": c.live_loop },
                "musicMtime": mtime_ms(&music),
            })
            .to_string()
            .as_bytes(),
        ));
        let final_dir = self.notice_hls_dir();
        if !force
            && final_dir.join("index.m3u8").exists()
            && read_sig(&final_dir).as_deref() == Some(signature.as_str())
        {
            return Ok(final_dir);
        }
        let previous = c
            .live_loop
            .then(|| current_loop_position(&final_dir, now_ms()))
            .flatten();
        let tmp = make_build_dir(&self.config.hls_dir, ".build-devices-")?;
        let result: Result<(), GenError> = async {
            let png = tmp.join("notice.png");
            let raster = self.raster.clone();
            let (w, h, p) = (c.width, c.height, png.clone());
            tokio::task::spawn_blocking(move || raster.render_to_file(&svg, w, h, &p))
                .await
                .map_err(anyhow::Error::from)??;
            let args = still_ffmpeg_args(&EncodeParams::from_config(&self.config), &png, &[], &music, &tmp);
            run(
                &self.config.ffmpeg_path,
                &args,
                "HLS encode for the device-limit notice",
                None,
            )
            .await?;
            if c.live_loop {
                write_loop_state(&tmp, next_loop_start(previous), now_ms())?;
            }
            std::fs::write(tmp.join(SIG_FILE), &signature)?;
            swap_dir(&tmp, &final_dir)?;
            Ok(())
        }
        .await;
        if let Err(e) = result {
            remove_dir(&tmp);
            return Err(e);
        }
        tracing::info!(target: "channel", "device-limit notice ready");
        Ok(final_dir)
    }
}

/// Fire-and-forget regeneration helpers used by the HTTP layer: they queue
/// the work and return at once.
pub fn spawn_regen(encoder: &Arc<ChannelEncoder>, user_id: i64, reason: &'static str) {
    encoder.enqueue(user_id, reason, Priority::Admin);
}

/// Queue a bulk rebuild; returns its batch id.
pub fn spawn_regen_all(encoder: &Arc<ChannelEncoder>, reason: &'static str) -> u64 {
    let bulk = encoder.queue_all(reason);
    let batch_id = bulk.batch_id;
    let enc = Arc::clone(encoder);
    tokio::spawn(async move {
        enc.finish_all(reason, bulk).await;
    });
    batch_id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::liveloop::Position;

    #[test]
    fn next_generation_skips_past_the_window() {
        assert_eq!(next_loop_start(None).base_seq, 0);
        let s = next_loop_start(Some(Position {
            media_sequence: 10,
            discontinuity_sequence: 2,
        }));
        assert_eq!((s.base_seq, s.base_discontinuity), (18, 3));
    }

    #[test]
    fn swap_replaces_target() {
        let dir = tempfile::tempdir().unwrap();
        let final_dir = dir.path().join("1");
        std::fs::create_dir(&final_dir).unwrap();
        std::fs::write(final_dir.join("old"), "x").unwrap();
        let tmp = make_build_dir(dir.path(), ".build-1-").unwrap();
        std::fs::write(tmp.join("new"), "y").unwrap();
        swap_dir(&tmp, &final_dir).unwrap();
        assert!(final_dir.join("new").exists() && !final_dir.join("old").exists() && !tmp.exists());
    }
}
