//! Text measurement for the article layout: shapes words with harfrust (the
//! same shaper resvg uses) against the same font database the frames are
//! rasterized with, so where the layout wraps a line is where the rendered
//! text actually ends. Results are cached per face, size and word.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use resvg::usvg::fontdb::{self, Family, Query, Stretch, Style, Weight};
use skrifa::MetadataProvider;
use skrifa::instance::{LocationRef, Size};

/// Vertical metrics of a face, in em units.
#[derive(Debug, Clone, Copy)]
pub struct FaceMetrics {
    pub ascent: f32,
    pub descent: f32,
}

const FALLBACK_METRICS: FaceMetrics = FaceMetrics { ascent: 0.97, descent: 0.24 };

#[derive(Debug)]
pub struct TextMeasurer {
    db: Arc<fontdb::Database>,
    faces: Mutex<HashMap<(u16, bool), Option<fontdb::ID>>>,
    widths: Mutex<HashMap<(fontdb::ID, String), f32>>,
    metrics: Mutex<HashMap<fontdb::ID, FaceMetrics>>,
}

impl TextMeasurer {
    pub fn new(db: Arc<fontdb::Database>) -> Self {
        Self { db, faces: Mutex::default(), widths: Mutex::default(), metrics: Mutex::default() }
    }

    /// The face the frames' `font-family="Inter, sans-serif"` resolves to.
    fn face(&self, weight: u16, italic: bool) -> Option<fontdb::ID> {
        let mut faces = self.faces.lock().unwrap_or_else(PoisonError::into_inner);
        *faces.entry((weight, italic)).or_insert_with(|| {
            self.db.query(&Query {
                families: &[Family::Name("Inter"), Family::SansSerif],
                weight: Weight(weight),
                stretch: Stretch::Normal,
                style: if italic { Style::Italic } else { Style::Normal },
            })
        })
    }

    pub fn metrics(&self, weight: u16, italic: bool) -> FaceMetrics {
        let Some(id) = self.face(weight, italic) else { return FALLBACK_METRICS };
        let mut cache = self.metrics.lock().unwrap_or_else(PoisonError::into_inner);
        *cache.entry(id).or_insert_with(|| {
            self.db
                .with_face_data(id, |data, index| {
                    let font = skrifa::FontRef::from_index(data, index).ok()?;
                    let m = font.metrics(Size::unscaled(), LocationRef::default());
                    let upem = f32::from(m.units_per_em.max(1));
                    Some(FaceMetrics { ascent: m.ascent / upem, descent: -m.descent / upem })
                })
                .flatten()
                .unwrap_or(FALLBACK_METRICS)
        })
    }

    /// Advance width of `text` at `size` px.
    pub fn width(&self, text: &str, size: f32, weight: u16, italic: bool) -> f32 {
        if text.is_empty() {
            return 0.0;
        }
        let Some(id) = self.face(weight, italic) else { return text.chars().count() as f32 * size * 0.55 };
        let key = (id, text.to_owned());
        if let Some(em) = self.widths.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
            return em * size;
        }
        let em = self
            .db
            .with_face_data(id, |data, index| {
                let font = harfrust::FontRef::from_index(data, index).ok()?;
                let upem = skrifa::FontRef::from_index(data, index).ok()?.metrics(Size::unscaled(), LocationRef::default()).units_per_em;
                let shaper_data = harfrust::ShaperData::new(&font);
                let shaper = shaper_data.shaper(&font).build();
                let mut buffer = harfrust::UnicodeBuffer::new();
                buffer.push_str(text);
                buffer.guess_segment_properties();
                let out = shaper.shape(buffer, harfrust::ShapeOptions::new());
                let units: i32 = out.glyph_positions().iter().map(|p| p.x_advance).sum();
                Some(units as f32 / f32::from(upem.max(1)))
            })
            .flatten()
            .unwrap_or(text.chars().count() as f32 * 0.55);
        self.widths.lock().unwrap_or_else(PoisonError::into_inner).insert(key, em);
        em * size
    }
}
