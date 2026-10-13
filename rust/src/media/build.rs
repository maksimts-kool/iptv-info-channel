//! Turns the media channel's articles into the live loops served at
//! `/m/:token/` (see `encode::media` for the clip -> loop design).
//!
//! - Uploaded videos are re-encoded ONCE, one at a time, into the 720p copy
//!   that is kept; the upload is deleted afterwards.
//! - Each article becomes one clip, cached by a hash of everything that
//!   affects it, so a rebuild after editing one article re-encodes only it.
//! - The loop rebuild is debounced (a burst of edits = one build) and a newer
//!   build cancels a running one.
//! - Private content splits customers into VARIANTS: one loop per distinct
//!   "what this customer sees"; the public one at `hls/_media`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use super::doc::doc_asset_ids;
use super::model::{Article, Asset, AssetKind, AssetStatus};
use super::store::MediaStore;
use super::variants::{Viewer, articles_for, has_private_content, media_variants, variant_key};
use crate::config::Config;
use crate::core::util::{iso_now, now_ms};
use crate::data::model::DecoratedUser;
use crate::data::store::Store;
use crate::encode::channel::{ChannelEncoder, make_build_dir, next_loop_start, remove_dir, swap_dir};
use crate::encode::ffmpeg::{RunError, ffprobe_path, run};
use crate::encode::liveloop::{Position, current_loop_position, write_loop_state};
use crate::encode::media::{
    ClipInputs, ClipVideo, MediaParams, Probe, Timeline, TimelineVideo, article_clip_args, article_timeline, concat_list, loop_args,
    loop_repeats, probe_media, video_normalize_args, video_poster_args,
};
use crate::render::article::SLIDE_WIDTH;
use crate::render::media::{PageMedia, PlacedVideo, render_article_layer, render_indicator_png};
use crate::render::overlay::{RenderCtx, build_background_svg};
use crate::render::raster::Rasterizer;
use crate::render::text::TextMeasurer;

/// Bump when the look of an article changes, so cached clips re-render.
const CLIP_VERSION: u32 = 4;
/// Bump when the loop step itself changes, so existing loops rebuild.
const LOOP_VERSION: u32 = 2;
const SIG_FILE: &str = "sig";
/// An upload nobody saved — or an empty untitled article — is kept this long
/// (its editor may still be open), then swept.
const UNSAVED_TTL_MS: i64 = 6 * 60 * 60 * 1000;

fn hash(v: &Value) -> String {
    let mut h = hex::encode(Sha1::digest(v.to_string().as_bytes()));
    h.truncate(24);
    h
}

fn read_sig(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(SIG_FILE)).ok().map(|s| s.trim().to_owned())
}

fn loop_ready(dir: &Path) -> bool {
    dir.join("index.m3u8").exists()
}

fn mtime_ms(p: &Path) -> f64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// The admin page's view of the builder.
#[derive(Debug, Clone, Default, Serialize)]
pub struct BuildStatus {
    pub state: &'static str,
    pub error: Option<String>,
    pub built_at: Option<String>,
    pub started_at: Option<String>,
    pub seconds: f64,
    pub articles: usize,
    pub variants: usize,
    pub private_viewers: usize,
}

/// An article laid out: its page layer, timeline, and placed videos.
#[derive(Debug)]
pub struct Laid {
    pub layer_png: Vec<u8>,
    pub layer_height: u32,
    pub timeline: Timeline,
    pub videos: Vec<(PlacedVideo, Asset)>,
}

#[derive(Debug, Clone)]
struct Clip {
    file: PathBuf,
    seconds: f64,
}

#[derive(Debug)]
pub struct MediaChannel {
    config: Arc<Config>,
    pub store: Arc<MediaStore>,
    users: Arc<Store>,
    channels: Arc<ChannelEncoder>,
    raster: Rasterizer,
    measure: TextMeasurer,
    status: Mutex<BuildStatus>,
    pending: Mutex<Option<tokio::task::JoinHandle<()>>>,
    current: Mutex<Option<CancellationToken>>,
    build_lock: AsyncMutex<()>,
    video_lock: AsyncMutex<()>,
    video_jobs: Mutex<std::collections::HashMap<String, CancellationToken>>,
}

impl MediaChannel {
    pub fn new(config: Arc<Config>, store: Arc<MediaStore>, users: Arc<Store>, channels: Arc<ChannelEncoder>) -> Self {
        let raster = channels.rasterizer().clone();
        let measure = TextMeasurer::new(Arc::clone(raster.fontdb()));
        Self {
            config,
            store,
            users,
            channels,
            raster,
            measure,
            status: Mutex::new(BuildStatus { state: "idle", ..BuildStatus::default() }),
            pending: Mutex::default(),
            current: Mutex::default(),
            build_lock: AsyncMutex::new(()),
            video_lock: AsyncMutex::new(()),
            video_jobs: Mutex::default(),
        }
    }

    fn params(&self) -> MediaParams {
        MediaParams::from_config(&self.config)
    }

    fn status_mut(&self) -> std::sync::MutexGuard<'_, BuildStatus> {
        self.status.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Everything every clip depends on; a video copy made under another key
    /// is re-encoded from itself at the next build.
    pub fn encode_key(&self) -> String {
        let (c, m) = (&self.config.channel, &self.config.media);
        json!({ "W": c.width, "H": c.height, "seg": c.hls_time, "fps": m.fps, "preset": m.preset, "crf": m.crf, "maxrate": m.maxrate }).to_string()
    }

    pub fn public_loop_dir(&self) -> PathBuf {
        self.store.dirs.loop_dir()
    }

    fn variant_dir(&self, key: &str) -> PathBuf {
        self.store.dirs.variant_dir(&hash(&json!(key)))
    }

    /// On air when any loop exists.
    pub fn ready(&self) -> bool {
        loop_ready(&self.public_loop_dir()) || self.store.dirs.variant_dirs().iter().any(|d| loop_ready(d))
    }

    pub fn status_json(&self) -> Value {
        let mut v = json!(*self.status_mut());
        v["pending"] = json!(self.pending.lock().unwrap_or_else(PoisonError::into_inner).as_ref().is_some_and(|h| !h.is_finished()));
        v["ready"] = json!(self.ready());
        v["total_articles"] = json!(self.store.read().articles.len());
        v
    }

    /// The loop this customer is served, or `None` when there is nothing for
    /// them. A customer whose own variant isn't built yet gets the public
    /// loop meanwhile — a subset of what they may see.
    pub fn loop_dir_for(&self, user: &DecoratedUser) -> Option<PathBuf> {
        let public = self.public_loop_dir();
        let fallback = loop_ready(&public).then(|| public.clone());
        let articles = self.store.read().articles.clone();
        if !has_private_content(&articles) {
            return fallback;
        }
        let mine = variant_key(&articles_for(&articles, Viewer::Customer(user)));
        if mine != variant_key(&articles_for(&articles, Viewer::Public)) {
            let dir = self.variant_dir(&mine);
            if loop_ready(&dir) {
                return Some(dir);
            }
        }
        fallback
    }

    /// Customers moving between audiences can change what they see — but
    /// only when something is private at all.
    pub fn schedule_build_for_clients(self: &Arc<Self>, reason: &'static str) {
        if has_private_content(&self.store.read().articles) {
            self.schedule_build(reason);
        }
    }

    /// Rebuild after a short pause, so a burst of edits costs one build.
    pub fn schedule_build(self: &Arc<Self>, reason: &'static str) {
        let me = Arc::clone(self);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if let Err(e) = me.build(reason, false).await
                && !matches!(e.downcast_ref::<RunError>(), Some(RunError::Aborted))
            {
                tracing::warn!(target: "media", error = %e, "scheduled media build failed");
            }
        });
        if let Some(old) = self.pending.lock().unwrap_or_else(PoisonError::into_inner).replace(handle) {
            old.abort();
        }
    }

    /// Build now; a newer build cancels this one.
    pub async fn build(&self, reason: &str, force: bool) -> anyhow::Result<()> {
        let cancel = CancellationToken::new();
        if let Some(old) = self.current.lock().unwrap_or_else(PoisonError::into_inner).replace(cancel.clone()) {
            old.cancel();
        }
        let _guard = self.build_lock.lock().await;
        if cancel.is_cancelled() {
            return Err(RunError::Aborted.into());
        }
        let result = self.do_build(reason, force, &cancel).await;
        match &result {
            Err(e) if matches!(e.downcast_ref::<RunError>(), Some(RunError::Aborted)) => self.status_mut().state = "idle",
            Err(e) => {
                tracing::error!(target: "media", error = %e, "media loop build failed");
                let mut s = self.status_mut();
                s.state = "error";
                s.error = Some(e.to_string().chars().take(300).collect());
            }
            Ok(()) => {}
        }
        result
    }

    // ---- Uploads ----

    /// Queue an uploaded video (a `processing` asset) for its one-time
    /// encode. `raw` is deleted afterwards.
    pub fn queue_video(self: &Arc<Self>, asset_id: String, raw: PathBuf, probe: Probe) {
        let cancel = CancellationToken::new();
        self.video_jobs.lock().unwrap_or_else(PoisonError::into_inner).insert(asset_id.clone(), cancel.clone());
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let _one_at_a_time = me.video_lock.lock().await;
            me.process_video(&asset_id, &raw, probe, &cancel).await;
            let _ = std::fs::remove_file(&raw);
            me.video_jobs.lock().unwrap_or_else(PoisonError::into_inner).remove(&asset_id);
        });
    }

    /// Stop a video's encode (its article was deleted mid-way).
    pub fn cancel_video(&self, asset_id: &str) {
        if let Some(c) = self.video_jobs.lock().unwrap_or_else(PoisonError::into_inner).get(asset_id) {
            c.cancel();
        }
    }

    async fn encode_video_copy(&self, asset_id: &str, input: &Path, has_audio: bool, cancel: Option<&CancellationToken>) -> anyhow::Result<Asset> {
        let dirs = &self.store.dirs;
        let out = dirs.files.join(format!("{asset_id}.mp4"));
        let tmp = dirs.files.join(format!("{asset_id}.tmp.mp4"));
        let poster = dirs.thumbs.join(format!("{asset_id}.jpg"));
        let ffmpeg = &self.config.ffmpeg_path;
        let args = video_normalize_args(&self.params(), &input.to_string_lossy(), has_audio, &tmp.to_string_lossy());
        let encoded = run(ffmpeg, &args, &format!("media video encode {asset_id}"), cancel).await;
        if encoded.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        encoded?;
        std::fs::rename(&tmp, &out)?;
        run(ffmpeg, &video_poster_args(&out.to_string_lossy(), &poster.to_string_lossy()), &format!("media poster {asset_id}"), None).await?;
        let info = probe_media(&ffprobe_path(ffmpeg), &out.to_string_lossy()).await?;
        let mut a = self.store.asset(asset_id).ok_or(RunError::Aborted)?;
        a.file = Some(format!("{asset_id}.mp4"));
        a.thumb = Some(format!("{asset_id}.jpg"));
        a.width = info.width;
        a.height = info.height;
        a.duration = (info.duration * 1000.0).round() / 1000.0;
        a.has_audio = info.has_audio;
        a.size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        a.enc = Some(self.encode_key());
        Ok(a)
    }

    async fn process_video(self: &Arc<Self>, asset_id: &str, raw: &Path, probe: Probe, cancel: &CancellationToken) {
        let started = Instant::now();
        if cancel.is_cancelled() || self.store.asset(asset_id).is_none() {
            return;
        }
        match self.encode_video_copy(asset_id, raw, probe.has_audio, Some(cancel)).await {
            Ok(fields) => {
                let saved = self
                    .store
                    .update_asset(asset_id, |a| {
                        *a = Asset { status: AssetStatus::Ready, error: None, ..fields.clone() };
                    })
                    .await;
                if matches!(saved, Ok(Some(_))) {
                    tracing::info!(target: "media", %asset_id, duration_s = fields.duration, bytes = fields.size, duration_ms = started.elapsed().as_millis() as u64, "video ready");
                    self.schedule_build("video processed");
                }
            }
            Err(e) => {
                if self.store.asset(asset_id).is_none() {
                    // Deleted while encoding.
                    for f in [format!("{asset_id}.mp4"), format!("{asset_id}.tmp.mp4")] {
                        let _ = std::fs::remove_file(self.store.dirs.files.join(f));
                    }
                    let _ = std::fs::remove_file(self.store.dirs.thumbs.join(format!("{asset_id}.jpg")));
                } else if !matches!(e.downcast_ref::<RunError>(), Some(RunError::Aborted)) {
                    tracing::error!(target: "media", %asset_id, error = %e, "video processing failed");
                    let msg: String = e.to_string().chars().take(200).collect();
                    let _ = self.store.update_asset(asset_id, |a| {
                        a.status = AssetStatus::Error;
                        a.error = Some(msg);
                    }).await;
                }
            }
        }
    }

    /// A ready video whose copy was made under other encode settings: re-
    /// encoded from that copy (lossy, but only on a settings change).
    async fn refresh_video_copy(&self, asset: &Asset, cancel: &CancellationToken) -> anyhow::Result<()> {
        let Some(file) = self.store.dirs.asset_file(asset) else { return Ok(()) };
        let input = self.store.dirs.files.join(format!("{}.src.mp4", asset.id));
        std::fs::rename(&file, &input)?;
        let result = self.encode_video_copy(&asset.id, &input, asset.has_audio, Some(cancel)).await;
        match result {
            Ok(fields) => {
                let _ = std::fs::remove_file(&input);
                self.store.update_asset(&asset.id, |a| *a = Asset { status: a.status, error: a.error.clone(), ..fields }).await?;
                Ok(())
            }
            Err(e) => {
                let _ = std::fs::rename(&input, &file);
                Err(e)
            }
        }
    }

    // ---- Layout + clips ----

    /// The article's ready assets (a video still processing, or broken, is
    /// left out until it is ready).
    pub fn article_media(&self, article: &Article) -> Vec<Asset> {
        doc_asset_ids(&article.doc)
            .iter()
            .filter_map(|id| self.store.asset(id))
            .filter(|a| a.status == AssetStatus::Ready && self.store.dirs.asset_file(a).is_some_and(|f| f.exists()))
            .collect()
    }

    /// Lay an article out — shared by the encoder and the admin preview.
    pub fn layout_article(&self, article: &Article, media: &[Asset]) -> anyhow::Result<Option<Laid>> {
        let page_media: Vec<PageMedia> = media
            .iter()
            .filter_map(|a| {
                let picture = if a.kind == AssetKind::Video { self.store.dirs.asset_thumb(a) } else { self.store.dirs.asset_file(a) }?;
                Some(PageMedia { id: a.id.clone(), kind: a.kind, width: a.width, height: a.height, picture })
            })
            .collect();
        let (w, h) = (self.config.channel.width, self.config.channel.height);
        let Some(layer) = render_article_layer(&self.raster, &self.measure, &article.doc, &page_media, w, h)? else { return Ok(None) };
        let videos: Vec<(PlacedVideo, Asset)> =
            layer.videos.iter().filter_map(|v| media.iter().find(|m| m.id == v.asset_id).map(|m| (v.clone(), m.clone()))).collect();
        let tv: Vec<TimelineVideo> = videos
            .iter()
            .map(|(v, a)| TimelineVideo { y: v.y as f64, height: v.height as f64, focus: Some(v.focus as f64), duration: a.duration })
            .collect();
        let scale = f64::from(w) / f64::from(SLIDE_WIDTH);
        let timeline = article_timeline(
            f64::from(layer.height),
            f64::from(h),
            &tv,
            article.scroll_speed as f64 * scale,
            article.seconds as f64,
            f64::from(self.config.channel.hls_time),
        );
        Ok(Some(Laid { layer_png: layer.png, layer_height: layer.height, timeline, videos }))
    }

    fn clip_paths(&self, key: &str) -> (PathBuf, PathBuf) {
        let d = &self.store.dirs.clips;
        (d.join(format!("{key}.mp4")), d.join(format!("{key}.json")))
    }

    fn cached_clip(&self, key: &str) -> Option<Clip> {
        let (clip, meta) = self.clip_paths(key);
        if !clip.exists() {
            return None;
        }
        let seconds = serde_json::from_slice::<Value>(&std::fs::read(meta).ok()?).ok()?.get("seconds")?.as_f64()?;
        Some(Clip { file: clip, seconds })
    }

    async fn article_clip(&self, article: &Article, index: usize, total: usize, music: &Path, cancel: &CancellationToken) -> anyhow::Result<Option<Clip>> {
        // Videos made under other encode settings are brought up to date first.
        let key_now = self.encode_key();
        for asset in doc_asset_ids(&article.doc).iter().filter_map(|id| self.store.asset(id)) {
            if asset.kind == AssetKind::Video && asset.status == AssetStatus::Ready && asset.enc.as_deref() != Some(key_now.as_str()) {
                self.refresh_video_copy(&asset, cancel).await?;
            }
        }
        let media = self.article_media(article);
        let key = hash(&json!({
            "v": CLIP_VERSION,
            "doc": article.doc,
            "title": article.title,
            "place": { "index": index, "total": total },
            "seconds": article.seconds,
            "speed": article.scroll_speed,
            "media": media.iter().map(|m| json!([m.id, m.file, m.size, m.enc])).collect::<Vec<_>>(),
            "enc": key_now,
            "music": mtime_ms(music),
        }));
        if let Some(hit) = self.cached_clip(&key) {
            return Ok(Some(hit));
        }
        let (clip_path, meta_path) = self.clip_paths(&key);
        let work = make_build_dir(&self.store.dirs.clips, ".work-")?;
        let result = self.render_clip(article, index, total, &media, music, &work, cancel).await;
        let outcome = match result {
            Ok(Some((out, seconds))) => {
                std::fs::rename(out, &clip_path)?;
                std::fs::write(&meta_path, json!({ "seconds": seconds }).to_string())?;
                Ok(Some(Clip { file: clip_path, seconds }))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(e),
        };
        remove_dir(&work);
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    async fn render_clip(
        &self,
        article: &Article,
        index: usize,
        total: usize,
        media: &[Asset],
        music: &Path,
        work: &Path,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Option<(PathBuf, f64)>> {
        let Some(laid) = self.layout_article(article, media)? else { return Ok(None) };
        let (w, h) = (self.config.channel.width, self.config.channel.height);
        let ctx = RenderCtx { width: w, height: h, now: jiff::Timestamp::now(), tz: &self.config.tz, expiring_threshold_days: 0 };
        let (page, bg, edges, chip) = (work.join("page.png"), work.join("bg.png"), work.join("edges.png"), work.join("chip.png"));
        std::fs::write(&page, &laid.layer_png)?;
        self.raster.render_to_file(&build_background_svg(&ctx, false), w, h, &bg)?;
        self.raster.render_to_file(&build_background_svg(&ctx, true), w, h, &edges)?;
        let indicator = match render_indicator_png(&self.raster, &self.measure, index, total, &article.title, w, h)? {
            Some(png) => {
                std::fs::write(&chip, png)?;
                Some(chip.to_string_lossy().into_owned())
            }
            None => None,
        };
        let videos: Vec<ClipVideo> = laid
            .videos
            .iter()
            .enumerate()
            .filter_map(|(k, (v, a))| {
                Some(ClipVideo {
                    file: self.store.dirs.asset_file(a)?.to_string_lossy().into_owned(),
                    x: v.x,
                    y: v.y,
                    width: v.width,
                    height: v.height,
                    start: laid.timeline.starts.get(k).copied().unwrap_or(0.0),
                    duration: a.duration,
                    has_audio: a.has_audio,
                })
            })
            .collect();
        let out = work.join("clip.mp4");
        let (bg_s, page_s, edges_s, music_s, out_s) =
            (bg.to_string_lossy(), page.to_string_lossy(), edges.to_string_lossy(), music.to_string_lossy(), out.to_string_lossy());
        let args = article_clip_args(
            &self.params(),
            &ClipInputs {
                background: &bg_s,
                layer: &page_s,
                edges: &edges_s,
                indicator: indicator.as_deref(),
                videos: &videos,
                phases: &laid.timeline.phases,
                seconds: laid.timeline.total,
                music: &music_s,
                out: &out_s,
            },
        );
        run(&self.config.ffmpeg_path, &args, &format!("media article {}", article.id), Some(cancel)).await?;
        Ok(Some((out, laid.timeline.total)))
    }

    /// The furthest live position of ANY media loop: a player can move
    /// between loops, so a new loop continues past all of them.
    fn furthest_position(&self) -> Option<Position> {
        let now = now_ms();
        std::iter::once(self.public_loop_dir())
            .chain(self.store.dirs.variant_dirs())
            .filter_map(|d| current_loop_position(&d, now))
            .reduce(|a, b| Position {
                media_sequence: a.media_sequence.max(b.media_sequence),
                discontinuity_sequence: a.discontinuity_sequence.max(b.discontinuity_sequence),
            })
    }

    /// Join one variant's clips into its loop (no-op when already exact).
    async fn build_loop(&self, dir: &Path, clips: &[Clip], reason: &str, force: bool, label: &str, cancel: &CancellationToken) -> anyhow::Result<(f64, bool)> {
        let p = self.params();
        let seconds: f64 = clips.iter().map(|c| c.seconds).sum();
        let repeats = loop_repeats(&p, seconds);
        let files: Vec<String> = (0..repeats).flat_map(|_| clips.iter().map(|c| c.file.to_string_lossy().into_owned())).collect();
        let signature = hash(&json!({ "v": LOOP_VERSION, "files": files, "seg": p.hls_time, "live": p.live_loop }));
        if !force && loop_ready(dir) && read_sig(dir).as_deref() == Some(signature.as_str()) {
            return Ok((seconds, false));
        }
        tracing::info!(target: "media", %reason, variant = label, articles = clips.len(), seconds, repeats, "building media loop");
        let previous = p.live_loop.then(|| self.furthest_position()).flatten();
        let tmp = make_build_dir(&self.config.hls_dir, ".build-media-")?;
        let result: anyhow::Result<()> = async {
            let list = tmp.join("list.txt");
            std::fs::write(&list, concat_list(&files))?;
            run(&self.config.ffmpeg_path, &loop_args(&p, &list.to_string_lossy(), &tmp.to_string_lossy()), &format!("media loop {label}"), Some(cancel)).await?;
            let _ = std::fs::remove_file(&list);
            if p.live_loop {
                write_loop_state(&tmp, next_loop_start(previous), now_ms())?;
            }
            std::fs::write(tmp.join(SIG_FILE), &signature)?;
            swap_dir(&tmp, dir)?;
            Ok(())
        }
        .await;
        if let Err(e) = result {
            remove_dir(&tmp);
            return Err(e);
        }
        Ok((seconds, true))
    }

    async fn do_build(&self, reason: &str, force: bool, cancel: &CancellationToken) -> anyhow::Result<()> {
        let started = Instant::now();
        self.store.dirs.ensure()?;
        self.store.sweep_abandoned_articles(UNSAVED_TTL_MS).await?;
        self.store.sweep_unused_assets(UNSAVED_TTL_MS).await?;
        {
            let mut s = self.status_mut();
            s.state = "building";
            s.error = None;
            s.started_at = Some(iso_now());
        }
        let music = self.channels.ensure_music().await?;
        let articles = self.store.articles();
        let (_, variants) = media_variants(&articles, &self.users.users());
        let mut keep_clips: HashSet<String> = HashSet::new();
        let mut keep_dirs: HashSet<PathBuf> = HashSet::new();
        let (mut public_seconds, mut public_articles, mut private_loops, mut private_viewers, mut rebuilt) = (0.0, 0, 0, 0, 0);

        for (key, variant) in &variants {
            if cancel.is_cancelled() {
                return Err(RunError::Aborted.into());
            }
            let dir = if variant.public { self.public_loop_dir() } else { self.variant_dir(key) };
            let mut clips = Vec::new();
            for (i, entry) in variant.entries.iter().enumerate() {
                if cancel.is_cancelled() {
                    return Err(RunError::Aborted.into());
                }
                let article = &entry.article;
                match self.article_clip(article, i + 1, variant.entries.len(), &music, cancel).await {
                    Ok(Some(c)) => {
                        clips.push(c);
                        if article.error.is_some() {
                            self.store.set_article_error(&article.id, None).await?;
                        }
                    }
                    Ok(None) => {}
                    Err(e) if matches!(e.downcast_ref::<RunError>(), Some(RunError::Aborted)) || cancel.is_cancelled() => {
                        return Err(RunError::Aborted.into());
                    }
                    Err(e) => {
                        tracing::error!(target: "media", article_id = %article.id, error = %e, "article could not be rendered");
                        self.store.set_article_error(&article.id, Some(e.to_string().chars().take(200).collect())).await?;
                    }
                }
            }
            for c in &clips {
                if let Some(stem) = c.file.file_stem() {
                    keep_clips.insert(stem.to_string_lossy().into_owned());
                }
            }
            if clips.is_empty() {
                remove_dir(&dir);
                continue;
            }
            keep_dirs.insert(dir.clone());
            let label = if variant.public { "public".to_owned() } else { dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() };
            let (seconds, built) = self.build_loop(&dir, &clips, reason, force, &label, cancel).await?;
            if built {
                rebuilt += 1;
            }
            if variant.public {
                public_seconds = seconds;
                public_articles = clips.len();
            } else {
                private_loops += 1;
                private_viewers += variant.user_ids.len();
            }
        }
        // Drop cached clips no current article uses, and loops nobody is on.
        if let Ok(entries) = std::fs::read_dir(&self.store.dirs.clips) {
            for e in entries.filter_map(Result::ok) {
                let name = e.file_name().to_string_lossy().into_owned();
                let stem = name.trim_end_matches(".mp4").trim_end_matches(".json");
                if !name.starts_with(".work-") && !keep_clips.contains(stem) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        for dir in self.store.dirs.variant_dirs() {
            if !keep_dirs.contains(&dir) {
                remove_dir(&dir);
            }
        }
        let mut s = self.status_mut();
        s.state = if keep_dirs.is_empty() { "empty" } else { "idle" };
        s.error = None;
        if rebuilt > 0 || s.built_at.is_none() {
            s.built_at = Some(iso_now());
        }
        s.seconds = public_seconds;
        s.articles = public_articles;
        s.variants = private_loops;
        s.private_viewers = private_viewers;
        drop(s);
        if rebuilt > 0 {
            tracing::info!(target: "media", loops = keep_dirs.len(), rebuilt, duration_ms = started.elapsed().as_millis() as u64, "media loop ready");
        }
        Ok(())
    }
}
