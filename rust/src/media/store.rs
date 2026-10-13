//! The media channel's content: ARTICLES shown in order and the ASSETS
//! (uploaded images and videos) they embed. Rows live in PostgreSQL
//! (`media_articles`, `media_assets`) behind an in-memory copy, like the
//! other stores; files live under `DATA_DIR/media`:
//!
//! ```text
//! files/     stored images (downscaled) and the 720p video copies
//! thumbs/    a poster per video
//! clips/     encoded per-article clips, cached by content hash
//! incoming/  uploads still streaming in; emptied at startup
//! ```
//!
//! An asset's files are deleted when no article uses it any more: on save
//! (dropped from its article), with its article (unless another article
//! shows it), or by the sweeps. The channel's NAME and switch are not here —
//! they live on its built-in catalog row.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};

use anyhow::Context;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use tokio::sync::Mutex as AsyncMutex;

use super::doc::{Node, doc_asset_ids, doc_has_content, empty_doc, sanitize_doc};
use super::model::{Article, Asset, AssetKind, AssetStatus, DEFAULT_SCROLL_SPEED, DEFAULT_SECONDS};
use crate::core::audience::{Audience, clean_audience};
use crate::core::util::{iso_now, make_token, parse_instant};
use crate::http::api::{num_of, str_of};

pub const TITLE_CHARS: usize = 120;
pub const MIN_SECONDS: i64 = 3;
pub const MAX_SECONDS: i64 = 600;
pub const MIN_SPEED: i64 = 10;
pub const MAX_SPEED: i64 = 200;

/// The on-disk layout.
#[derive(Debug, Clone)]
pub struct MediaDirs {
    pub root: PathBuf,
    pub files: PathBuf,
    pub thumbs: PathBuf,
    pub clips: PathBuf,
    pub incoming: PathBuf,
    pub hls: PathBuf,
}

impl MediaDirs {
    pub fn new(media_dir: &Path, hls_dir: &Path) -> Self {
        Self {
            root: media_dir.to_path_buf(),
            files: media_dir.join("files"),
            thumbs: media_dir.join("thumbs"),
            clips: media_dir.join("clips"),
            incoming: media_dir.join("incoming"),
            hls: hls_dir.to_path_buf(),
        }
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        for d in [&self.files, &self.thumbs, &self.clips, &self.incoming] {
            std::fs::create_dir_all(d)?;
        }
        Ok(())
    }

    /// The PUBLIC loop.
    pub fn loop_dir(&self) -> PathBuf {
        self.hls.join("_media")
    }

    /// The loop of a non-public variant, by the hash of its key.
    pub fn variant_dir(&self, hashed: &str) -> PathBuf {
        self.hls.join(format!("_media-{hashed}"))
    }

    /// Every variant loop on disk (not the public one).
    pub fn variant_dirs(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(&self.hls) else { return Vec::new() };
        entries
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name().to_str().is_some_and(|n| {
                    n.strip_prefix("_media-").is_some_and(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
                })
            })
            .map(|e| e.path())
            .collect()
    }

    pub fn asset_file(&self, asset: &Asset) -> Option<PathBuf> {
        asset.file.as_deref().map(|f| self.files.join(Path::new(f).file_name().unwrap_or_default()))
    }

    pub fn asset_thumb(&self, asset: &Asset) -> Option<PathBuf> {
        asset.thumb.as_deref().map(|f| self.thumbs.join(Path::new(f).file_name().unwrap_or_default()))
    }

    pub fn remove_asset_files(&self, asset: &Asset) {
        for f in [self.asset_file(asset), self.asset_thumb(asset)].into_iter().flatten() {
            let _ = std::fs::remove_file(f);
        }
    }
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

/// Which kind an upload is, from its MIME type or (browsers send nothing
/// useful for .mkv) its extension.
pub fn upload_kind(mime: &str, filename: &str) -> Option<AssetKind> {
    let mime = mime.to_lowercase();
    let ext = Path::new(filename).extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    if ["image/jpeg", "image/png", "image/webp"].contains(&mime.as_str()) || ["jpg", "jpeg", "png", "webp"].contains(&ext.as_str()) {
        return Some(AssetKind::Image);
    }
    if ["video/mp4", "video/x-matroska", "video/quicktime", "video/webm"].contains(&mime.as_str())
        || ["mp4", "m4v", "mkv", "mov", "webm"].contains(&ext.as_str())
    {
        return Some(AssetKind::Video);
    }
    None
}

/// Article fields an admin may set; `None` = leave alone.
#[derive(Debug, Clone, Default)]
pub struct ArticlePatch {
    pub title: Option<String>,
    pub doc: Option<Node>,
    pub seconds: Option<i64>,
    pub scroll_speed: Option<i64>,
    /// `Some(None)` = every customer.
    pub audience: Option<Option<Audience>>,
}

fn int_in(v: Option<&Value>, min: i64, max: i64, label: &str) -> Result<i64, String> {
    num_of(v)
        .filter(|n| n.fract() == 0.0 && *n >= min as f64 && *n <= max as f64)
        .map(|n| n as i64)
        .ok_or_else(|| format!("{label} must be a whole number from {min} to {max}"))
}

pub fn validate_article_fields(b: &Value, partial: bool) -> Result<ArticlePatch, String> {
    let has = |k: &str| b.get(k).is_some();
    let mut out = ArticlePatch::default();
    if !partial || has("title") {
        out.title = Some(str_of(b.get("title")).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(TITLE_CHARS).collect());
    }
    if !partial || has("doc") {
        out.doc = Some(match b.get("doc") {
            None => empty_doc(),
            Some(d) => sanitize_doc(d)?,
        });
    }
    if has("seconds") {
        out.seconds = Some(int_in(b.get("seconds"), MIN_SECONDS, MAX_SECONDS, "seconds")?);
    }
    if has("scroll_speed") {
        out.scroll_speed = Some(int_in(b.get("scroll_speed"), MIN_SPEED, MAX_SPEED, "scroll speed")?);
    }
    if let Some(a) = b.get("audience") {
        out.audience = Some(if a.is_null() {
            None
        } else {
            Some(clean_audience(a).ok_or_else(|| "audience must be null or { users, plans }".to_owned())?)
        });
    }
    Ok(out)
}

/// A reorder must name exactly the existing articles, each once.
pub fn validate_order(ids: Option<&Value>, existing: &[String]) -> Result<Vec<String>, String> {
    let list = ids.and_then(Value::as_array).ok_or_else(|| "ids must be an array".to_owned())?;
    let ids: Vec<String> = list.iter().map(|v| str_of(Some(v))).collect();
    let wanted: HashSet<&String> = existing.iter().collect();
    let unique: HashSet<&String> = ids.iter().collect();
    if ids.len() != wanted.len() || unique.len() != ids.len() || ids.iter().any(|id| !wanted.contains(id)) {
        return Err("the order must list every article exactly once".into());
    }
    Ok(ids)
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct MediaData {
    pub articles: Vec<Article>,
    pub assets: Vec<Asset>,
}

/// Disk usage against the budget.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Usage {
    pub used: u64,
    pub quota: u64,
    pub max_video: u64,
    pub max_image: u64,
}

#[derive(Debug)]
pub struct MediaStore {
    pool: PgPool,
    cache: RwLock<Arc<MediaData>>,
    writes: AsyncMutex<()>,
    pub dirs: MediaDirs,
}

const TS: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;

async fn load(pool: &PgPool) -> anyhow::Result<MediaData> {
    let mut d = MediaData::default();
    let sql = format!(
        "SELECT id, title, doc, seconds, scroll_speed, audience, error, to_char(created_at AT TIME ZONE 'UTC', {TS}) AS created_at, \
         to_char(updated_at AT TIME ZONE 'UTC', {TS}) AS updated_at FROM media_articles ORDER BY position, created_at"
    );
    for r in sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_all(pool).await? {
        let audience: Option<Value> = r.try_get("audience")?;
        d.articles.push(Article {
            id: r.try_get("id")?,
            title: r.try_get("title")?,
            doc: serde_json::from_value(r.try_get("doc")?).unwrap_or_else(|_| empty_doc()),
            seconds: r.try_get("seconds")?,
            scroll_speed: r.try_get("scroll_speed")?,
            audience: audience.and_then(|a| serde_json::from_value(a).ok()),
            error: r.try_get("error")?,
            created_at: r.try_get("created_at")?,
            updated_at: r.try_get("updated_at")?,
        });
    }
    let sql = format!(
        "SELECT id, article_id, kind, status, error, file, thumb, width, height, duration, has_audio, size, original_name, enc, \
         to_char(created_at AT TIME ZONE 'UTC', {TS}) AS created_at FROM media_assets ORDER BY created_at"
    );
    for r in sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_all(pool).await? {
        let kind: String = r.try_get("kind")?;
        let status: String = r.try_get("status")?;
        d.assets.push(Asset {
            id: r.try_get("id")?,
            article_id: r.try_get("article_id")?,
            kind: if kind == "video" { AssetKind::Video } else { AssetKind::Image },
            status: match status.as_str() {
                "processing" => AssetStatus::Processing,
                "error" => AssetStatus::Error,
                _ => AssetStatus::Ready,
            },
            error: r.try_get("error")?,
            file: r.try_get("file")?,
            thumb: r.try_get("thumb")?,
            width: u32::try_from(r.try_get::<i64, _>("width")?).unwrap_or(0),
            height: u32::try_from(r.try_get::<i64, _>("height")?).unwrap_or(0),
            duration: r.try_get("duration")?,
            has_audio: r.try_get("has_audio")?,
            size: u64::try_from(r.try_get::<i64, _>("size")?).unwrap_or(0),
            original_name: r.try_get("original_name")?,
            enc: r.try_get("enc")?,
            created_at: r.try_get("created_at")?,
        });
    }
    Ok(d)
}

fn kind_str(k: AssetKind) -> &'static str {
    match k {
        AssetKind::Image => "image",
        AssetKind::Video => "video",
    }
}

fn status_str(s: AssetStatus) -> &'static str {
    match s {
        AssetStatus::Ready => "ready",
        AssetStatus::Processing => "processing",
        AssetStatus::Error => "error",
    }
}

/// Persist exactly what differs between two states.
pub(crate) async fn persist_diff(tx: &mut Transaction<'_, Postgres>, old: &MediaData, new: &MediaData) -> anyhow::Result<()> {
    let before: HashMap<&str, (usize, &Article)> = old.articles.iter().enumerate().map(|(i, a)| (a.id.as_str(), (i, a))).collect();
    for (position, a) in new.articles.iter().enumerate() {
        if before.get(a.id.as_str()).is_some_and(|(i, b)| *i == position && *b == a) {
            continue;
        }
        sqlx::query(
            "INSERT INTO media_articles (id, position, title, doc, seconds, scroll_speed, audience, error, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE(NULLIF($9,'')::timestamptz, now()),COALESCE(NULLIF($10,'')::timestamptz, now()))
             ON CONFLICT (id) DO UPDATE SET position=EXCLUDED.position, title=EXCLUDED.title, doc=EXCLUDED.doc, seconds=EXCLUDED.seconds,
               scroll_speed=EXCLUDED.scroll_speed, audience=EXCLUDED.audience, error=EXCLUDED.error, updated_at=EXCLUDED.updated_at",
        )
        .bind(&a.id)
        .bind(position as i64)
        .bind(&a.title)
        .bind(serde_json::to_value(&a.doc)?)
        .bind(a.seconds)
        .bind(a.scroll_speed)
        .bind(a.audience.as_ref().map(serde_json::to_value).transpose()?)
        .bind(&a.error)
        .bind(&a.created_at)
        .bind(&a.updated_at)
        .execute(&mut **tx)
        .await?;
    }
    let kept: HashSet<&str> = new.articles.iter().map(|a| a.id.as_str()).collect();
    let gone: Vec<String> = old.articles.iter().filter(|a| !kept.contains(a.id.as_str())).map(|a| a.id.clone()).collect();
    if !gone.is_empty() {
        sqlx::query("DELETE FROM media_articles WHERE id = ANY($1)").bind(&gone).execute(&mut **tx).await?;
    }

    let before: HashMap<&str, &Asset> = old.assets.iter().map(|a| (a.id.as_str(), a)).collect();
    for a in new.assets.iter().filter(|a| before.get(a.id.as_str()).is_none_or(|b| *b != *a)) {
        sqlx::query(
            "INSERT INTO media_assets (id, article_id, kind, status, error, file, thumb, width, height, duration, has_audio, size, original_name, enc, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE(NULLIF($15,'')::timestamptz, now()))
             ON CONFLICT (id) DO UPDATE SET article_id=EXCLUDED.article_id, status=EXCLUDED.status, error=EXCLUDED.error, file=EXCLUDED.file,
               thumb=EXCLUDED.thumb, width=EXCLUDED.width, height=EXCLUDED.height, duration=EXCLUDED.duration, has_audio=EXCLUDED.has_audio,
               size=EXCLUDED.size, original_name=EXCLUDED.original_name, enc=EXCLUDED.enc",
        )
        .bind(&a.id)
        .bind(&a.article_id)
        .bind(kind_str(a.kind))
        .bind(status_str(a.status))
        .bind(&a.error)
        .bind(&a.file)
        .bind(&a.thumb)
        .bind(i64::from(a.width))
        .bind(i64::from(a.height))
        .bind(a.duration)
        .bind(a.has_audio)
        .bind(a.size as i64)
        .bind(&a.original_name)
        .bind(&a.enc)
        .bind(&a.created_at)
        .execute(&mut **tx)
        .await?;
    }
    let kept: HashSet<&str> = new.assets.iter().map(|a| a.id.as_str()).collect();
    let gone: Vec<String> = old.assets.iter().filter(|a| !kept.contains(a.id.as_str())).map(|a| a.id.clone()).collect();
    if !gone.is_empty() {
        sqlx::query("DELETE FROM media_assets WHERE id = ANY($1)").bind(&gone).execute(&mut **tx).await?;
    }
    Ok(())
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            _ => e.metadata().map(|m| m.len()).unwrap_or(0),
        })
        .sum()
}

fn age_ms(stamp: &str, now: i64) -> i64 {
    parse_instant(stamp).map_or(i64::MAX, |t| now - t.as_millisecond())
}

impl MediaStore {
    pub async fn open(pool: PgPool, dirs: MediaDirs) -> anyhow::Result<Self> {
        let data = load(&pool).await.context("loading media articles")?;
        Ok(Self { pool, cache: RwLock::new(Arc::new(data)), writes: AsyncMutex::new(()), dirs })
    }

    pub fn read(&self) -> Arc<MediaData> {
        Arc::clone(&self.cache.read().unwrap_or_else(PoisonError::into_inner))
    }

    /// Mutate a copy, persist what differs, swap it in. Files of assets that
    /// left the state are deleted after the commit.
    async fn write<R>(&self, f: impl FnOnce(&mut MediaData) -> R) -> anyhow::Result<R> {
        let _guard = self.writes.lock().await;
        let current = self.read();
        let mut next = (*current).clone();
        let result = f(&mut next);
        let mut tx = self.pool.begin().await?;
        persist_diff(&mut tx, &current, &next).await?;
        tx.commit().await?;
        let kept: HashSet<&str> = next.assets.iter().map(|a| a.id.as_str()).collect();
        for gone in current.assets.iter().filter(|a| !kept.contains(a.id.as_str())) {
            self.dirs.remove_asset_files(gone);
        }
        *self.cache.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(next);
        Ok(result)
    }

    pub fn articles(&self) -> Vec<Article> {
        self.read().articles.clone()
    }

    pub fn article(&self, id: &str) -> Option<Article> {
        self.read().articles.iter().find(|a| a.id == id).cloned()
    }

    pub fn assets(&self) -> Vec<Asset> {
        self.read().assets.clone()
    }

    pub fn asset(&self, id: &str) -> Option<Asset> {
        self.read().assets.iter().find(|a| a.id == id).cloned()
    }

    pub async fn create_article(&self, patch: ArticlePatch) -> anyhow::Result<Article> {
        let now = iso_now();
        let article = Article {
            id: make_token(12),
            title: patch.title.unwrap_or_default(),
            doc: patch.doc.unwrap_or_else(empty_doc),
            seconds: patch.seconds.unwrap_or(DEFAULT_SECONDS),
            scroll_speed: patch.scroll_speed.unwrap_or(DEFAULT_SCROLL_SPEED),
            audience: patch.audience.flatten(),
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        self.write(|d| {
            d.articles.push(article.clone());
            article
        })
        .await
    }

    /// Saving a new document also deletes this article's assets it no longer
    /// uses — "removed from the article = removed from disk" (unless another
    /// article shows it).
    pub async fn update_article(&self, id: &str, patch: ArticlePatch) -> anyhow::Result<Option<Article>> {
        self.write(|d| {
            let a = d.articles.iter_mut().find(|a| a.id == id)?;
            if let Some(v) = patch.title {
                a.title = v;
            }
            let doc_changed = patch.doc.is_some();
            if let Some(v) = patch.doc {
                a.doc = v;
            }
            if let Some(v) = patch.seconds {
                a.seconds = v;
            }
            if let Some(v) = patch.scroll_speed {
                a.scroll_speed = v;
            }
            if let Some(v) = patch.audience {
                a.audience = v;
            }
            a.updated_at = iso_now();
            let saved = a.clone();
            if doc_changed {
                let used: HashSet<String> = d.articles.iter().flat_map(|a| doc_asset_ids(&a.doc)).collect();
                d.assets.retain(|asset| asset.article_id != id || used.contains(&asset.id));
            }
            Some(saved)
        })
        .await
    }

    pub async fn set_article_error(&self, id: &str, error: Option<String>) -> anyhow::Result<()> {
        self.write(|d| {
            if let Some(a) = d.articles.iter_mut().find(|a| a.id == id) {
                a.error = error;
            }
        })
        .await
    }

    pub async fn reorder(&self, ids: &[String]) -> anyhow::Result<()> {
        self.write(|d| {
            let mut by_id: HashMap<String, Article> = d.articles.drain(..).map(|a| (a.id.clone(), a)).collect();
            d.articles = ids.iter().filter_map(|id| by_id.remove(id)).collect();
            d.articles.extend(by_id.into_values());
        })
        .await
    }

    /// Row + every asset uploaded into it (and any whose owner is already
    /// gone), unless another article still shows it.
    pub async fn remove_article(&self, id: &str) -> anyhow::Result<Option<(Article, Vec<Asset>)>> {
        self.write(|d| {
            let pos = d.articles.iter().position(|a| a.id == id)?;
            let article = d.articles.remove(pos);
            let still_used: HashSet<String> = d.articles.iter().flat_map(|a| doc_asset_ids(&a.doc)).collect();
            let owners: HashSet<&str> = d.articles.iter().map(|a| a.id.as_str()).collect();
            let (mine, rest): (Vec<Asset>, Vec<Asset>) = d
                .assets
                .drain(..)
                .partition(|a| (a.article_id == id || !owners.contains(a.article_id.as_str())) && !still_used.contains(&a.id));
            d.assets = rest;
            Some((article, mine))
        })
        .await
    }

    pub async fn create_asset(&self, asset: Asset) -> anyhow::Result<Asset> {
        self.write(|d| {
            d.assets.push(asset.clone());
            asset
        })
        .await
    }

    pub async fn update_asset(&self, id: &str, f: impl FnOnce(&mut Asset)) -> anyhow::Result<Option<Asset>> {
        self.write(|d| {
            let a = d.assets.iter_mut().find(|a| a.id == id)?;
            f(a);
            Some(a.clone())
        })
        .await
    }

    pub async fn remove_asset(&self, id: &str) -> anyhow::Result<Option<Asset>> {
        self.write(|d| {
            let pos = d.assets.iter().position(|a| a.id == id)?;
            Some(d.assets.remove(pos))
        })
        .await
    }

    /// "Новая статья" opened and abandoned: still empty and untitled after
    /// `min_age_ms`.
    pub async fn sweep_abandoned_articles(&self, min_age_ms: i64) -> anyhow::Result<usize> {
        let now = crate::core::util::now_ms();
        let doomed: Vec<String> = self
            .read()
            .articles
            .iter()
            .filter(|a| a.title.is_empty() && !doc_has_content(&a.doc) && age_ms(&a.updated_at, now) >= min_age_ms)
            .map(|a| a.id.clone())
            .collect();
        for id in &doomed {
            self.remove_article(id).await?;
        }
        Ok(doomed.len())
    }

    /// Assets no saved article uses (an editor closed without saving, or
    /// their article is gone). `min_age_ms` spares fresh uploads.
    pub async fn sweep_unused_assets(&self, min_age_ms: i64) -> anyhow::Result<usize> {
        let now = crate::core::util::now_ms();
        self.write(|d| {
            let used: HashSet<String> = d.articles.iter().flat_map(|a| doc_asset_ids(&a.doc)).collect();
            let before = d.assets.len();
            d.assets.retain(|a| {
                used.contains(&a.id) || age_ms(&a.created_at, now) < min_age_ms || (a.status == AssetStatus::Processing && min_age_ms > 0)
            });
            before - d.assets.len()
        })
        .await
    }

    pub fn usage(&self, cfg: &crate::config::Media) -> Usage {
        let used = dir_size(&self.dirs.root) + dir_size(&self.dirs.loop_dir()) + self.dirs.variant_dirs().iter().map(|d| dir_size(d)).sum::<u64>();
        Usage { used, quota: cfg.quota_mb * 1024 * 1024, max_video: cfg.max_video_mb * 1024 * 1024, max_image: cfg.max_image_mb * 1024 * 1024 }
    }

    /// Startup housekeeping: drop half-received uploads, half-built clips,
    /// assets no article uses and any file nothing references. A video still
    /// "processing" lost its upload with `incoming/`, so it is marked failed.
    pub async fn sweep_orphans(&self) -> anyhow::Result<usize> {
        self.dirs.ensure()?;
        let _ = std::fs::remove_dir_all(&self.dirs.incoming);
        std::fs::create_dir_all(&self.dirs.incoming)?;
        if let Ok(entries) = std::fs::read_dir(&self.dirs.clips) {
            for e in entries.filter_map(Result::ok) {
                if e.file_name().to_string_lossy().starts_with(".work-") {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
        self.write(|d| {
            for a in d.assets.iter_mut().filter(|a| a.status == AssetStatus::Processing) {
                a.status = AssetStatus::Error;
                a.error = Some("обработка прервана перезапуском сервера".into());
            }
        })
        .await?;
        let mut removed = self.sweep_unused_assets(0).await?;
        let keep: HashSet<String> = self
            .read()
            .assets
            .iter()
            .flat_map(|a| [a.file.clone(), a.thumb.clone()])
            .flatten()
            .filter_map(|f| Path::new(&f).file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
        for dir in [&self.dirs.files, &self.dirs.thumbs] {
            for e in std::fs::read_dir(dir)?.filter_map(Result::ok) {
                if !keep.contains(&*e.file_name().to_string_lossy()) {
                    let _ = if e.path().is_dir() { std::fs::remove_dir_all(e.path()) } else { std::fs::remove_file(e.path()) };
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::db::testing::TestDb;
    use serde_json::json;

    async fn open(t: &TestDb, dir: &Path) -> MediaStore {
        let dirs = MediaDirs::new(&dir.join("media"), &dir.join("hls"));
        dirs.ensure().unwrap();
        MediaStore::open(t.pool.clone(), dirs).await.unwrap()
    }

    fn with_image(id: &str) -> Node {
        sanitize_doc(&json!({"type": "doc", "content": [{"type": "mediaImage", "attrs": {"assetId": id, "size": "full", "caption": ""}}]})).unwrap()
    }

    fn image(store: &MediaStore, id: &str, article: &str) -> Asset {
        std::fs::write(store.dirs.files.join(format!("{id}.jpg")), b"x").unwrap();
        Asset {
            id: id.into(), article_id: article.into(), kind: AssetKind::Image, status: AssetStatus::Ready, error: None,
            file: Some(format!("{id}.jpg")), thumb: None, width: 1, height: 1, duration: 0.0, has_audio: false, size: 1,
            original_name: String::new(), enc: None, created_at: iso_now(),
        }
    }

    #[test]
    fn validation() {
        assert_eq!(upload_kind("image/png", "x"), Some(AssetKind::Image));
        assert_eq!(upload_kind("", "clip.MKV"), Some(AssetKind::Video));
        assert_eq!(upload_kind("application/pdf", "a.pdf"), None);
        let v = validate_article_fields(&json!({"title": "  Как   настроить ", "seconds": 20}), false).unwrap();
        assert_eq!(v.title.as_deref(), Some("Как настроить"));
        assert!(v.doc.is_some() && v.seconds == Some(20));
        assert!(validate_article_fields(&json!({"seconds": 2}), true).is_err());
        assert!(validate_article_fields(&json!({"scroll_speed": 500}), true).is_err());
        assert!(validate_article_fields(&json!({"audience": "x"}), true).is_err());
        assert_eq!(validate_article_fields(&json!({"audience": null}), true).unwrap().audience, Some(None));
        let ids = ["a".to_owned(), "b".to_owned()];
        assert!(validate_order(Some(&json!(["b", "a"])), &ids).is_ok());
        assert!(validate_order(Some(&json!(["a"])), &ids).is_err());
        assert!(validate_order(Some(&json!(["a", "a"])), &ids).is_err());
    }

    #[tokio::test]
    async fn articles_assets_and_files_follow_their_documents() {
        let t = TestDb::new().await;
        let dir = tempfile::tempdir().unwrap();
        let store = open(&t, dir.path()).await;
        let a = store.create_article(ArticlePatch::default()).await.unwrap();
        let b = store.create_article(ArticlePatch { title: Some("B".into()), ..ArticlePatch::default() }).await.unwrap();
        store.create_asset(image(&store, "img111111", &a.id)).await.unwrap();
        store.create_asset(image(&store, "img222222", &a.id)).await.unwrap();
        store.update_article(&a.id, ArticlePatch { doc: Some(with_image("img111111")), ..ArticlePatch::default() }).await.unwrap();
        assert!(store.asset("img222222").is_none(), "dropped from its article = deleted");
        assert!(!store.dirs.files.join("img222222.jpg").exists());
        // An image pasted into another article survives its first article.
        store.update_article(&b.id, ArticlePatch { doc: Some(with_image("img111111")), ..ArticlePatch::default() }).await.unwrap();
        store.reorder(&[b.id.clone(), a.id.clone()]).await.unwrap();
        let (_, removed) = store.remove_article(&a.id).await.unwrap().unwrap();
        assert!(removed.is_empty() && store.asset("img111111").is_some());

        let again = open(&t, dir.path()).await;
        assert_eq!(again.articles().iter().map(|x| x.id.clone()).collect::<Vec<_>>(), [b.id.clone()]);
        assert_eq!(again.articles()[0].doc, with_image("img111111"));
        assert!(again.asset("img111111").is_some());

        // Orphan sweep: a stray file goes, a lost video upload is marked failed.
        std::fs::write(again.dirs.files.join("stray.bin"), b"x").unwrap();
        let mut vid = image(&again, "vid333333", &b.id);
        vid.kind = AssetKind::Video;
        vid.status = AssetStatus::Processing;
        again.create_asset(vid).await.unwrap();
        again.update_article(&b.id, ArticlePatch { doc: Some(sanitize_doc(&json!({"type": "doc", "content": [
            {"type": "mediaImage", "attrs": {"assetId": "img111111"}}, {"type": "mediaVideo", "attrs": {"assetId": "vid333333"}}]})).unwrap()), ..ArticlePatch::default() }).await.unwrap();
        assert!(again.sweep_orphans().await.unwrap() >= 1);
        assert!(!again.dirs.files.join("stray.bin").exists());
        assert_eq!(again.asset("vid333333").unwrap().status, AssetStatus::Error);
        assert!(again.usage(&crate::config::Config::load(dir.path().to_path_buf()).media).used > 0);
        t.drop().await;
    }
}
