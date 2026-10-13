//! An article -> page pieces as SVG, for the TV.
//!
//! A small block-flow layout engine: paragraphs wrap word by word with mixed
//! marks, headings, lists, quotes, code blocks, tables, and figures. Text is
//! measured with the same shaper and fonts resvg renders with
//! (`render::text`). Everything is laid out on a 1280-wide logical page and
//! scaled to the channel resolution when rasterized, like the frames in
//! `overlay`.
//!
//! The article is split at each top-level video (`media::doc::doc_sections`)
//! and every piece laid out separately, so the encoder knows exactly where
//! each video box sits on the page.

use std::fmt::Write as _;

use super::text::TextMeasurer;
use crate::core::util::xml_escape;
use crate::media::doc::{Mark, MediaAttrs, MediaSize, Node};

pub const SLIDE_WIDTH: f32 = 1280.0;
pub const SLIDE_HEIGHT: f32 = 720.0;
pub const PAD_X: f32 = 96.0;
pub const PAD_Y: f32 = 72.0;
pub const CONTENT_WIDTH: f32 = SLIDE_WIDTH - 2.0 * PAD_X;

/// The account card's palette, so an article looks like the rest of the channel.
mod theme {
    pub const TEXT: &str = "#dbe4f3";
    pub const STRONG: &str = "#ffffff";
    pub const MUTED: &str = "#93a3c0";
    pub const ACCENT: &str = "#38bdf8";
    pub const ACCENT2: &str = "#a5b4fc";
    pub const CODE_BG: &str = "rgba(148,163,184,0.18)";
    pub const RULE: &str = "rgba(255,255,255,0.16)";
    pub const CHIP: &str = "rgba(15,24,48,0.85)";
}

const BASE_FONT: f32 = 34.0;
const LINE_HEIGHT: f32 = 1.42;
const GAP: f32 = 18.0;
/// Tallest a picture or video may be, so a video box with its caption fits
/// on one screen (it plays with the scroll paused on it).
pub const MAX_MEDIA_HEIGHT: f32 = 460.0;
pub const MEDIA_MARGIN: f32 = 16.0;
const CAPTION_GAP: f32 = 10.0;
const CAPTION_SIZE: f32 = 26.0;
const CAPTION_LINE: f32 = 26.0 * 1.3;

pub fn media_width(size: MediaSize) -> f32 {
    match size {
        MediaSize::Full => CONTENT_WIDTH,
        MediaSize::Half => (CONTENT_WIDTH / 2.0).round(),
        MediaSize::Small => 360.0,
    }
}

/// The box a picture or video occupies: its size setting's width, its own
/// aspect ratio, capped in height (a portrait one narrows instead).
pub fn media_box(dims: Option<(u32, u32)>, size: MediaSize) -> (f32, f32) {
    let aspect = dims.filter(|(w, h)| *w > 0 && *h > 0).map_or(9.0 / 16.0, |(w, h)| h as f32 / w as f32);
    let mut w = media_width(size);
    let mut h = (w * aspect).round();
    if h > MAX_MEDIA_HEIGHT {
        h = MAX_MEDIA_HEIGHT;
        w = (h / aspect).round();
    }
    (w, h)
}

/// A picture the page can show: an image, or a video's poster.
#[derive(Debug, Clone)]
pub struct Picture {
    /// `data:` URI of the (downscaled) picture.
    pub src: String,
    pub width: u32,
    pub height: u32,
    pub video: bool,
}

/// What the layout needs from outside: the measurer and the pictures.
pub struct LayoutCtx<'a> {
    pub measure: &'a TextMeasurer,
    pub picture: &'a dyn Fn(&str) -> Option<&'a Picture>,
}

impl std::fmt::Debug for LayoutCtx<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LayoutCtx").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy)]
struct TextStyle {
    size: f32,
    weight: u16,
    italic: bool,
    strike: bool,
    color: &'static str,
    line_height: f32,
}

impl TextStyle {
    fn base() -> Self {
        Self { size: BASE_FONT, weight: 400, italic: false, strike: false, color: theme::TEXT, line_height: LINE_HEIGHT }
    }
    fn line(&self) -> f32 {
        self.size * self.line_height
    }
}

/// SVG being drawn, in logical coordinates.
struct Canvas<'c, 'a> {
    svg: String,
    ctx: &'c LayoutCtx<'a>,
    clip: usize,
}

impl Canvas<'_, '_> {
    fn text(&mut self, x: f32, top: f32, text: &str, st: &TextStyle) {
        let visible = text.trim_end();
        if visible.is_empty() {
            return;
        }
        let m = self.ctx.measure.metrics(st.weight, st.italic);
        let content = (m.ascent + m.descent) * st.size;
        let baseline = top + (st.line() - content) / 2.0 + m.ascent * st.size;
        let _ = write!(
            self.svg,
            r#"<text x="{x:.2}" y="{baseline:.2}" font-family="Inter, sans-serif" font-size="{}" font-weight="{}"{} fill="{}" xml:space="preserve">{}</text>"#,
            st.size,
            st.weight,
            if st.italic { r#" font-style="italic""# } else { "" },
            st.color,
            xml_escape(visible)
        );
        if st.strike {
            let w = self.ctx.measure.width(visible, st.size, st.weight, st.italic);
            let y = baseline - st.size * 0.3;
            let _ = write!(self.svg, r#"<rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{:.2}" fill="{}"/>"#, (st.size / 14.0).max(1.5), st.color);
        }
    }

    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, rx: f32, fill: &str) {
        let _ = write!(self.svg, r#"<rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" rx="{rx}" fill="{fill}"/>"#);
    }

    fn image(&mut self, x: f32, y: f32, w: f32, h: f32, src: &str) {
        self.clip += 1;
        let id = self.clip;
        let _ = write!(
            self.svg,
            r#"<clipPath id="m{id}"><rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" rx="12"/></clipPath><image x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#m{id})" href="{src}"/>"#
        );
    }
}

// ---- Inline content ----

enum Item {
    Word(String, TextStyle),
    Code(String, TextStyle),
    Break,
}

fn mark_style(base: &TextStyle, marks: &[Mark]) -> (TextStyle, bool) {
    let mut st = *base;
    let mut code = false;
    for m in marks {
        match m {
            Mark::Bold => {
                st.weight = 700;
                st.color = theme::STRONG;
            }
            Mark::Italic => st.italic = true,
            Mark::Strike => st.strike = true,
            Mark::Code => code = true,
        }
    }
    (st, code)
}

/// Words keeping their trailing whitespace, so a line breaks between words.
fn split_words(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev_space = false;
    for (i, c) in text.char_indices() {
        let space = c.is_whitespace();
        if prev_space && !space {
            out.push(&text[start..i]);
            start = i;
        }
        prev_space = space;
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

fn inline_items(nodes: &[Node], base: &TextStyle) -> Vec<Item> {
    let mut items = Vec::new();
    for node in nodes {
        match node {
            Node::HardBreak => items.push(Item::Break),
            Node::Text { text, marks } => {
                let (st, code) = mark_style(base, marks);
                if code {
                    items.push(Item::Code(text.clone(), st));
                } else {
                    items.extend(split_words(text).into_iter().map(|w| Item::Word(w.to_owned(), st)));
                }
            }
            _ => {}
        }
    }
    items
}

/// Lay out a wrapping row of inline items; returns its height.
fn inline_row(c: &mut Canvas<'_, '_>, nodes: &[Node], base: &TextStyle, x0: f32, y0: f32, width: f32) -> f32 {
    let items = inline_items(nodes, base);
    if items.is_empty() {
        return base.line();
    }
    let measure = c.ctx.measure;
    let mut lines: Vec<Vec<(f32, &Item)>> = vec![vec![]];
    let mut x = 0.0;
    for item in &items {
        let w = match item {
            Item::Word(t, st) => measure.width(t, st.size, st.weight, st.italic),
            Item::Code(t, st) => measure.width(t, st.size, st.weight, st.italic) + 16.0 + 8.0,
            Item::Break => {
                lines.push(vec![]);
                x = 0.0;
                continue;
            }
        };
        let line_empty = lines.last().is_none_or(Vec::is_empty);
        if x + w > width + 0.5 && !line_empty {
            lines.push(vec![]);
            x = 0.0;
        }
        if let Some(line) = lines.last_mut() {
            line.push((x, item));
        }
        x += w;
    }
    let mut y = y0;
    for line in &lines {
        let h = line
            .iter()
            .map(|(_, it)| match it {
                Item::Word(_, st) | Item::Code(_, st) => st.line(),
                Item::Break => 0.0,
            })
            .fold(0.0_f32, f32::max);
        let h = if h > 0.0 { h } else { base.line() };
        for (lx, item) in line {
            match item {
                Item::Word(t, st) => c.text(x0 + lx, y, t, st),
                Item::Code(t, st) => {
                    let w = measure.width(t, st.size, st.weight, st.italic);
                    c.rect(x0 + lx + 4.0, y, w + 16.0, st.line(), 6.0, theme::CODE_BG);
                    c.text(x0 + lx + 12.0, y, t, st);
                }
                Item::Break => {}
            }
        }
        y += h;
    }
    y - y0
}

/// Centred wrapped text (captions).
fn centred_text(c: &mut Canvas<'_, '_>, text: &str, st: &TextStyle, x0: f32, y0: f32, width: f32) -> f32 {
    let measure = c.ctx.measure;
    let mut lines: Vec<String> = vec![String::new()];
    for word in split_words(text) {
        let candidate = format!("{}{word}", lines.last().map_or("", String::as_str));
        let fits = measure.width(candidate.trim_end(), st.size, st.weight, st.italic) <= width;
        if fits || lines.last().is_none_or(String::is_empty) {
            if let Some(l) = lines.last_mut() {
                *l = candidate;
            }
        } else {
            lines.push(word.to_owned());
        }
    }
    let mut y = y0;
    for line in &lines {
        let w = measure.width(line.trim_end(), st.size, st.weight, st.italic);
        c.text(x0 + (width - w) / 2.0, y, line, st);
        y += st.line();
    }
    y - y0
}

// ---- Blocks ----

/// A picture (or a poster) with its caption, centred; returns height incl.
/// margins. A video that can't play in place gets a ▶ before its caption.
fn figure(c: &mut Canvas<'_, '_>, attrs: &MediaAttrs, video: bool, play: bool, x0: f32, y0: f32, width: f32) -> Option<f32> {
    let pic = (c.ctx.picture)(&attrs.asset_id).filter(|p| p.video == video)?;
    let (w, h) = media_box(Some((pic.width, pic.height)), attrs.size);
    let top = y0 + MEDIA_MARGIN;
    let src = pic.src.clone();
    c.image(x0 + (width - w) / 2.0, top, w, h, &src);
    let mut caption = String::new();
    if video && !play {
        caption.push('▶');
    }
    if !attrs.caption.is_empty() {
        if !caption.is_empty() {
            caption.push(' ');
        }
        caption.push_str(&attrs.caption);
    }
    let mut height = h;
    if !caption.is_empty() {
        let st = TextStyle { size: CAPTION_SIZE, color: theme::MUTED, line_height: 1.3, ..TextStyle::base() };
        height += CAPTION_GAP + centred_text(c, &caption, &st, x0, top + h + CAPTION_GAP, width.min(CONTENT_WIDTH));
    }
    Some(height + 2.0 * MEDIA_MARGIN)
}

fn heading_style(level: u8) -> (TextStyle, f32) {
    let base = TextStyle::base();
    match level {
        1 => (TextStyle { size: 60.0, weight: 700, color: theme::STRONG, ..base }, 22.0),
        2 => (TextStyle { size: 46.0, weight: 700, color: theme::ACCENT, ..base }, 18.0),
        _ => (TextStyle { size: 38.0, weight: 600, color: theme::ACCENT2, ..base }, 14.0),
    }
}

#[allow(clippy::too_many_arguments)]
fn list_block(c: &mut Canvas<'_, '_>, items: &[Node], ordered: Option<u32>, depth: usize, st: &TextStyle, x0: f32, y0: f32, width: f32) -> f32 {
    let mut y = y0;
    for (i, item) in items.iter().enumerate() {
        let marker = match ordered {
            Some(start) => format!("{}.", start as usize + i),
            None => (if depth % 2 == 1 { "◦" } else { "•" }).to_owned(),
        };
        let marker_w = if ordered.is_some() { 56.0 } else { 40.0 };
        let mst = TextStyle { weight: 700, color: theme::ACCENT, ..*st };
        c.text(x0, y, &marker, &mst);
        let body = blocks(c, item.children(), depth + 1, true, st, x0 + marker_w, y, width - marker_w);
        let body = if body > 0.0 { body } else { st.line() };
        y += body.max(st.line()) + 8.0;
    }
    if items.is_empty() {
        y += st.line();
    }
    y - y0 + if depth == 0 { GAP } else { 0.0 }
}

fn table_block(c: &mut Canvas<'_, '_>, rows: &[Node], st: &TextStyle, x0: f32, y0: f32, width: f32) -> f32 {
    let mut y = y0;
    for (r, row) in rows.iter().enumerate() {
        let cells = row.children();
        let n = cells.len().max(1) as f32;
        let cell_w = width / n;
        let mut row_h: f32 = 0.0;
        for (i, cell) in cells.iter().enumerate() {
            let cst = if matches!(cell, Node::TableHeader { .. }) { TextStyle { weight: 700, color: theme::STRONG, ..*st } } else { *st };
            let h = blocks(c, cell.children(), 1, true, &cst, x0 + i as f32 * cell_w, y + 8.0, cell_w - 16.0);
            row_h = row_h.max(if h > 0.0 { h } else { cst.line() });
        }
        let border = if r == 0 { 2.0 } else { 1.0 };
        let h = row_h + 16.0;
        c.rect(x0, y + h, width, border, 0.0, theme::RULE);
        y += h + border;
    }
    if rows.is_empty() {
        y += st.line();
    }
    y - y0 + GAP
}

#[allow(clippy::too_many_arguments)]
fn blocks(c: &mut Canvas<'_, '_>, nodes: &[Node], depth: usize, tight: bool, st: &TextStyle, x0: f32, y0: f32, width: f32) -> f32 {
    let gap = if tight { 4.0 } else { GAP };
    let mut y = y0;
    for node in nodes {
        match node {
            Node::Heading { attrs, content } => {
                let (hst, margin) = heading_style(attrs.level);
                y += inline_row(c, content, &hst, x0, y, width) + margin;
            }
            Node::Paragraph { content } => y += inline_row(c, content, st, x0, y, width) + gap,
            Node::BulletList { content } => y += list_block(c, content, None, depth, st, x0, y, width),
            Node::OrderedList { attrs, content } => y += list_block(c, content, Some(attrs.start), depth, st, x0, y, width),
            Node::Blockquote { content } => {
                let qst = TextStyle { color: theme::MUTED, ..*st };
                let h = blocks(c, content, depth + 1, true, &qst, x0 + 32.0, y, width - 32.0);
                c.rect(x0, y, 6.0, h, 0.0, theme::ACCENT);
                y += h + gap;
            }
            Node::HorizontalRule => {
                c.rect(x0, y + 14.0, width, 2.0, 0.0, theme::RULE);
                y += 14.0 + 2.0 + 30.0;
            }
            Node::CodeBlock { content } => {
                let text: String = content.iter().filter_map(|n| if let Node::Text { text, .. } = n { Some(text.as_str()) } else { None }).collect();
                let cst = TextStyle { size: 28.0, ..*st };
                let lines: Vec<&str> = text.split('\n').collect();
                let h = 32.0 + lines.len() as f32 * cst.line();
                c.rect(x0, y, width, h, 12.0, theme::CODE_BG);
                for (i, line) in lines.iter().enumerate() {
                    c.text(x0 + 22.0, y + 16.0 + i as f32 * cst.line(), line, &cst);
                }
                y += h + gap;
            }
            Node::Table { content } => y += table_block(c, content, st, x0, y, width),
            Node::MediaImage { attrs } => y += figure(c, attrs, false, false, x0, y, width).unwrap_or(0.0),
            Node::MediaVideo { attrs } => y += figure(c, attrs, true, false, x0, y, width).unwrap_or(0.0),
            other => y += blocks(c, other.children(), depth, tight, st, x0, y, width),
        }
    }
    y - y0
}

/// One laid-out piece of the page.
#[derive(Debug, Clone)]
pub struct Piece {
    /// SVG of the piece (1280 logical wide).
    pub svg: String,
    pub height: f32,
    /// Where the playing video sits within the piece, for a video piece.
    pub video: Option<VideoBox>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Height to centre while it plays: the video and its caption.
    pub focus: f32,
}

fn piece_svg(body: &str, height: f32) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="{SLIDE_WIDTH}" height="{height:.2}" viewBox="0 0 {SLIDE_WIDTH} {height:.2}">{body}</svg>"#)
}

/// A run of ordinary blocks as one page piece; `first`/`last` add the
/// page's own top/bottom padding.
pub fn flow_piece(ctx: &LayoutCtx<'_>, nodes: &[&Node], first: bool, last: bool) -> Piece {
    let mut c = Canvas { svg: String::new(), ctx, clip: 0 };
    let top = if first { PAD_Y } else { 0.0 };
    let owned: Vec<Node> = nodes.iter().map(|n| (*n).clone()).collect();
    let mut h = blocks(&mut c, &owned, 0, false, &TextStyle::base(), PAD_X, top, CONTENT_WIDTH);
    if h == 0.0 {
        h = TextStyle::base().line();
    }
    let height = top + h + if last { PAD_Y } else { 0.0 };
    Piece { svg: piece_svg(&c.svg, height), height, video: None }
}

/// A top-level video as its own piece: its poster where the video will play,
/// and the caption. `None` while the video has no poster (not processed).
pub fn video_piece(ctx: &LayoutCtx<'_>, attrs: &MediaAttrs, first: bool, last: bool) -> Option<Piece> {
    let pic = (ctx.picture)(&attrs.asset_id).filter(|p| p.video)?;
    let (w, h) = media_box(Some((pic.width, pic.height)), attrs.size);
    let mut c = Canvas { svg: String::new(), ctx, clip: 0 };
    let top = if first { PAD_Y } else { 0.0 };
    let fig = figure(&mut c, attrs, true, true, PAD_X, top, CONTENT_WIDTH)?;
    let height = top + fig + if last { PAD_Y } else { 0.0 };
    let focus = h + if attrs.caption.is_empty() { 0.0 } else { CAPTION_GAP + CAPTION_LINE };
    Some(Piece {
        svg: piece_svg(&c.svg, height),
        height,
        video: Some(VideoBox { x: ((SLIDE_WIDTH - w) / 2.0).round(), y: top + MEDIA_MARGIN, width: w, height: h, focus }),
    })
}

/// The «1/3 · title» chip text, or `None` when there is nothing to say.
pub fn indicator_text(index: usize, total: usize, title: &str) -> Option<String> {
    let name = title.trim();
    let mut parts = Vec::new();
    if total > 1 {
        parts.push(format!("{index}/{total}"));
    }
    if !name.is_empty() {
        parts.push(if name.chars().count() > 48 { format!("{}…", name.chars().take(47).collect::<String>()) } else { name.to_owned() });
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// The corner chip as a whole transparent 1280×720 frame.
pub fn indicator_svg(measure: &TextMeasurer, text: &str) -> String {
    let st = TextStyle { size: 26.0, color: theme::STRONG, line_height: 1.2, ..TextStyle::base() };
    let tw = measure.width(text, st.size, st.weight, false);
    let (w, h) = (tw + 36.0, st.line() + 20.0);
    let (x, y) = (SLIDE_WIDTH - 40.0 - w, SLIDE_HEIGHT - 34.0 - h);
    let m = measure.metrics(400, false);
    let baseline = y + 10.0 + (st.line() - (m.ascent + m.descent) * st.size) / 2.0 + m.ascent * st.size;
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{SLIDE_WIDTH}" height="{SLIDE_HEIGHT}" viewBox="0 0 {SLIDE_WIDTH} {SLIDE_HEIGHT}"><rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" rx="8" fill="{}"/><text x="{:.2}" y="{baseline:.2}" font-family="Inter, sans-serif" font-size="26" fill="{}" xml:space="preserve">{}</text></svg>"#,
        theme::CHIP,
        x + 18.0,
        theme::STRONG,
        xml_escape(text)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::doc::sanitize_doc;
    use serde_json::json;
    use std::sync::Arc;

    fn measurer() -> TextMeasurer {
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_system_fonts();
        TextMeasurer::new(Arc::new(db))
    }

    #[test]
    fn media_boxes_keep_aspect() {
        assert_eq!(media_box(Some((1920, 1080)), MediaSize::Half), (media_width(MediaSize::Half), (media_width(MediaSize::Half) * 9.0 / 16.0).round()));
        assert_eq!(media_box(Some((1920, 1080)), MediaSize::Full), ((MAX_MEDIA_HEIGHT * 16.0 / 9.0).round(), MAX_MEDIA_HEIGHT));
        let (w, h) = media_box(Some((1080, 1920)), MediaSize::Full);
        assert_eq!((w, h), ((MAX_MEDIA_HEIGHT * 1080.0 / 1920.0).round(), MAX_MEDIA_HEIGHT));
        assert_eq!(media_box(None, MediaSize::Small).0, 360.0);
    }

    #[test]
    fn indicator() {
        assert_eq!(indicator_text(1, 3, "Как настроить").as_deref(), Some("1/3 · Как настроить"));
        assert_eq!(indicator_text(2, 2, "").as_deref(), Some("2/2"));
        assert_eq!(indicator_text(1, 1, "Одна").as_deref(), Some("Одна"));
        assert_eq!(indicator_text(1, 1, ""), None);
        let long = indicator_text(1, 2, &"x".repeat(80)).unwrap();
        assert!(long.ends_with('…') && long.chars().count() < 60);
    }

    #[test]
    fn words_keep_spaces_and_lines_wrap() {
        assert_eq!(split_words("Привет, мир  и всё"), ["Привет, ", "мир  ", "и ", "всё"]);
        let m = measurer();
        let pics = |_: &str| -> Option<&Picture> { None };
        let ctx = LayoutCtx { measure: &m, picture: &pics };
        let short = sanitize_doc(&json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Коротко"}]}]})).unwrap();
        let long = sanitize_doc(&json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "слово ".repeat(200)}]}]})).unwrap();
        let a = flow_piece(&ctx, &short.children().iter().collect::<Vec<_>>(), true, true);
        let b = flow_piece(&ctx, &long.children().iter().collect::<Vec<_>>(), true, true);
        assert!(b.height > a.height * 5.0, "{} vs {}", b.height, a.height);
        assert!(a.svg.contains("Коротко"));
    }

    #[test]
    fn video_piece_reports_its_box() {
        let m = measurer();
        let poster = Picture { src: "data:image/jpeg;base64,".into(), width: 1920, height: 1080, video: true };
        let pics = |id: &str| -> Option<&Picture> { (id == "vid111111").then_some(&poster) };
        let ctx = LayoutCtx { measure: &m, picture: &pics };
        let attrs = MediaAttrs { asset_id: "vid111111".into(), size: MediaSize::Full, caption: "Инструкция".into() };
        let first = video_piece(&ctx, &attrs, true, false).unwrap();
        let b = first.video.unwrap();
        assert_eq!(b.height, MAX_MEDIA_HEIGHT);
        assert_eq!(b.x, ((SLIDE_WIDTH - b.width) / 2.0).round());
        assert_eq!(b.y, PAD_Y + MEDIA_MARGIN);
        assert!(b.focus > b.height);
        assert_eq!(video_piece(&ctx, &attrs, false, false).unwrap().video.unwrap().y, MEDIA_MARGIN);
        let missing = MediaAttrs { asset_id: "vid222222".into(), ..attrs };
        assert!(video_piece(&ctx, &missing, true, true).is_none());
    }
}
