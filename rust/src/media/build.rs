//! Builds and locates the media channel's loops.

use std::path::PathBuf;
use std::sync::Arc;

use crate::config::Config;
use crate::data::model::DecoratedUser;

#[derive(Debug)]
pub struct MediaChannel {
    config: Arc<Config>,
}

impl MediaChannel {
    pub fn new(config: Arc<Config>) -> Self {
        Self { config }
    }

    /// The public loop (what a customer in no private audience sees).
    pub fn public_loop_dir(&self) -> PathBuf {
        self.config.hls_dir.join("_media")
    }

    /// The loop one customer watches, or `None` when there is nothing to
    /// play for them (an empty channel would be a black screen).
    pub fn loop_dir_for(&self, _user: &DecoratedUser) -> Option<PathBuf> {
        let dir = self.public_loop_dir();
        dir.join("index.m3u8").exists().then_some(dir)
    }
}
