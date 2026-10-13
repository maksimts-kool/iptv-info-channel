//! Reading the Node version's JSON data files (for `import-json`), moving a
//! corrupt file aside rather than failing on it.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::de::DeserializeOwned;

use crate::core::util::now_ms;

/// What [`load`] found on disk.
#[derive(Debug)]
pub enum Loaded<T> {
    /// The file parsed.
    Existing(T),
    /// No file yet.
    Missing,
    /// The file was unreadable and has been moved to `backup`.
    Corrupt { backup: PathBuf, error: String },
}

pub fn load<T: DeserializeOwned>(path: &Path) -> anyhow::Result<Loaded<T>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded::Missing),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => Ok(Loaded::Existing(v)),
        Err(e) => {
            let backup = PathBuf::from(format!("{}.corrupt-{}", path.display(), now_ms()));
            fs::rename(path, &backup).with_context(|| format!("moving corrupt {} aside", path.display()))?;
            Ok(Loaded::Corrupt {
                backup,
                error: e.to_string(),
            })
        }
    }
}
