//! In-memory sliding-window rate limiting (admin login, email sign-up).

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use crate::core::util::now_ms;

#[derive(Debug)]
pub struct RateLimiter {
    window_ms: i64,
    max_hits: usize,
    hits: Mutex<HashMap<String, Vec<i64>>>,
}

impl RateLimiter {
    pub fn new(window_ms: i64, max_hits: usize) -> Self {
        Self {
            window_ms,
            max_hits,
            hits: Mutex::default(),
        }
    }

    /// Record a hit for `key`; `true` when it is over the limit.
    pub fn hit(&self, key: &str) -> bool {
        let now = now_ms();
        let mut hits = self.hits.lock().unwrap_or_else(PoisonError::into_inner);
        let list = hits.entry(key.to_owned()).or_default();
        list.retain(|t| now - t < self.window_ms);
        list.push(now);
        let limited = list.len() > self.max_hits;
        // Opportunistic cleanup keeps the map from growing without bound.
        if hits.len() > 10_000 {
            let window = self.window_ms;
            hits.retain(|_, v| v.iter().any(|t| now - t < window));
        }
        limited
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_key() {
        let rl = RateLimiter::new(60_000, 2);
        assert!(!rl.hit("a") && !rl.hit("a"));
        assert!(rl.hit("a"));
        assert!(!rl.hit("b"));
    }
}
