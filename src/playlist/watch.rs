//! Viewing history: who watched which channel, when and for how long.
//!
//! A WATCH is one uninterrupted run of requests for one channel by one device
//! (the same `(ip, tag)` key the device limit counts). Every manifest refresh
//! or loop segment extends it; a gap longer than [`WATCH_GAP_MS`] ends it and
//! the next request starts a new one. Only what passes through this server is
//! seen: gated HLS channels and the built-in loops. A channel a player opens
//! straight at the provider leaves no trace.
//!
//! The tracker only keeps the open watches in memory. [`WatchTracker::take_dirty`]
//! hands out every watch that changed since the last call, as rows keyed by a
//! stable id, so persisting them is an idempotent upsert and a crash loses at
//! most one flush interval.

use std::collections::HashMap;

use crate::core::util::make_token;

/// Longer than any sane HLS refresh interval, short enough that a channel
/// switch back and forth reads as two watches.
pub const WATCH_GAP_MS: i64 = 60_000;

/// Watches shorter than this are zapping, not watching, and are not stored.
pub const MIN_WATCH_MS: i64 = 30_000;

/// Rows kept for a retry while the database is unreachable.
const REQUEUE_MAX: usize = 10_000;

/// One watch as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchRow {
    pub id: String,
    pub user_id: i64,
    pub channel_id: String,
    pub channel_name: String,
    pub player: String,
    pub ip: String,
    /// Epoch milliseconds.
    pub started: i64,
    pub ended: i64,
}

impl WatchRow {
    pub fn duration_ms(&self) -> i64 {
        self.ended - self.started
    }
}

/// What a request tells the tracker.
#[derive(Debug, Clone)]
pub struct WatchHit<'a> {
    pub user_id: i64,
    pub device: &'a str,
    pub channel_id: &'a str,
    pub channel_name: &'a str,
    pub user_agent: &'a str,
    pub ip: &'a str,
}

#[derive(Debug, Clone)]
struct Open {
    row: WatchRow,
    /// `row.ended` at the last flush (0 = never flushed).
    flushed: i64,
}

#[derive(Debug, Default)]
pub struct WatchTracker {
    open: HashMap<String, Open>,
    /// Ended watches not handed out yet.
    closed: Vec<WatchRow>,
}

/// The player's product name from its User-Agent: "TiviMate/4.7.0 (Linux…)"
/// -> "TiviMate". Kept short; the full string is not history worth keeping.
pub fn player_name(user_agent: &str) -> String {
    let first = user_agent.split([' ', '(']).next().unwrap_or("");
    let name = first.split('/').next().unwrap_or("").trim();
    name.chars().take(40).collect()
}

impl WatchTracker {
    /// Record a request at `now` (epoch ms).
    pub fn touch(&mut self, hit: &WatchHit<'_>, now: i64) {
        let key = format!("{}|{}|{}", hit.user_id, hit.device, hit.channel_id);
        if let Some(open) = self.open.get_mut(&key) {
            if now - open.row.ended <= WATCH_GAP_MS {
                open.row.ended = open.row.ended.max(now);
                return;
            }
            if let Some(old) = self.open.remove(&key) {
                self.closed.push(old.row);
            }
        }
        self.open.insert(
            key,
            Open {
                row: WatchRow {
                    id: make_token(16),
                    user_id: hit.user_id,
                    channel_id: hit.channel_id.to_owned(),
                    channel_name: hit.channel_name.to_owned(),
                    player: player_name(hit.user_agent),
                    ip: hit.ip.to_owned(),
                    started: now,
                    ended: now,
                },
                flushed: 0,
            },
        );
    }

    /// Close idle watches and return every row that changed since the last
    /// call and is long enough to keep.
    pub fn take_dirty(&mut self, now: i64) -> Vec<WatchRow> {
        let idle: Vec<String> = self
            .open
            .iter()
            .filter(|(_, o)| now - o.row.ended > WATCH_GAP_MS)
            .map(|(k, _)| k.clone())
            .collect();
        for key in idle {
            if let Some(o) = self.open.remove(&key) {
                // Already flushed up to its end: nothing new to write.
                if o.flushed != o.row.ended {
                    self.closed.push(o.row);
                }
            }
        }
        let mut out: Vec<WatchRow> = std::mem::take(&mut self.closed)
            .into_iter()
            .filter(|r| r.duration_ms() >= MIN_WATCH_MS)
            .collect();
        for o in self.open.values_mut() {
            if o.flushed != o.row.ended && o.row.duration_ms() >= MIN_WATCH_MS {
                o.flushed = o.row.ended;
                out.push(o.row.clone());
            }
        }
        out
    }

    /// Watches in progress (requested within the gap), oldest first.
    pub fn live(&self, now: i64) -> Vec<WatchRow> {
        let mut rows: Vec<WatchRow> = self
            .open
            .values()
            .filter(|o| now - o.row.ended <= WATCH_GAP_MS)
            .map(|o| o.row.clone())
            .collect();
        rows.sort_by_key(|r| r.started);
        rows
    }

    /// Hand rows back after a failed write; they go out with the next call.
    /// Bounded, so a long database outage costs history, not memory.
    pub fn requeue(&mut self, rows: Vec<WatchRow>) {
        let room = REQUEUE_MAX.saturating_sub(self.closed.len());
        self.closed.extend(rows.into_iter().take(room));
    }

    /// Drop a deleted customer's watches without writing them.
    pub fn forget(&mut self, user_id: i64) {
        self.open.retain(|_, o| o.row.user_id != user_id);
        self.closed.retain(|r| r.user_id != user_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit<'a>(channel: &'a str, device: &'a str) -> WatchHit<'a> {
        WatchHit {
            user_id: 7,
            device,
            channel_id: channel,
            channel_name: "Sport 1",
            user_agent: "TiviMate/4.7.0 (Linux; Android 11)",
            ip: "10.0.0.2",
        }
    }

    #[test]
    fn player_names() {
        assert_eq!(player_name("TiviMate/4.7.0 (Linux; Android 11)"), "TiviMate");
        assert_eq!(player_name("VLC/3.0.20 LibVLC/3.0.20"), "VLC");
        assert_eq!(player_name("Lavf/60.3.100"), "Lavf");
        assert_eq!(player_name(""), "");
    }

    #[test]
    fn refreshes_extend_one_watch_and_gaps_split_it() {
        let mut t = WatchTracker::default();
        for s in 0..=12 {
            t.touch(&hit("s1", "d1"), s * 6_000);
        }
        let rows = t.take_dirty(72_000);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].started, rows[0].ended), (0, 72_000));
        assert_eq!(rows[0].player, "TiviMate");
        // Unchanged since the flush: nothing to write.
        assert!(t.take_dirty(75_000).is_empty());
        // Extended: the same id again with the new end.
        t.touch(&hit("s1", "d1"), 78_000);
        let again = t.take_dirty(79_000);
        assert_eq!(again.len(), 1);
        assert_eq!((again[0].id.as_str(), again[0].ended), (rows[0].id.as_str(), 78_000));
        // After a long pause the next request is a new watch.
        t.touch(&hit("s1", "d1"), 300_000);
        assert_eq!(t.live(300_000).len(), 1);
        assert_ne!(t.live(300_000)[0].id, rows[0].id);
    }

    #[test]
    fn zaps_are_not_kept_and_idle_watches_close() {
        let mut t = WatchTracker::default();
        t.touch(&hit("s1", "d1"), 0);
        t.touch(&hit("s1", "d1"), 10_000);
        t.touch(&hit("s2", "d1"), 12_000);
        t.touch(&hit("s2", "d1"), 50_000);
        let rows = t.take_dirty(50_000);
        assert_eq!(rows.iter().map(|r| r.channel_id.as_str()).collect::<Vec<_>>(), ["s2"]);
        // Both are idle long after: s1 never qualified, s2 was flushed already.
        assert!(t.take_dirty(500_000).is_empty());
        assert!(t.live(500_000).is_empty());
    }

    #[test]
    fn a_watch_closed_by_a_new_one_is_written_with_its_final_end() {
        let mut t = WatchTracker::default();
        t.touch(&hit("s1", "d1"), 0);
        t.touch(&hit("s1", "d1"), 40_000);
        t.touch(&hit("s1", "d1"), 200_000);
        let rows = t.take_dirty(200_000);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].ended, 40_000);
    }

    #[test]
    fn devices_are_separate_and_forget_drops_everything() {
        let mut t = WatchTracker::default();
        t.touch(&hit("s1", "d1"), 0);
        t.touch(&hit("s1", "d2"), 0);
        assert_eq!(t.live(1_000).len(), 2);
        t.forget(7);
        assert!(t.live(1_000).is_empty());
        assert!(t.take_dirty(100_000).is_empty());
    }
}
