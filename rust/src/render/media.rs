//! Rasterizes the media channel's articles: the tall page (text, pictures and
//! video posters, laid out by `render::article`), the corner chip, and the
//! channel background the page scrolls over. Also the upload-side image
//! work: downscaling stored pictures and the admin's preview.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;

use anyhow::Context;
use base64::Engine as _;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use resvg::tiny_skia::{Pixmap, PixmapPaint, Transform};

use super::article::{LayoutCtx, Picture, SLIDE_WIDTH, flow_piece, indicator_svg, indicator_text, media_width, video_piece};
use super::raster::Rasterizer;
use super::text::TextMeasurer;
use crate::media::doc::{Node, Section, doc_sections};
use crate::media::model::AssetKind;

/// A picture-bearing asset as the page needs it.
#[derive(Debug, Clone)]
pub struct PageMedia {
    pub id: String,
    pub kind: AssetKind,
    pub width: u32,
    pub height: u32,
    /// The image itself, or a video's poster.
    pub picture: std::path::PathBuf,
}

/// A playable video's place on the finished layer, in output pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedVideo {
    pub asset_id: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub focus: i64,
}

#[derive(Debug)]
pub struct Layer {
    pub png: Vec<u8>,
    pub height: u32,
    pub videos: Vec<PlacedVideo>,
}

/// Decode an image honouring its EXIF orientation.
fn decode_oriented(bytes: &[u8]) -> anyhow::Result<DynamicImage> {
    let mut decoder = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation().ok();
    let mut img = DynamicImage::from_decoder(decoder)?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    Ok(img)
}

fn jpeg(img: &DynamicImage, quality: u8) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    img.to_rgb8().write_with_encoder(encoder)?;
    Ok(out)
}

/// A picture as a data URI, no wider than the widest box it can be shown in.
fn picture_uri(file: &Path, scale: f32) -> anyhow::Result<String> {
    let img = decode_oriented(&std::fs::read(file)?)?;
    let max_w = (media_width(crate::media::doc::MediaSize::Full) * scale).round() as u32;
    let img = if img.width() > max_w { img.resize(max_w, u32::MAX, image::imageops::FilterType::Lanczos3) } else { img };
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg(&img, 85)?)))
}

/// Render a piece SVG at the output scale.
fn piece_pixmap(raster: &Rasterizer, svg: &str, logical_height: f32, scale: f32) -> anyhow::Result<Pixmap> {
    let w = (SLIDE_WIDTH * scale).round() as u32;
    let h = ((logical_height * scale).round() as u32).max(1);
    raster.svg_to_pixmap(svg, w, h)
}

/// The whole article as one transparent PNG the channel's width, as tall as
/// it needs (a short article is centred within one screen), plus where each
/// playable video sits on it. `None` = nothing to show.
pub fn render_article_layer(raster: &Rasterizer, measure: &TextMeasurer, doc: &Node, media: &[PageMedia], width: u32, height: u32) -> anyhow::Result<Option<Layer>> {
    let scale = width as f32 / SLIDE_WIDTH;
    let mut pictures: HashMap<String, Picture> = HashMap::new();
    for m in media {
        if !m.picture.exists() {
            continue;
        }
        match picture_uri(&m.picture, scale) {
            Ok(src) => {
                pictures.insert(m.id.clone(), Picture { src, width: m.width, height: m.height, video: m.kind == AssetKind::Video });
            }
            Err(e) => tracing::warn!(target: "media", asset_id = %m.id, error = %e, "picture could not be loaded"),
        }
    }
    let lookup = |id: &str| pictures.get(id);
    let ctx = LayoutCtx { measure, picture: &lookup };

    let sections = doc_sections(doc);
    let mut pieces: Vec<(Pixmap, Option<(String, super::article::VideoBox)>)> = Vec::new();
    for (i, section) in sections.iter().enumerate() {
        let (first, last) = (i == 0, i + 1 == sections.len());
        match section {
            Section::Video(attrs) => {
                // Not processed yet: left out until it is.
                let Some(piece) = video_piece(&ctx, attrs, first, last) else { continue };
                let pm = piece_pixmap(raster, &piece.svg, piece.height, scale)?;
                pieces.push((pm, piece.video.map(|b| (attrs.asset_id.clone(), b))));
            }
            Section::Flow(nodes) => {
                let piece = flow_piece(&ctx, nodes, first, last);
                pieces.push((piece_pixmap(raster, &piece.svg, piece.height, scale)?, None));
            }
        }
    }
    if pieces.is_empty() {
        return Ok(None);
    }
    let content: u32 = pieces.iter().map(|(p, _)| p.height()).sum();
    let layer_h = height.max(content);
    let mut layer = Pixmap::new(width, layer_h).context("layer canvas")?;
    let mut y = (layer_h - content) / 2;
    let mut videos = Vec::new();
    let even = |v: f32| ((v * scale / 2.0).round() as i64 * 2).max(2);
    for (pm, video) in &pieces {
        layer.draw_pixmap(0, y as i32, pm.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
        if let Some((asset_id, b)) = video {
            videos.push(PlacedVideo {
                asset_id: asset_id.clone(),
                x: (b.x * scale).round() as i64,
                y: i64::from(y) + (b.y * scale).round() as i64,
                width: even(b.width),
                height: even(b.height),
                focus: (b.focus * scale).round() as i64,
            });
        }
        y += pm.height();
    }
    Ok(Some(Layer { png: layer.encode_png().context("encoding layer")?, height: layer_h, videos }))
}

/// The «1/3 · title» chip as a full transparent frame, or `None`.
pub fn render_indicator_png(raster: &Rasterizer, measure: &TextMeasurer, index: usize, total: usize, title: &str, width: u32, height: u32) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(text) = indicator_text(index, total, title) else { return Ok(None) };
    raster.svg_to_png(&indicator_svg(measure, &text), width, height).map(Some)
}

/// The admin's preview: the page on the channel background colour, as JPEG.
pub fn article_preview_jpeg(layer_png: &[u8]) -> anyhow::Result<Vec<u8>> {
    let layer = image::load_from_memory_with_format(layer_png, ImageFormat::Png)?.to_rgba8();
    let mut canvas = image::RgbaImage::from_pixel(layer.width(), layer.height(), image::Rgba([0x0e, 0x16, 0x30, 0xff]));
    image::imageops::overlay(&mut canvas, &layer, 0, 0);
    jpeg(&DynamicImage::ImageRgba8(canvas), 80)
}

/// A stored upload: downscaled to fit 1920×1080, PNG only when there is real
/// transparency (screenshots carry an opaque alpha channel; JPEG is far
/// smaller). Returns (file name, bytes, width, height).
pub fn store_image(raw: &Path, dir: &Path, asset_id: &str) -> anyhow::Result<(String, u64, u32, u32)> {
    let img = decode_oriented(&std::fs::read(raw)?).context("not a readable image")?;
    let transparent = img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255);
    let img = if img.width() > 1920 || img.height() > 1080 { img.resize(1920, 1080, image::imageops::FilterType::Lanczos3) } else { img };
    let (name, bytes) = if transparent {
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)?;
        (format!("{asset_id}.png"), out)
    } else {
        (format!("{asset_id}.jpg"), jpeg(&img, 88)?)
    };
    std::fs::write(dir.join(&name), &bytes)?;
    Ok((name, bytes.len() as u64, img.width(), img.height()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::doc::sanitize_doc;
    use serde_json::json;
    use std::sync::Arc;

    fn tools() -> (Rasterizer, TextMeasurer) {
        let raster = Rasterizer::new(Path::new("/nonexistent"));
        let measure = TextMeasurer::new(Arc::clone(raster.fontdb()));
        (raster, measure)
    }

    fn write_test_image(path: &Path, w: u32, h: u32, alpha: u8) {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([200, 100, 50, alpha]));
        DynamicImage::ImageRgba8(img).save(path).unwrap();
    }

    #[test]
    fn layer_centres_a_short_article_and_places_videos() {
        let (raster, measure) = tools();
        let dir = tempfile::tempdir().unwrap();
        let poster = dir.path().join("poster.png");
        write_test_image(&poster, 192, 108, 255);
        let doc = sanitize_doc(&json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Как настроить"}]},
            {"type": "mediaVideo", "attrs": {"assetId": "vid111111", "size": "full", "caption": "Видео"}},
            {"type": "paragraph", "content": [{"type": "text", "text": "После видео."}]}
        ]}))
        .unwrap();
        let media = [PageMedia { id: "vid111111".into(), kind: AssetKind::Video, width: 1920, height: 1080, picture: poster }];
        let layer = render_article_layer(&raster, &measure, &doc, &media, 1280, 720).unwrap().unwrap();
        assert!(layer.height >= 720);
        assert_eq!(layer.videos.len(), 1);
        let v = &layer.videos[0];
        assert_eq!((v.width % 2, v.height % 2), (0, 0));
        assert!(v.y > 0 && v.focus > v.height);
        assert_eq!(&layer.png[1..4], b"PNG");
        assert!(article_preview_jpeg(&layer.png).unwrap().starts_with(&[0xff, 0xd8]));
        let empty = sanitize_doc(&json!({"type": "doc"})).unwrap();
        assert!(render_article_layer(&raster, &measure, &empty, &[], 1280, 720).unwrap().is_none());
        assert!(render_indicator_png(&raster, &measure, 1, 1, "", 1280, 720).unwrap().is_none());
        assert!(render_indicator_png(&raster, &measure, 1, 2, "x", 1280, 720).unwrap().is_some());
    }

    #[test]
    fn stored_images_downscale_and_pick_a_format() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.png");
        write_test_image(&big, 4000, 3000, 255);
        let (name, _, w, h) = store_image(&big, dir.path(), "aaa111").unwrap();
        assert_eq!((name.as_str(), w, h), ("aaa111.jpg", 1440, 1080));
        let clear = dir.path().join("clear.png");
        write_test_image(&clear, 100, 100, 10);
        assert_eq!(store_image(&clear, dir.path(), "bbb222").unwrap().0, "bbb222.png");
        let junk = dir.path().join("junk.png");
        std::fs::write(&junk, b"not an image").unwrap();
        assert!(store_image(&junk, dir.path(), "ccc333").is_err());
    }
}

#[cfg(test)]
mod preview {
    //! `MEDIA_PREVIEW_DIR=/tmp/x cargo test dump_article -- --ignored`
    use super::*;
    use crate::media::doc::sanitize_doc;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    #[ignore = "writes a JPEG for manual inspection"]
    fn dump_article() {
        let Ok(dir) = std::env::var("MEDIA_PREVIEW_DIR") else { return };
        let dir = std::path::PathBuf::from(dir);
        let raster = Rasterizer::new(Path::new("/usr/share/fonts"));
        let measure = TextMeasurer::new(Arc::clone(raster.fontdb()));
        let pic = dir.join("pic.png");
        DynamicImage::ImageRgba8(image::RgbaImage::from_fn(640, 360, |x, y| image::Rgba([(x % 256) as u8, (y % 256) as u8, 160, 255]))).save(&pic).unwrap();
        let t = |s: &str| json!({"type": "text", "text": s});
        let doc = sanitize_doc(&json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [t("Как настроить приставку")]},
            {"type": "paragraph", "content": [t("Откройте "), {"type": "text", "text": "настройки", "marks": [{"type": "bold"}]}, t(", выберите "), {"type": "text", "text": "Сеть", "marks": [{"type": "italic"}]}, t(" и введите адрес плейлиста. Это займёт меньше минуты, а "), {"type": "text", "text": "старый способ", "marks": [{"type": "strike"}]}, t(" больше не нужен. Код: "), {"type": "text", "text": "192.168.1.50", "marks": [{"type": "code"}]}]},
            {"type": "heading", "attrs": {"level": 2}, "content": [t("Шаги")]},
            {"type": "orderedList", "attrs": {"start": 1}, "content": [
                {"type": "listItem", "content": [{"type": "paragraph", "content": [t("Включите приставку")]}]},
                {"type": "listItem", "content": [{"type": "paragraph", "content": [t("Подключите её к сети и дождитесь, пока индикатор загорится зелёным цветом")]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [t("Wi‑Fi или кабель")]}]}]}]}
            ]},
            {"type": "blockquote", "content": [{"type": "paragraph", "content": [t("Если что-то не получается — напишите нам.")]}]},
            {"type": "mediaImage", "attrs": {"assetId": "img111111", "size": "half", "caption": "Экран настроек"}},
            {"type": "codeBlock", "content": [t("http://iptv.example/u/abc/playlist.m3u\nвторая строка")]},
            {"type": "horizontalRule"},
            {"type": "table", "content": [
                {"type": "tableRow", "content": [{"type": "tableHeader", "content": [{"type": "paragraph", "content": [t("Тариф")]}]}, {"type": "tableHeader", "content": [{"type": "paragraph", "content": [t("Цена")]}]}]},
                {"type": "tableRow", "content": [{"type": "tableCell", "content": [{"type": "paragraph", "content": [t("Стандарт")]}]}, {"type": "tableCell", "content": [{"type": "paragraph", "content": [t("4,99 €")]}]}]}
            ]}
        ]})).unwrap();
        let media = [PageMedia { id: "img111111".into(), kind: AssetKind::Image, width: 640, height: 360, picture: pic }];
        let layer = render_article_layer(&raster, &measure, &doc, &media, 1280, 720).unwrap().unwrap();
        std::fs::write(dir.join("article.jpg"), article_preview_jpeg(&layer.png).unwrap()).unwrap();
    }
}
