//! Records of the media channel: articles and the assets they embed.

use serde::{Deserialize, Serialize};

use super::doc::{Node, empty_doc};
use crate::core::audience::Audience;

pub const DEFAULT_SECONDS: i64 = 15;
/// Logical px per second, ~1 line every 1.2 s.
pub const DEFAULT_SCROLL_SPEED: i64 = 40;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Article {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub doc: Node,
    #[serde(default = "default_seconds")]
    pub seconds: i64,
    #[serde(default = "default_speed")]
    pub scroll_speed: i64,
    /// `None` = every customer; otherwise only this group.
    #[serde(default)]
    pub audience: Option<Audience>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

const fn default_seconds() -> i64 {
    DEFAULT_SECONDS
}
const fn default_speed() -> i64 {
    DEFAULT_SCROLL_SPEED
}

impl Default for Article {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            doc: empty_doc(),
            seconds: DEFAULT_SECONDS,
            scroll_speed: DEFAULT_SCROLL_SPEED,
            audience: None,
            error: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Image,
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetStatus {
    #[default]
    Ready,
    Processing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    /// The article it was uploaded into (it is deleted with it).
    #[serde(default)]
    pub article_id: String,
    pub kind: AssetKind,
    #[serde(default)]
    pub status: AssetStatus,
    #[serde(default)]
    pub error: Option<String>,
    /// File name under `media/files`.
    #[serde(default)]
    pub file: Option<String>,
    /// Poster file name under `media/thumbs` (videos).
    #[serde(default)]
    pub thumb: Option<String>,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub original_name: String,
    /// The encode settings the video copy was made under.
    #[serde(default)]
    pub enc: Option<String>,
    #[serde(default)]
    pub created_at: String,
}
