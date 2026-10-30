//! Channel health, as far as this server can see it: the Диагностика page.
//!
//! Only manifests pass through the gateway (segments go provider -> player),
//! so everything here is read off manifest traffic:
//!
//! - the provider: how long each manifest fetch took, which ones failed, and
//!   whether a live media playlist still moves (its last segment changes);
//! - the players: a refresh that comes much later than the target duration
//!   (a player that stalls or loses its connection), repeated tune-ins of the
//!   same channel (a player that keeps restarting it), and a tune-in whose
//!   player never asks for a quality afterwards (it could not play it).
//!
//! The tracker keeps the last [`MINUTES`] minutes per channel for the live
//! view, and turns every problem into an INCIDENT: one run of one kind of
//! problem on one channel, closed after [`CLOSE_AFTER_MS`] without a new
//! sighting. Incidents are the persistent problem register; like the viewing
//! history, [`Diagnostics::take_dirty`] hands out the changed ones for an
//! idempotent upsert. Clearing a channel (the admin fixed it) drops its open
//! incidents, so a problem that is still there opens a new one.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use serde::Serialize;

use super::devices::WAKE_MS;
use crate::core::util::make_token;

/// Minutes of per-channel history the live view shows.
pub const MINUTES: usize = 30;

/// An incident ends after this long without a new sighting.
pub const CLOSE_AFTER_MS: i64 = 120_000;

/// A provider answering slower than this (median of the last minutes) is slow.
pub const SLOW_MS: i64 = 1_500;

const MINUTE_MS: i64 = 60_000;

/// A viewer without a request for this long is gone: the device list's idle
/// window (`DEVICE_IDLE_SECONDS`), this by default.
const LIVE_MS: i64 = 60_000;

/// How far back a viewer's or channel's state looks.
const RECENT_MS: i64 = 120_000;

/// Fetch samples kept per channel (the oldest go first).
const SAMPLES_MAX: usize = 5_000;

/// A refresh this many target durations after the previous one is late
/// (a longer gap than the idle window is a new viewing)...
const LATE_FACTOR: f64 = 2.5;
/// ...and never earlier than this.
const LATE_MIN_MS: i64 = 15_000;

/// Late refreshes within [`RECENT_MS`] that make a viewer "buffering".
const LATE_COUNT: usize = 2;

/// Tune-ins of one channel by one device within [`RETUNE_WINDOW_MS`] that
/// read as a player restarting it.
const RETUNES: usize = 3;
const RETUNE_WINDOW_MS: i64 = 300_000;

/// A tune-in whose player has not asked for a quality after this long could
/// not play the channel.
const PLAYER_WAIT_MS: i64 = 20_000;

/// Failed fetches within [`RECENT_MS`] that make a channel failing.
const FAILURES: usize = 2;

/// A live playlist whose last segment stays the same this many target
/// durations (and at least [`FROZEN_MIN_MS`]) has frozen.
const FROZEN_FACTOR: f64 = 3.0;
const FROZEN_MIN_MS: i64 = 20_000;

/// What went wrong, as stored and sent to the admin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The provider failed manifest fetches of a channel being watched.
    Errors,
    /// The provider failed the fetch a tune-in needed: nobody got in.
    NoOpen,
    /// The provider's live playlist stopped moving.
    Frozen,
    /// The provider answers slowly.
    Slow,
    /// Players refresh late.
    Buffering,
    /// Players keep restarting the channel.
    Retunes,
    /// A player got the channel but never asked for a quality.
    Player,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Errors => "errors",
            Self::NoOpen => "no_open",
            Self::Frozen => "frozen",
            Self::Slow => "slow",
            Self::Buffering => "buffering",
            Self::Retunes => "retunes",
            Self::Player => "player",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "errors" => Self::Errors,
            "no_open" => Self::NoOpen,
            "frozen" => Self::Frozen,
            "slow" => Self::Slow,
            "buffering" => Self::Buffering,
            "retunes" => Self::Retunes,
            "player" => Self::Player,
            _ => return None,
        })
    }
}

/// One incident as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncidentRow {
    pub id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub kind: Kind,
    /// The last failure ("502", "timeout"), or the frozen playlist's segment
    /// length; empty when the kind says it all.
    pub detail: String,
    /// The worst value seen: slowest answer (ms), longest freeze or latest
    /// refresh (ms), most failures or restarts.
    pub peak: i64,
    /// Customers who were watching (or trying to).
    pub users: Vec<i64>,
    /// Epoch ms.
    pub started: i64,
    pub ended: i64,
}

/// A live media playlist's position, from a fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaInfo {
    pub sequence: i64,
    pub last_uri: String,
    pub target_ms: i64,
    /// `#EXT-X-ENDLIST`: a finished playlist does not move, and is not frozen.
    pub ended: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Ok {
        media: Option<MediaInfo>,
    },
    /// The failure, short: an HTTP status ("502") or `timeout`, `connect`,
    /// `too_large`.
    Failed(String),
}

/// One manifest fetch the gateway made for a player.
#[derive(Debug, Clone)]
pub struct Fetch<'a> {
    pub channel_id: &'a str,
    pub channel_name: &'a str,
    pub user_id: i64,
    /// The device key the device list uses.
    pub device: &'a str,
    pub player: &'a str,
    pub ip: &'a str,
    /// The tune-in this request belongs to (a tune-in's own new id).
    pub play: &'a str,
    /// The channel's entry URL (a tune-in), not a quality's refresh.
    pub tune_in: bool,
    /// Which provider playlist was fetched (each quality moves on its own).
    pub upstream: &'a str,
    pub latency_ms: i64,
    pub outcome: Outcome,
}

/// A viewer's state, worst first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerState {
    Noconn,
    Error,
    Frozen,
    Retune,
    Buffer,
    Ok,
}

/// A channel's state, worst first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelState {
    Frozen,
    Errors,
    Slow,
    Flaky,
    Ok,
}

/// One minute of the live strip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MinuteState {
    /// Nobody watched.
    None,
    Ok,
    Warn,
    Bad,
}

#[derive(Debug, Clone, Serialize)]
pub struct MinuteView {
    /// Epoch ms of the minute's start.
    pub at: i64,
    pub state: MinuteState,
    pub viewers: usize,
    pub troubled: usize,
    pub latency_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ViewerView {
    pub user_id: i64,
    pub player: String,
    pub ip: String,
    /// Epoch ms.
    pub since: i64,
    pub state: ViewerState,
    /// The latest late refresh in the recent window, ms after the previous.
    pub late_ms: i64,
    pub retunes: usize,
    /// The last failure the viewer got, if recent.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelView {
    pub channel_id: String,
    pub name: String,
    pub state: ChannelState,
    pub viewers: Vec<ViewerView>,
    /// Median answer time over the recent window.
    pub latency_ms: Option<i64>,
    /// Median answer time over the whole window, for "usually".
    pub usual_ms: Option<i64>,
    /// Fetches and failures in the last 15 minutes.
    pub requests: usize,
    pub failures: usize,
    pub error: Option<String>,
    /// How long the playlist has not moved, while frozen.
    pub frozen_ms: i64,
    pub target_ms: i64,
    pub minutes: Vec<MinuteView>,
}

#[derive(Debug, Default)]
struct Minute {
    index: i64,
    requests: u32,
    failures: u32,
    frozen: bool,
    latencies: Vec<i64>,
    viewers: HashSet<String>,
    troubled: HashSet<String>,
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    at: i64,
    latency_ms: i64,
    failed: bool,
}

#[derive(Debug)]
struct Viewer {
    user_id: i64,
    player: String,
    ip: String,
    first_seen: i64,
    last_seen: i64,
    last_refresh: Option<i64>,
    /// When and how late each late refresh was.
    late: VecDeque<(i64, i64)>,
    tune_ins: VecDeque<i64>,
    failures: VecDeque<i64>,
    last_error: Option<String>,
    /// The last fetch that worked; none in this viewing = never got in.
    last_ok: Option<i64>,
    /// When its player was found not to play the channel; cleared by a
    /// quality refresh.
    stuck: Option<i64>,
    /// Watching, as the device list counts it: a viewing starts as a lone
    /// request (a TV in standby checking in on its old playback every couple
    /// of minutes, an app probing a channel) and is only watching once a
    /// second request follows within [`WAKE_MS`].
    confirmed: bool,
}

#[derive(Debug)]
struct Position {
    sequence: i64,
    last_uri: String,
    /// When this position was first seen.
    since: i64,
    last_seen: i64,
    target_ms: i64,
}

#[derive(Debug)]
struct Open {
    row: IncidentRow,
    users: BTreeSet<i64>,
    dirty: bool,
}

#[derive(Debug, Default)]
struct ChannelHealth {
    name: String,
    minutes: VecDeque<Minute>,
    samples: VecDeque<Sample>,
    viewers: HashMap<String, Viewer>,
    positions: HashMap<String, Position>,
    last_error: Option<String>,
    last_activity: i64,
}

#[derive(Debug, Clone)]
struct Pending {
    channel_id: String,
    user_id: i64,
    device: String,
    at: i64,
}

#[derive(Debug)]
pub struct Diagnostics {
    /// The device list's idle window.
    live_ms: i64,
    channels: HashMap<String, ChannelHealth>,
    /// Tune-ins waiting for their player's first quality request, by play id.
    pending: HashMap<String, Pending>,
    /// Open incidents by (channel, kind).
    open: HashMap<(String, Kind), Open>,
    /// Ended incidents not handed out yet.
    closed: Vec<IncidentRow>,
    /// Channels in the problem register (stored or open), for the menu badge.
    problem_channels: HashSet<String>,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Self::new(LIVE_MS)
    }
}

fn minute_of(ms: i64) -> i64 {
    ms.div_euclid(MINUTE_MS)
}

fn median(values: &mut [i64]) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[values.len() / 2])
}

fn count_since(times: &VecDeque<i64>, from: i64) -> usize {
    times.iter().filter(|t| **t >= from).count()
}

fn trim_before(times: &mut VecDeque<i64>, from: i64) {
    while times.front().is_some_and(|t| *t < from) {
        times.pop_front();
    }
}

impl ChannelHealth {
    fn minute(&mut self, now: i64) -> &mut Minute {
        let index = minute_of(now);
        if self.minutes.back().is_none_or(|m| m.index != index) {
            self.minutes.push_back(Minute {
                index,
                ..Minute::default()
            });
            while self.minutes.len() > MINUTES {
                self.minutes.pop_front();
            }
        }
        let last = self.minutes.len() - 1;
        &mut self.minutes[last]
    }

    fn trouble(&mut self, device: &str, now: i64) {
        self.minute(now).troubled.insert(device.to_owned());
    }

    fn frozen_since(&self, now: i64) -> Option<i64> {
        self.positions
            .values()
            .filter(|p| now - p.last_seen <= RECENT_MS)
            .filter(|p| now - p.since >= frozen_after(p.target_ms))
            .map(|p| p.since)
            .min()
    }

    fn recent_latency(&self, from: i64) -> Option<i64> {
        let mut values: Vec<i64> = self
            .samples
            .iter()
            .filter(|s| s.at >= from && !s.failed)
            .map(|s| s.latency_ms)
            .collect();
        if values.len() < 3 {
            return None;
        }
        median(&mut values)
    }

    fn recent_failures(&self, from: i64) -> usize {
        self.samples.iter().filter(|s| s.at >= from && s.failed).count()
    }
}

fn frozen_after(target_ms: i64) -> i64 {
    FROZEN_MIN_MS.max((FROZEN_FACTOR * target_ms as f64) as i64)
}

impl Viewer {
    fn state(&self, channel_frozen: bool, now: i64) -> ViewerState {
        let recent = now - RECENT_MS;
        if self.stuck.is_some_and(|t| t >= recent) || self.last_ok.is_none_or(|t| t < self.first_seen) {
            ViewerState::Noconn
        } else if count_since(&self.failures, recent) >= FAILURES {
            ViewerState::Error
        } else if channel_frozen {
            ViewerState::Frozen
        } else if count_since(&self.tune_ins, now - RETUNE_WINDOW_MS) >= RETUNES {
            ViewerState::Retune
        } else if self.late.iter().filter(|(t, _)| *t >= recent).count() >= LATE_COUNT {
            ViewerState::Buffer
        } else {
            ViewerState::Ok
        }
    }
}

impl Diagnostics {
    /// `live_ms`: the device list's idle window, so both agree on who is
    /// watching.
    pub fn new(live_ms: i64) -> Self {
        Self {
            live_ms,
            channels: HashMap::new(),
            pending: HashMap::new(),
            open: HashMap::new(),
            closed: Vec::new(),
            problem_channels: HashSet::new(),
        }
    }

    /// Channels in the problem register at startup.
    pub fn load_problem_channels(&mut self, channel_ids: impl IntoIterator<Item = String>) {
        self.problem_channels.extend(channel_ids);
    }

    /// How many channels the problem register lists.
    pub fn problem_count(&self) -> usize {
        self.problem_channels.len()
    }

    /// Record one manifest fetch at `now` (epoch ms).
    pub fn record(&mut self, f: &Fetch<'_>, now: i64) {
        self.tick(now);
        // A device that moved to another channel was not stuck on this one.
        self.pending
            .retain(|_, p| !(p.user_id == f.user_id && p.device == f.device && p.channel_id != f.channel_id));
        let failed = matches!(f.outcome, Outcome::Failed(_));
        let ch = self.channels.entry(f.channel_id.to_owned()).or_default();
        f.channel_name.clone_into(&mut ch.name);
        ch.last_activity = now;
        ch.samples.push_back(Sample {
            at: now,
            latency_ms: f.latency_ms,
            failed,
        });
        let horizon = now - MINUTES as i64 * MINUTE_MS;
        while ch.samples.front().is_some_and(|s| s.at < horizon) || ch.samples.len() > SAMPLES_MAX {
            ch.samples.pop_front();
        }
        let live_ms = self.live_ms;
        let quiet = ch.viewers.get(f.device).map(|v| now - v.last_seen);
        let viewer = ch.viewers.entry(f.device.to_owned()).or_insert_with(|| Viewer {
            user_id: f.user_id,
            player: f.player.to_owned(),
            ip: f.ip.to_owned(),
            first_seen: now,
            last_seen: now,
            last_refresh: None,
            late: VecDeque::new(),
            tune_ins: VecDeque::new(),
            failures: VecDeque::new(),
            last_error: None,
            last_ok: None,
            stuck: None,
            confirmed: false,
        });
        match quiet {
            Some(gap) if gap > live_ms => {
                viewer.first_seen = now;
                viewer.last_refresh = None;
                viewer.confirmed = false;
            }
            Some(gap) if gap <= WAKE_MS => viewer.confirmed = true,
            _ => {}
        }
        let confirmed = viewer.confirmed;
        // Watching before this request (a failure at tune-in then is not "never opened").
        let was_watching = quiet.is_some_and(|gap| gap <= live_ms) && viewer.first_seen < now;
        viewer.last_seen = now;
        f.player.clone_into(&mut viewer.player);
        f.ip.clone_into(&mut viewer.ip);
        trim_before(&mut viewer.tune_ins, now - RETUNE_WINDOW_MS);
        trim_before(&mut viewer.failures, now - RECENT_MS);
        while viewer.late.front().is_some_and(|(t, _)| *t < now - RECENT_MS) {
            viewer.late.pop_front();
        }

        let mut sightings: Vec<(Kind, String, i64)> = Vec::new();
        let mut troubled = false;
        match &f.outcome {
            Outcome::Failed(code) => {
                viewer.failures.push_back(now);
                viewer.last_error = Some(code.clone());
                ch.last_error = Some(code.clone());
                troubled = true;
                if f.tune_in && !was_watching {
                    sightings.push((Kind::NoOpen, code.clone(), 1));
                } else {
                    let failures = ch.recent_failures(now - RECENT_MS);
                    if failures >= FAILURES {
                        sightings.push((Kind::Errors, code.clone(), failures as i64));
                    }
                }
            }
            Outcome::Ok { media } => {
                viewer.last_error = None;
                viewer.last_ok = Some(now);
                if f.tune_in {
                    viewer.tune_ins.push_back(now);
                    viewer.last_refresh = None;
                    let restarts = viewer.tune_ins.len();
                    if restarts >= RETUNES {
                        troubled = true;
                        sightings.push((Kind::Retunes, String::new(), restarts as i64));
                    }
                    self.pending.insert(
                        f.play.to_owned(),
                        Pending {
                            channel_id: f.channel_id.to_owned(),
                            user_id: f.user_id,
                            device: f.device.to_owned(),
                            at: now,
                        },
                    );
                } else {
                    self.pending.remove(f.play);
                    viewer.stuck = None;
                }
                if let Some(media) = media {
                    if let Some(prev) = viewer.last_refresh {
                        let gap = now - prev;
                        let late_after = LATE_MIN_MS.max((LATE_FACTOR * media.target_ms as f64) as i64);
                        if gap > late_after && gap <= live_ms {
                            viewer.late.push_back((now, gap));
                            troubled = true;
                            if viewer.late.len() >= LATE_COUNT {
                                let worst = viewer.late.iter().map(|(_, g)| *g).max().unwrap_or(gap);
                                sightings.push((Kind::Buffering, String::new(), worst));
                            }
                        }
                    }
                    viewer.last_refresh = Some(now);
                    if !media.ended {
                        let pos = ch.positions.entry(f.upstream.to_owned()).or_insert_with(|| Position {
                            sequence: media.sequence,
                            last_uri: media.last_uri.clone(),
                            since: now,
                            last_seen: now,
                            target_ms: media.target_ms,
                        });
                        if pos.sequence != media.sequence || pos.last_uri != media.last_uri {
                            pos.sequence = media.sequence;
                            pos.last_uri.clone_from(&media.last_uri);
                            pos.since = now;
                        }
                        pos.last_seen = now;
                        pos.target_ms = media.target_ms;
                        let still = now - pos.since;
                        if still >= frozen_after(pos.target_ms) {
                            troubled = true;
                            ch.minute(now).frozen = true;
                            sightings.push((Kind::Frozen, String::new(), still));
                        }
                    }
                }
                if let Some(latency) = ch.recent_latency(now - RECENT_MS)
                    && latency > SLOW_MS
                {
                    sightings.push((Kind::Slow, String::new(), f.latency_ms.max(latency)));
                }
            }
        }
        let minute = ch.minute(now);
        minute.requests += 1;
        if failed {
            minute.failures += 1;
        } else {
            minute.latencies.push(f.latency_ms);
        }
        if confirmed {
            minute.viewers.insert(f.device.to_owned());
            if troubled {
                minute.troubled.insert(f.device.to_owned());
            }
        }
        ch.positions.retain(|_, p| now - p.last_seen <= RECENT_MS);
        let name = ch.name.clone();
        for (kind, detail, peak) in sightings {
            self.sight(f.channel_id, &name, kind, f.user_id, &detail, peak, now);
        }
    }

    /// Note a problem: extends the open incident of that kind, or opens one.
    #[allow(clippy::too_many_arguments)]
    fn sight(&mut self, channel_id: &str, name: &str, kind: Kind, user_id: i64, detail: &str, peak: i64, now: i64) {
        let key = (channel_id.to_owned(), kind);
        if let Some(open) = self.open.get_mut(&key) {
            if now - open.row.ended <= CLOSE_AFTER_MS {
                open.row.ended = now;
                open.row.peak = open.row.peak.max(peak);
                if !detail.is_empty() {
                    detail.clone_into(&mut open.row.detail);
                }
                name.clone_into(&mut open.row.channel_name);
                open.users.insert(user_id);
                open.row.users = open.users.iter().copied().collect();
                open.dirty = true;
                return;
            }
            if let Some(old) = self.open.remove(&key) {
                self.closed.push(old.row);
            }
        }
        self.problem_channels.insert(channel_id.to_owned());
        self.open.insert(
            key,
            Open {
                row: IncidentRow {
                    id: make_token(16),
                    channel_id: channel_id.to_owned(),
                    channel_name: name.to_owned(),
                    kind,
                    detail: detail.to_owned(),
                    peak,
                    users: vec![user_id],
                    started: now,
                    ended: now,
                },
                users: BTreeSet::from([user_id]),
                dirty: true,
            },
        );
    }

    /// Time-driven checks: tune-ins whose player never came back, incidents
    /// gone quiet, channels nobody watches any more.
    pub fn tick(&mut self, now: i64) {
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| now - p.at >= PLAYER_WAIT_MS)
            .map(|(k, _)| k.clone())
            .collect();
        for play in expired {
            let Some(p) = self.pending.remove(&play) else {
                continue;
            };
            let Some(ch) = self.channels.get_mut(&p.channel_id) else {
                continue;
            };
            // It is still watching through another tune-in: a quick re-tune.
            if ch
                .viewers
                .get(&p.device)
                .is_some_and(|v| v.last_refresh.is_some_and(|r| r > p.at))
            {
                continue;
            }
            let mut confirmed = false;
            if let Some(v) = ch.viewers.get_mut(&p.device) {
                v.stuck = Some(now);
                confirmed = v.confirmed;
            }
            if confirmed {
                ch.trouble(&p.device, now);
            }
            let name = ch.name.clone();
            self.sight(&p.channel_id, &name, Kind::Player, p.user_id, "", 1, now);
        }

        let quiet: Vec<(String, Kind)> = self
            .open
            .iter()
            .filter(|(_, o)| now - o.row.ended > CLOSE_AFTER_MS)
            .map(|(k, _)| k.clone())
            .collect();
        for key in quiet {
            if let Some(open) = self.open.remove(&key) {
                self.closed.push(open.row);
            }
        }

        let horizon = now - MINUTES as i64 * MINUTE_MS;
        for ch in self.channels.values_mut() {
            ch.viewers.retain(|_, v| now - v.last_seen <= self.live_ms);
        }
        self.channels.retain(|_, ch| ch.last_activity >= horizon);
    }

    /// Incidents changed since the last call: the open ones that grew and
    /// every one that ended.
    pub fn take_dirty(&mut self, now: i64) -> Vec<IncidentRow> {
        self.tick(now);
        let mut rows = std::mem::take(&mut self.closed);
        for open in self.open.values_mut() {
            if open.dirty {
                open.dirty = false;
                rows.push(open.row.clone());
            }
        }
        rows
    }

    /// Rows whose write failed, to be retried.
    pub fn requeue(&mut self, rows: Vec<IncidentRow>) {
        for row in rows {
            let key = (row.channel_id.clone(), row.kind);
            match self.open.get_mut(&key) {
                Some(open) if open.row.id == row.id => open.dirty = true,
                _ => self.closed.push(row),
            }
        }
    }

    /// Incidents not stored yet (or not to their end), for reads that
    /// combine the stored register with what is happening now.
    pub fn unsaved(&self) -> Vec<IncidentRow> {
        self.open
            .values()
            .map(|o| o.row.clone())
            .chain(self.closed.iter().cloned())
            .collect()
    }

    /// The admin marked a channel fixed at `cleared` (epoch ms): incidents
    /// that started by then are gone, so a problem still there opens a new
    /// one.
    pub fn clear_channel(&mut self, channel_id: &str, cleared: i64) {
        self.open
            .retain(|(id, _), o| !(id == channel_id && o.row.started <= cleared));
        self.closed
            .retain(|r| !(r.channel_id == channel_id && r.started <= cleared));
        if !self.open.keys().any(|(id, _)| id == channel_id) && !self.closed.iter().any(|r| r.channel_id == channel_id)
        {
            self.problem_channels.remove(channel_id);
        }
    }

    /// A clearing was undone.
    pub fn restore_channel(&mut self, channel_id: &str) {
        self.problem_channels.insert(channel_id.to_owned());
    }

    /// Every channel somebody is watching, worst first.
    pub fn live(&mut self, now: i64) -> Vec<ChannelView> {
        self.tick(now);
        let mut out: Vec<ChannelView> = self
            .channels
            .iter()
            .filter_map(|(id, ch)| {
                let view = Self::view_of(id, ch, now, self.live_ms);
                (!view.viewers.is_empty()).then_some(view)
            })
            .collect();
        out.sort_by(|a, b| {
            a.state
                .cmp(&b.state)
                .then(b.viewers.len().cmp(&a.viewers.len()))
                .then_with(|| crate::core::util::locale_cmp(&a.name, &b.name))
        });
        out
    }

    /// One channel, watched or not; `None` when nothing was seen of it lately.
    pub fn channel(&mut self, channel_id: &str, now: i64) -> Option<ChannelView> {
        self.tick(now);
        let ch = self.channels.get(channel_id)?;
        Some(Self::view_of(channel_id, ch, now, self.live_ms))
    }

    fn view_of(channel_id: &str, ch: &ChannelHealth, now: i64, live_ms: i64) -> ChannelView {
        let recent = now - RECENT_MS;
        let frozen_since = ch.frozen_since(now);
        let mut viewers: Vec<ViewerView> = ch
            .viewers
            .values()
            .filter(|v| v.confirmed && now - v.last_seen <= live_ms)
            .map(|v| ViewerView {
                user_id: v.user_id,
                player: v.player.clone(),
                ip: v.ip.clone(),
                since: v.first_seen,
                state: v.state(frozen_since.is_some(), now),
                late_ms: v
                    .late
                    .iter()
                    .filter(|(t, _)| *t >= recent)
                    .map(|(_, g)| *g)
                    .max()
                    .unwrap_or(0),
                retunes: count_since(&v.tune_ins, now - RETUNE_WINDOW_MS),
                error: v.failures.back().filter(|t| **t >= recent).and(v.last_error.clone()),
            })
            .collect();
        viewers.sort_by_key(|v| (v.state as u8, v.since));

        let latency_ms = ch.recent_latency(recent);
        let state = if frozen_since.is_some() {
            ChannelState::Frozen
        } else if ch.recent_failures(recent) >= FAILURES {
            ChannelState::Errors
        } else if latency_ms.is_some_and(|l| l > SLOW_MS) {
            ChannelState::Slow
        } else if viewers.iter().any(|v| v.state != ViewerState::Ok) {
            ChannelState::Flaky
        } else {
            ChannelState::Ok
        };
        let quarter = now - 15 * MINUTE_MS;
        let mut all: Vec<i64> = ch.samples.iter().filter(|s| !s.failed).map(|s| s.latency_ms).collect();
        ChannelView {
            channel_id: channel_id.to_owned(),
            name: ch.name.clone(),
            state,
            viewers,
            latency_ms,
            usual_ms: median(&mut all),
            requests: ch.samples.iter().filter(|s| s.at >= quarter).count(),
            failures: ch.samples.iter().filter(|s| s.at >= quarter && s.failed).count(),
            error: ch.last_error.clone().filter(|_| ch.recent_failures(recent) > 0),
            frozen_ms: frozen_since.map_or(0, |since| now - since),
            target_ms: ch.positions.values().map(|p| p.target_ms).max().unwrap_or(0),
            minutes: minute_views(ch, now),
        }
    }
}

/// The last [`MINUTES`] minutes, oldest first, gaps filled with idle ones.
fn minute_views(ch: &ChannelHealth, now: i64) -> Vec<MinuteView> {
    let current = minute_of(now);
    (0..MINUTES as i64)
        .rev()
        .map(|back| {
            let index = current - back;
            let at = index * MINUTE_MS;
            let Some(m) = ch.minutes.iter().find(|m| m.index == index) else {
                return MinuteView {
                    at,
                    state: MinuteState::None,
                    viewers: 0,
                    troubled: 0,
                    latency_ms: None,
                };
            };
            let mut latencies = m.latencies.clone();
            let latency_ms = median(&mut latencies);
            let state = if m.requests == 0 && m.viewers.is_empty() {
                MinuteState::None
            } else if m.frozen || (m.failures > 0 && m.failures * 3 >= m.requests) {
                MinuteState::Bad
            } else if m.failures > 0 || !m.troubled.is_empty() || latency_ms.is_some_and(|l| l > SLOW_MS) {
                MinuteState::Warn
            } else {
                MinuteState::Ok
            };
            MinuteView {
                at,
                state,
                viewers: m.viewers.len(),
                troubled: m.troubled.len(),
                latency_ms,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn media(seq: i64) -> Outcome {
        Outcome::Ok {
            media: Some(MediaInfo {
                sequence: seq,
                last_uri: format!("seg_{seq}.ts"),
                target_ms: 6_000,
                ended: false,
            }),
        }
    }

    fn fetch<'a>(device: &'a str, play: &'a str, tune_in: bool, latency_ms: i64, outcome: Outcome) -> Fetch<'a> {
        Fetch {
            channel_id: "ch1",
            channel_name: "Канал",
            user_id: 7,
            device,
            player: "TiviMate",
            ip: "192.0.2.1",
            play,
            tune_in,
            upstream: "http://p/v.m3u8",
            latency_ms,
            outcome,
        }
    }

    fn tune(d: &mut Diagnostics, device: &str, play: &str, at: i64) {
        d.record(&fetch(device, play, true, 100, Outcome::Ok { media: None }), at);
    }

    /// A healthy viewer: tune in, then refresh every 6 s with a moving playlist.
    fn watch(d: &mut Diagnostics, device: &str, from: i64, to: i64, latency_ms: i64) {
        tune(d, device, "p1", from);
        let mut at = from + 1_000;
        let mut seq = 0;
        while at <= to {
            d.record(&fetch(device, "p1", false, latency_ms, media(seq)), at);
            seq += 1;
            at += 6_000;
        }
    }

    fn kinds(d: &Diagnostics) -> Vec<Kind> {
        let mut k: Vec<Kind> = d.unsaved().iter().map(|r| r.kind).collect();
        k.sort();
        k
    }

    #[test]
    fn a_healthy_viewer_raises_nothing() {
        let mut d = Diagnostics::default();
        watch(&mut d, "tv", T0, T0 + 600_000, 120);
        let now = T0 + 600_000;
        assert!(kinds(&d).is_empty());
        let live = d.live(now);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].state, ChannelState::Ok);
        assert_eq!(live[0].viewers[0].state, ViewerState::Ok);
        assert_eq!(live[0].minutes.len(), MINUTES);
        assert_eq!(live[0].minutes.last().unwrap().state, MinuteState::Ok);
        assert_eq!(d.problem_count(), 0);
    }

    #[test]
    fn slow_answers_make_a_slow_incident() {
        let mut d = Diagnostics::default();
        watch(&mut d, "tv", T0, T0 + 60_000, 2_800);
        let now = T0 + 60_000;
        assert_eq!(kinds(&d), [Kind::Slow]);
        assert_eq!(d.live(now)[0].state, ChannelState::Slow);
        assert_eq!(d.problem_count(), 1);
    }

    #[test]
    fn late_refreshes_are_buffering() {
        let mut d = Diagnostics::default();
        tune(&mut d, "tv", "p1", T0);
        let mut at = T0 + 1_000;
        for seq in 0..6 {
            d.record(&fetch("tv", "p1", false, 100, media(seq)), at);
            at += if seq % 2 == 0 { 20_000 } else { 6_000 };
        }
        assert_eq!(kinds(&d), [Kind::Buffering]);
        let live = d.live(at);
        assert_eq!(live[0].viewers[0].state, ViewerState::Buffer);
        assert_eq!(live[0].state, ChannelState::Flaky);
        assert_eq!(live[0].viewers[0].late_ms, 20_000);
    }

    #[test]
    fn a_playlist_that_stops_moving_is_frozen() {
        let mut d = Diagnostics::default();
        tune(&mut d, "tv", "p1", T0);
        for i in 0..8 {
            d.record(&fetch("tv", "p1", false, 100, media(5)), T0 + 1_000 + i * 6_000);
        }
        let now = T0 + 43_000;
        assert_eq!(kinds(&d), [Kind::Frozen]);
        let live = d.live(now);
        assert_eq!(live[0].state, ChannelState::Frozen);
        assert_eq!(live[0].viewers[0].state, ViewerState::Frozen);
        assert!(live[0].frozen_ms >= 20_000);
    }

    #[test]
    fn failures_split_into_never_opened_and_errors() {
        let mut d = Diagnostics::default();
        d.record(&fetch("phone", "", true, 8_000, Outcome::Failed("timeout".into())), T0);
        assert_eq!(kinds(&d), [Kind::NoOpen]);
        assert!(d.live(T0).is_empty(), "one attempt is not somebody watching");
        // The player tries again: it is there, and never got in.
        d.record(
            &fetch("phone", "", true, 8_000, Outcome::Failed("timeout".into())),
            T0 + 10_000,
        );
        let live = d.live(T0 + 10_000);
        assert_eq!(live[0].viewers[0].state, ViewerState::Noconn);
        assert_eq!(live[0].viewers[0].error.as_deref(), Some("timeout"));

        let mut d = Diagnostics::default();
        watch(&mut d, "tv", T0, T0 + 30_000, 100);
        d.record(
            &fetch("tv", "p1", false, 100, Outcome::Failed("502".into())),
            T0 + 37_000,
        );
        assert!(kinds(&d).is_empty(), "one failure is noise");
        d.record(
            &fetch("tv", "p1", false, 100, Outcome::Failed("502".into())),
            T0 + 43_000,
        );
        assert_eq!(kinds(&d), [Kind::Errors]);
        let live = d.live(T0 + 43_000);
        assert_eq!(live[0].state, ChannelState::Errors);
        assert_eq!(live[0].viewers[0].error.as_deref(), Some("502"));
        assert_eq!(d.unsaved()[0].detail, "502");
    }

    #[test]
    fn restarts_and_unplayed_tune_ins_are_the_players() {
        let mut d = Diagnostics::default();
        for (i, play) in ["a", "b", "c"].iter().enumerate() {
            tune(&mut d, "tv", play, T0 + i as i64 * 30_000);
            d.record(
                &fetch("tv", play, false, 100, media(i as i64)),
                T0 + i as i64 * 30_000 + 500,
            );
        }
        assert_eq!(kinds(&d), [Kind::Retunes]);

        let mut d = Diagnostics::default();
        tune(&mut d, "phone", "x", T0);
        d.tick(T0 + 10_000);
        assert!(kinds(&d).is_empty());
        tune(&mut d, "phone", "y", T0 + 15_000);
        d.tick(T0 + PLAYER_WAIT_MS);
        assert_eq!(kinds(&d), [Kind::Player]);
        assert_eq!(d.live(T0 + PLAYER_WAIT_MS)[0].viewers[0].state, ViewerState::Noconn);

        // A player that does come back is fine.
        let mut d = Diagnostics::default();
        tune(&mut d, "phone", "x", T0);
        d.record(&fetch("phone", "x", false, 100, media(0)), T0 + 800);
        d.tick(T0 + 60_000);
        assert!(kinds(&d).is_empty());
    }

    #[test]
    fn incidents_close_when_quiet_and_reopen_as_new_ones() {
        let mut d = Diagnostics::default();
        d.record(&fetch("a", "", true, 100, Outcome::Failed("404".into())), T0);
        let first = d.take_dirty(T0);
        assert_eq!(first.len(), 1);
        assert!(d.take_dirty(T0 + 1_000).is_empty(), "nothing changed");
        d.record(&fetch("b", "", true, 100, Outcome::Failed("404".into())), T0 + 60_000);
        let grown = d.take_dirty(T0 + 60_000);
        assert_eq!(grown.len(), 1);
        assert_eq!(grown[0].id, first[0].id, "the same incident");
        assert_eq!(grown[0].users, [7]);
        assert_eq!(grown[0].ended, T0 + 60_000);
        // Quiet for longer than CLOSE_AFTER_MS: it ends; the next is new.
        let ended = d.take_dirty(T0 + 60_000 + CLOSE_AFTER_MS + 1);
        assert_eq!(ended.len(), 1);
        d.record(&fetch("a", "", true, 100, Outcome::Failed("404".into())), T0 + 400_000);
        let next = d.take_dirty(T0 + 400_000);
        assert_ne!(next[0].id, first[0].id);
    }

    #[test]
    fn clearing_a_channel_starts_its_register_over() {
        let mut d = Diagnostics::default();
        d.record(&fetch("a", "", true, 100, Outcome::Failed("404".into())), T0);
        let before = d.take_dirty(T0);
        assert_eq!(d.problem_count(), 1);
        d.clear_channel("ch1", T0 + 1_000);
        assert_eq!(d.problem_count(), 0);
        assert!(d.unsaved().is_empty());
        // Still broken: a new incident, the channel is back.
        d.record(&fetch("a", "", true, 100, Outcome::Failed("404".into())), T0 + 2_000);
        let after = d.take_dirty(T0 + 2_000);
        assert_eq!(after.len(), 1);
        assert_ne!(after[0].id, before[0].id);
        assert_eq!(d.problem_count(), 1);
        // A failed write is retried.
        d.requeue(after.clone());
        assert_eq!(d.take_dirty(T0 + 3_000), after);
    }

    #[test]
    fn a_player_in_standby_checking_in_is_not_watching() {
        // A TV asleep with the app running refreshes its old playback once
        // every couple of minutes: not watching, not in the minute counts.
        let mut d = Diagnostics::default();
        for i in 0..5 {
            let at = T0 + i * 150_000;
            d.record(&fetch("tv", "old", false, 100, media(i)), at);
            assert!(d.live(at).is_empty(), "check-in {i} listed");
            assert!(d.channel("ch1", at).unwrap().minutes.iter().all(|m| m.viewers == 0));
        }
        assert!(kinds(&d).is_empty());
        // Woken up: refreshes come every few seconds again.
        let at = T0 + 4 * 150_000 + 6_000;
        d.record(&fetch("tv", "old", false, 100, media(5)), at);
        let live = d.live(at);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].viewers[0].since, T0 + 4 * 150_000);
        assert_eq!(live[0].minutes.last().unwrap().viewers, 1);
    }

    #[test]
    fn idle_channels_and_viewers_drop_out() {
        let mut d = Diagnostics::default();
        watch(&mut d, "tv", T0, T0 + 30_000, 100);
        assert_eq!(d.live(T0 + 60_000).len(), 1);
        assert!(d.live(T0 + 120_000).is_empty(), "nobody watching any more");
        assert!(d.channel("ch1", T0 + 120_000).is_some(), "history stays for the window");
        assert!(d.channel("ch1", T0 + 31 * MINUTE_MS + 30_000).is_none());
    }
}
