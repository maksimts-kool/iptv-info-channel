//! SVG -> PNG with resvg. The font database (system fonts plus the media font
//! directory) is loaded once and shared, since scanning fonts is the slow
//! part of a render.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, anyhow};
use resvg::tiny_skia::{Pixmap, Transform};
use resvg::usvg::{self, fontdb};

#[derive(Debug, Clone)]
pub struct Rasterizer {
    fontdb: Arc<fontdb::Database>,
}

impl Rasterizer {
    /// System fonts plus every font file under `extra_font_dir` (if any).
    pub fn new(extra_font_dir: &Path) -> Self {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        if extra_font_dir.is_dir() {
            db.load_fonts_dir(extra_font_dir);
        }
        // Frames ask for "Inter, sans-serif". fontdb's generic sans-serif is
        // Arial, which Linux rarely has, so point it at the first installed
        // family that can draw Cyrillic.
        let has = |family: &str| db.faces().any(|f| f.families.iter().any(|(name, _)| name == family));
        if let Some(family) = ["Inter", "Noto Sans", "DejaVu Sans", "Liberation Sans"]
            .into_iter()
            .find(|f| has(f))
        {
            db.set_sans_serif_family(family);
        }
        Self { fontdb: Arc::new(db) }
    }

    pub fn fontdb(&self) -> &Arc<fontdb::Database> {
        &self.fontdb
    }

    /// Render an SVG document to a PNG of `width`x`height` (the document's
    /// viewBox is scaled to fit).
    pub fn svg_to_png(&self, svg: &str, width: u32, height: u32) -> anyhow::Result<Vec<u8>> {
        let pixmap = self.svg_to_pixmap(svg, width, height)?;
        pixmap.encode_png().context("encoding png")
    }

    pub fn svg_to_pixmap(&self, svg: &str, width: u32, height: u32) -> anyhow::Result<Pixmap> {
        let opts = usvg::Options {
            font_family: "Inter".to_owned(),
            fontdb: Arc::clone(&self.fontdb),
            ..usvg::Options::default()
        };
        let tree = usvg::Tree::from_str(svg, &opts).context("parsing svg")?;
        let mut pixmap = Pixmap::new(width, height).ok_or_else(|| anyhow!("bad canvas size {width}x{height}"))?;
        let size = tree.size();
        let transform = Transform::from_scale(width as f32 / size.width(), height as f32 / size.height());
        resvg::render(&tree, transform, &mut pixmap.as_mut());
        Ok(pixmap)
    }

    /// Render and write to `out`.
    pub fn render_to_file(&self, svg: &str, width: u32, height: u32, out: &Path) -> anyhow::Result<()> {
        let png = self.svg_to_png(svg, width, height)?;
        std::fs::write(out, png).with_context(|| format!("writing {}", out.display()))
    }
}
