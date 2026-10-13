//! Admin API for the media channel, merged into the admin's `/api` router
//! (auth + CSRF inherited). Every content mutation schedules a debounced
//! loop rebuild; nothing here waits for an encode — the editor polls the
//! asset while a video is processed.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Multipart, Path as UrlPath, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use base64::Engine as _;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use super::AppState;
use super::api::{ApiError, ApiResult, body, created, num_of, ok, str_of};
use crate::core::util::{iso_now, make_token};
use crate::encode::ffmpeg::ffprobe_path;
use crate::encode::media::probe_media;
use crate::media::doc::{doc_asset_ids, doc_has_content, doc_summary, filter_private, private_sections};
use crate::media::model::{Article, Asset, AssetKind, AssetStatus, DEFAULT_SCROLL_SPEED, DEFAULT_SECONDS};
use crate::media::store::{MAX_SECONDS, MAX_SPEED, MIN_SECONDS, MIN_SPEED, TITLE_CHARS, upload_kind, validate_article_fields, validate_order};
use crate::media::variants::Viewer;
use crate::playlist::catalog::ChannelPatch;
use crate::playlist::model::{INFO_MEDIA_CHANNEL_ID, INFO_MEDIA_DEFAULT_NAME};
use crate::render::media::article_preview_jpeg;

// ---- View models (pure) ----

pub fn asset_json(a: &Asset) -> Value {
    json!({
        "id": a.id, "kind": a.kind, "status": a.status, "error": a.error, "width": a.width, "height": a.height,
        "duration": a.duration, "has_audio": (a.kind == AssetKind::Video).then_some(a.has_audio), "size": a.size,
        "original_name": a.original_name,
    })
}

pub fn article_summary_json(a: &Article, assets: &HashMap<String, Asset>) -> Value {
    let used: Vec<&Asset> = doc_asset_ids(&a.doc).iter().filter_map(|id| assets.get(id)).collect();
    let cover = used.iter().find(|x| x.kind == AssetKind::Image || (x.kind == AssetKind::Video && x.thumb.is_some()));
    json!({
        "id": a.id, "title": a.title, "summary": doc_summary(&a.doc, 90), "empty": !doc_has_content(&a.doc),
        "seconds": a.seconds, "scroll_speed": a.scroll_speed,
        "images": used.iter().filter(|x| x.kind == AssetKind::Image).count(),
        "videos": used.iter().filter(|x| x.kind == AssetKind::Video).count(),
        "processing": used.iter().filter(|x| x.status == AssetStatus::Processing).count(),
        "cover": cover.map(|c| c.id.clone()),
        "audience": a.audience, "private_sections": private_sections(&a.doc).len(),
        "error": a.error, "updated_at": a.updated_at,
    })
}

pub fn article_json(a: &Article, assets: &HashMap<String, Asset>) -> Value {
    let mut v = article_summary_json(a, assets);
    let used: serde_json::Map<String, Value> =
        doc_asset_ids(&a.doc).iter().filter_map(|id| assets.get(id).map(|x| (id.clone(), asset_json(x)))).collect();
    v["doc"] = json!(a.doc);
    v["assets"] = Value::Object(used);
    v
}

/// The disk cost of keeping a video: its copy, the clip it goes into, and
/// that clip's copy in the loop. Refuses an upload before an encode.
pub fn video_cost_estimate(duration: f64, maxrate: &str) -> u64 {
    let n: f64 = maxrate.trim_end_matches(|c: char| c.is_ascii_alphabetic()).parse().unwrap_or(2500.0);
    let bits = if maxrate.to_ascii_lowercase().ends_with('m') { n * 1e6 } else { n * 1e3 };
    (duration * (bits + 128_000.0) / 8.0 * 3.0).ceil() as u64
}

// ---- HTTP ----

pub fn router(st: &AppState) -> Router<AppState> {
    let upload_limit = usize::try_from(st.config.media.max_video_mb.max(st.config.media.max_image_mb) * 1024 * 1024 + 1024 * 1024).unwrap_or(usize::MAX);
    Router::new()
        .route("/media", get(view))
        .route("/media/channel", patch(update_channel))
        .route("/media/articles", post(create_article))
        .route("/media/articles/{id}", get(get_article).patch(update_article).delete(delete_article))
        .route("/media/articles/{id}/assets", post(upload).layer(DefaultBodyLimit::max(upload_limit)))
        .route("/media/order", put(reorder))
        .route("/media/rebuild", post(rebuild))
        .route("/media/preview", post(preview))
        .route("/media/assets/{id}", get(get_asset))
        .route("/media/assets/{id}/picture", get(picture))
}

fn asset_map(st: &AppState) -> HashMap<String, Asset> {
    st.media.store.assets().into_iter().map(|a| (a.id.clone(), a)).collect()
}

fn media_view(st: &AppState) -> Value {
    let channel = st.catalog.channel(INFO_MEDIA_CHANNEL_ID);
    let assets = asset_map(st);
    json!({
        "channel": {
            "id": INFO_MEDIA_CHANNEL_ID,
            "name": channel.as_ref().map(|c| c.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| INFO_MEDIA_DEFAULT_NAME.to_owned()),
            "enabled": channel.as_ref().is_none_or(|c| c.enabled),
        },
        "articles": st.media.store.articles().iter().map(|a| article_summary_json(a, &assets)).collect::<Vec<_>>(),
        "status": st.media.status_json(),
        "usage": st.media.store.usage(&st.config.media),
        "limits": { "titleChars": TITLE_CHARS, "minSeconds": MIN_SECONDS, "maxSeconds": MAX_SECONDS, "minSpeed": MIN_SPEED, "maxSpeed": MAX_SPEED },
        "defaults": { "seconds": DEFAULT_SECONDS, "scrollSpeed": DEFAULT_SCROLL_SPEED },
    })
}

async fn view(State(st): State<AppState>) -> ApiResult {
    ok(media_view(&st))
}

async fn update_channel(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    let mut patch = ChannelPatch::default();
    if b.get("name").is_some() {
        let name = str_of(b.get("name")).split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            return Err(ApiError::bad("name required"));
        }
        if name.chars().count() > 80 {
            return Err(ApiError::bad("name must be 80 characters or less"));
        }
        patch.name = Some(name);
    }
    match b.get("enabled") {
        None => {}
        Some(Value::Bool(v)) => patch.enabled = Some(*v),
        Some(_) => return Err(ApiError::bad("enabled must be a boolean")),
    }
    st.catalog.update_channel(INFO_MEDIA_CHANNEL_ID, &patch).await?;
    tracing::info!(target: "admin", "media channel updated");
    ok(media_view(&st))
}

/// A new (empty) article, created up front so uploads have an article to
/// belong to. An empty article never reaches the channel.
async fn create_article(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let patch = validate_article_fields(&body(b), false).map_err(ApiError::bad)?;
    let a = st.media.store.create_article(patch).await?;
    tracing::info!(target: "admin", article_id = %a.id, "media article created");
    if doc_has_content(&a.doc) {
        st.media.schedule_build("article added");
    }
    created(article_json(&a, &asset_map(&st)))
}

async fn get_article(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let a = st.media.store.article(&id).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "article not found"))?;
    ok(article_json(&a, &asset_map(&st)))
}

async fn update_article(State(st): State<AppState>, UrlPath(id): UrlPath<String>, b: Option<Json<Value>>) -> ApiResult {
    if st.media.store.article(&id).is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "article not found"));
    }
    let patch = validate_article_fields(&body(b), true).map_err(ApiError::bad)?;
    if let Some(doc) = &patch.doc {
        let known = asset_map(&st);
        if doc_asset_ids(doc).iter().any(|id| !known.contains_key(id)) {
            return Err(ApiError::bad("the article refers to a file that no longer exists"));
        }
    }
    let saved = st.media.store.update_article(&id, patch).await?.ok_or_else(ApiError::not_found)?;
    st.media.schedule_build("article edited");
    ok(article_json(&saved, &asset_map(&st)))
}

async fn delete_article(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    if st.media.store.article(&id).is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "article not found"));
    }
    for a in st.media.store.assets().iter().filter(|a| a.article_id == id) {
        st.media.cancel_video(&a.id);
    }
    let removed = st.media.store.remove_article(&id).await?.map_or(0, |(_, assets)| assets.len());
    tracing::info!(target: "admin", article_id = %id, files = removed, "media article deleted");
    st.media.schedule_build("article deleted");
    ok(media_view(&st))
}

async fn reorder(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let existing: Vec<String> = st.media.store.articles().into_iter().map(|a| a.id).collect();
    let ids = validate_order(body(b).get("ids"), &existing).map_err(ApiError::bad)?;
    st.media.store.reorder(&ids).await?;
    st.media.schedule_build("articles reordered");
    ok(media_view(&st))
}

async fn rebuild(State(st): State<AppState>) -> ApiResult {
    let media = Arc::clone(&st.media);
    tokio::spawn(async move {
        if let Err(e) = media.build("admin request", true).await {
            tracing::warn!(target: "media", error = %e, "requested rebuild did not finish");
        }
    });
    ok(media_view(&st))
}

/// What an article will look like on TV, from the same layout code the
/// encoder uses, as seen by one viewer ('all', 'public' or a customer id).
async fn preview(State(st): State<AppState>, b: Option<Json<Value>>) -> ApiResult {
    let b = body(b);
    let patch = validate_article_fields(&b, false).map_err(ApiError::bad)?;
    let raw = b.get("viewer").cloned().unwrap_or(Value::Null);
    let user = match raw.as_str() {
        None if raw.is_null() => None,
        Some("all") => None,
        Some("public") => Some(None),
        _ => {
            let id = num_of(Some(&raw)).filter(|n| n.fract() == 0.0).ok_or_else(|| ApiError::bad("unknown viewer"))? as i64;
            Some(Some(st.store.user(id).ok_or_else(|| ApiError::bad("unknown viewer"))?))
        }
    };
    let viewer = match &user {
        None => Viewer::All,
        Some(None) => Viewer::Public,
        Some(Some(u)) => Viewer::Customer(u),
    };
    let audience = patch.audience.clone().flatten();
    if audience.as_ref().is_some_and(|a| !viewer.can_see(a)) {
        return ok(json!({ "image": null, "seconds": 0, "scrolls": false, "hidden": true }));
    }
    let article = Article {
        doc: filter_private(&patch.doc.unwrap_or_else(crate::media::doc::empty_doc), &|a| viewer.can_see(a)),
        seconds: patch.seconds.unwrap_or(DEFAULT_SECONDS),
        scroll_speed: patch.scroll_speed.unwrap_or(DEFAULT_SCROLL_SPEED),
        ..Article::default()
    };
    let media = Arc::clone(&st.media);
    let width = st.config.channel.width;
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
        let assets = media.article_media(&article);
        let Some(laid) = media.layout_article(&article, &assets)? else { return Ok(json!({ "image": null, "seconds": 0, "scrolls": false })) };
        let jpeg = article_preview_jpeg(&laid.layer_png)?;
        Ok(json!({
            "image": format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)),
            "scrolls": laid.timeline.max_scroll > 0.0,
            "seconds": laid.timeline.total,
            "videos": laid.videos.len(),
            "width": width,
            "height": laid.layer_height,
        }))
    })
    .await
    .map_err(anyhow::Error::from)?;
    match result {
        Ok(v) => ok(v),
        Err(e) => {
            tracing::error!(target: "media", error = %e, "preview failed");
            Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("preview failed: {e}")))
        }
    }
}

async fn get_asset(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let a = st.media.store.asset(&id).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "file not found"))?;
    ok(asset_json(&a))
}

/// The image itself, or a video's poster.
async fn picture(State(st): State<AppState>, UrlPath(id): UrlPath<String>) -> Response {
    let file = st.media.store.asset(&id).and_then(|a| if a.kind == AssetKind::Image { st.media.store.dirs.asset_file(&a) } else { st.media.store.dirs.asset_thumb(&a) });
    let Some(file) = file else { return ApiError::new(StatusCode::NOT_FOUND, "no picture").into_response() };
    match tokio::fs::read(&file).await {
        Ok(bytes) => {
            let mime = match file.extension().and_then(|e| e.to_str()) {
                Some("png") => "image/png",
                Some("webp") => "image/webp",
                _ => "image/jpeg",
            };
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, max-age=300")], bytes).into_response()
        }
        Err(_) => ApiError::new(StatusCode::NOT_FOUND, "no picture").into_response(),
    }
}

/// Upload an image or a video into an article. Streams to `incoming/` with
/// the size caps checked as it arrives.
async fn upload(State(st): State<AppState>, UrlPath(id): UrlPath<String>, mut multipart: Multipart) -> ApiResult {
    let cfg = &st.config.media;
    let max = cfg.max_video_mb.max(cfg.max_image_mb) * 1024 * 1024;
    st.media.store.dirs.ensure().map_err(anyhow::Error::from)?;
    let usage = st.media.store.usage(cfg);
    if usage.used >= usage.quota {
        return Err(ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "the media storage limit is reached; delete something first"));
    }
    let mut field = loop {
        match multipart.next_field().await {
            Ok(Some(f)) if f.name() == Some("file") => break f,
            Ok(Some(_)) => {}
            Ok(None) => return Err(ApiError::bad("no file")),
            Err(e) => return Err(ApiError::bad(e.body_text())),
        }
    };
    let original = field.file_name().unwrap_or("").to_owned();
    let mime = field.content_type().unwrap_or("").to_owned();
    let Some(kind) = upload_kind(&mime, &original) else {
        return Err(ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported file type: use JPG, PNG or WebP images, or MP4, MKV, MOV or WebM video"));
    };
    let ext: String = std::path::Path::new(&original).extension().and_then(|e| e.to_str()).map(|e| format!(".{}", e.to_lowercase())).unwrap_or_default().chars().take(6).collect();
    let raw = st.media.store.dirs.incoming.join(format!("{}{ext}", make_token(12)));
    let mut out = tokio::fs::File::create(&raw).await.map_err(anyhow::Error::from)?;
    let mut size: u64 = 0;
    let fail = |raw: &std::path::Path, e: ApiError| {
        let _ = std::fs::remove_file(raw);
        Err(e)
    };
    loop {
        match field.chunk().await {
            Ok(Some(chunk)) => {
                size += chunk.len() as u64;
                if size > max {
                    return fail(&raw, ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, format!("file is larger than {} MB", cfg.max_video_mb)));
                }
                if out.write_all(&chunk).await.is_err() {
                    return fail(&raw, ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "could not store the upload"));
                }
            }
            Ok(None) => break,
            Err(e) => return fail(&raw, ApiError::bad(e.body_text())),
        }
    }
    let _ = out.flush().await;
    drop(out);
    if size == 0 {
        return fail(&raw, ApiError::bad("no file"));
    }
    let Some(article) = st.media.store.article(&id) else { return fail(&raw, ApiError::new(StatusCode::NOT_FOUND, "article not found")) };
    let asset_id = make_token(12);

    if kind == AssetKind::Image {
        if size > cfg.max_image_mb * 1024 * 1024 {
            return fail(&raw, ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, format!("image is larger than {} MB", cfg.max_image_mb)));
        }
        let (files, raw2, aid) = (st.media.store.dirs.files.clone(), raw.clone(), asset_id.clone());
        let stored = tokio::task::spawn_blocking(move || crate::render::media::store_image(&raw2, &files, &aid)).await.map_err(anyhow::Error::from)?;
        let _ = std::fs::remove_file(&raw);
        let (file, bytes, width, height) = stored.map_err(|e| ApiError::bad(format!("not a readable image: {e}")))?;
        let asset = st
            .media
            .store
            .create_asset(Asset {
                id: asset_id.clone(), article_id: article.id.clone(), kind, status: AssetStatus::Ready, error: None, file: Some(file), thumb: None,
                width, height, duration: 0.0, has_audio: false, size: bytes, original_name: original, enc: None, created_at: iso_now(),
            })
            .await?;
        tracing::info!(target: "admin", %asset_id, article_id = %article.id, bytes, "media image uploaded");
        return created(asset_json(&asset));
    }

    // Video: probe now, so a broken file or one that can't fit is refused at
    // once instead of after a long encode.
    let probe = match probe_media(&ffprobe_path(&st.config.ffmpeg_path), &raw.to_string_lossy()).await {
        Ok(p) => p,
        Err(e) => return fail(&raw, ApiError::bad(format!("not a readable video: {e}"))),
    };
    if !probe.has_video || probe.duration <= 0.0 {
        return fail(&raw, ApiError::bad("the file has no video track"));
    }
    let usage = st.media.store.usage(cfg);
    if usage.used.saturating_sub(size) + video_cost_estimate(probe.duration, &cfg.maxrate) > usage.quota {
        return fail(&raw, ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "not enough media storage for this video; delete something or upload a shorter one"));
    }
    let asset = st
        .media
        .store
        .create_asset(Asset {
            id: asset_id.clone(), article_id: article.id.clone(), kind, status: AssetStatus::Processing, error: None, file: None, thumb: None,
            width: probe.width, height: probe.height, duration: (probe.duration * 1000.0).round() / 1000.0, has_audio: probe.has_audio,
            size: 0, original_name: original, enc: None, created_at: iso_now(),
        })
        .await?;
    tracing::info!(target: "admin", %asset_id, article_id = %article.id, duration_s = probe.duration, bytes = size, "media video uploaded; processing");
    st.media.queue_video(asset_id, raw, probe);
    created(asset_json(&asset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_cost() {
        // 10 s at 2500k + 128k audio, kept three times over.
        assert_eq!(video_cost_estimate(10.0, "2500k"), ((2_500_000.0_f64 + 128_000.0) / 8.0 * 10.0 * 3.0).ceil() as u64);
        assert!(video_cost_estimate(10.0, "4M") > video_cost_estimate(10.0, "2500k"));
    }
}
