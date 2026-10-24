//! Simultaneous-device limit for the stream gateway.
//!
//! "A device is watching" means "it fetched a gated manifest within the last
//! `idle_ms`". There is no session to log out of: a device that stops polling
//! ages out and frees its slot.
//!
//! WHAT A DEVICE IS: the pair (client IP, device tag). The tag is baked into
//! the gate URLs when the playlist is downloaded ([`device_tag`]) rather than
//! taken from each request's User-Agent, because one app often fetches through
//! two HTTP stacks (okhttp probe, then ExoPlayer) and would count twice.
//!
//! TWO DEVICES CAN SHARE A KEY: identical TVs behind one router with the same
//! app send byte-identical requests. What still tells them apart is the
//! playback: every tune-in is handed a media playlist link of its own (the
//! gateway's `play` id), and a device refreshes one playback at a time. A key
//! that keeps refreshing two playbacks side by side for longer than
//! [`ZAP_MS`] is two devices; until then it may be a zap or a re-tune. Links
//! without a play id (older ones) fall back to the channel.
//!
//! ONE DEVICE CAN HAVE TWO KEYS: the app probes a channel through its own
//! HTTP stack and hands it to the TV's media stack (a tagless link has only
//! the User-Agent to go by), or the playlist was downloaded again by another
//! User-Agent. A newcomer from the address of a device already watching the
//! same channel, with another User-Agent, counts as that device, and is let
//! in on its slot. Only playing alongside it tells a second device apart (a
//! phone and a TV at home on one channel): a playback of its own refreshed
//! next to that device's for longer than [`ZAP_MS`]. A probe stops first.
//!
//! WHO WINS when there are more devices than slots: the ones that started
//! first. A newcomer is refused, never the device already watching. A refused
//! device holds no slot, but is remembered (same idle window) so the admin
//! can see the attempt.
//!
//! The built-in loops (info and media channel) are not limited, but a device
//! playing one is still watching: [`DeviceTracker::view`] lists it without
//! giving it a slot. This list is the one "who is watching now" every admin
//! screen shows.

use std::collections::HashMap;

use base64::Engine as _;
use serde::Serialize;
use sha1::{Digest, Sha1};

/// Short stable tag for "the client that downloaded this playlist".
pub fn device_tag(user_agent: &str) -> String {
    let digest = Sha1::digest(user_agent.as_bytes());
    let mut tag = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    tag.truncate(10);
    tag
}

/// The key the tracker counts. The tag wins over the live User-Agent.
pub fn device_key(ip: &str, tag: &str, user_agent: &str) -> String {
    let who = if tag.is_empty() {
        format!("ua:{user_agent}")
    } else {
        format!("t:{tag}")
    };
    let mut key = hex::encode(Sha1::digest(format!("{ip}|{who}").as_bytes()));
    key.truncate(20);
    key
}

/// What the admin sees about a device.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DeviceInfo {
    pub ip: String,
    pub ua: String,
    /// The app's name (`players::describe_player`), as the statistics show it.
    pub player: String,
    pub channel: String,
    /// The playback a media playlist link belongs to (empty: unknown). Tells
    /// apart devices that share a key; not shown.
    #[serde(skip)]
    pub play: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    #[serde(flatten)]
    pub info: DeviceInfo,
    pub first_seen: i64,
    pub last_seen: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListedDevice {
    #[serde(flatten)]
    pub device: Device,
    pub allowed: bool,
    /// Counts against the limit (a gated channel, not only a built-in loop).
    pub slot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Admission {
    pub allowed: bool,
    pub active: usize,
    pub limit: i64,
    /// The device the request was counted as, for the viewing history.
    pub slot: String,
}

/// How long a key may refresh a second playback before that is a second
/// device rather than a zap. Above the reload interval of any live playlist,
/// so a device still on its old playback has refreshed it again by then.
pub const ZAP_MS: i64 = 15_000;

type Slots = HashMap<i64, HashMap<String, Device>>;

/// A second key of a device holding a slot: `(holder key, last seen)`.
type Aliases = HashMap<i64, HashMap<String, (String, i64)>>;

#[derive(Debug, Default)]
pub struct DeviceTracker {
    idle_ms: i64,
    users: Slots,
    refused: Slots,
    /// Devices playing a built-in loop: listed, but holding no slot.
    viewing: Slots,
    aliases: Aliases,
    /// Per (customer, key): playbacks (or channels, for links without one)
    /// none of its devices plays yet, `(first, last)` request, until
    /// [`ZAP_MS`] tells whose they are.
    pending: HashMap<(i64, String), HashMap<String, (i64, i64)>>,
}

/// Which of the devices behind one key a request is.
enum Lane {
    /// A device holding (or ranked out of) a slot, by its slot key.
    Slot(String),
    /// Started too recently to tell: whether it may play, and the device it
    /// is counted as meanwhile.
    Pending(bool, String),
}

/// The key a device's slot belongs to: devices sharing one key are
/// `key`, `key#1`, `key#2`…
fn base_key(slot: &str) -> &str {
    slot.split('#').next().unwrap_or(slot)
}

fn prune(map: &mut Slots, user: i64, now: i64, idle_ms: i64) {
    if let Some(devices) = map.get_mut(&user) {
        devices.retain(|_, d| now - d.last_seen <= idle_ms);
        if devices.is_empty() {
            map.remove(&user);
        }
    }
}

impl DeviceTracker {
    pub fn new(idle_ms: i64) -> Self {
        Self {
            idle_ms,
            ..Self::default()
        }
    }

    /// The slot holder `key` belongs to, when it is another key of a device
    /// already watching: known as one, or new and from that device's address
    /// on the channel it plays through another HTTP stack. Call after
    /// pruning `users`.
    fn holder_of(&mut self, user: i64, key: &str, info: &DeviceInfo, now: i64) -> Option<String> {
        let empty = HashMap::new();
        let devices = self.users.get(&user).unwrap_or(&empty);
        let aliases = self.aliases.entry(user).or_default();
        aliases.retain(|_, (holder, seen)| devices.contains_key(holder) && now - *seen <= self.idle_ms);
        let found = if devices.contains_key(key) {
            None
        } else if let Some((holder, seen)) = aliases.get_mut(key) {
            *seen = now;
            Some(holder.clone())
        } else if info.ip.is_empty() || info.channel.is_empty() {
            None
        } else {
            let holder = devices
                .iter()
                .filter(|(_, d)| d.info.ip == info.ip && d.info.channel == info.channel && d.info.ua != info.ua)
                .min_by_key(|(_, d)| d.first_seen)
                .map(|(k, _)| k.clone());
            if let Some(holder) = &holder {
                aliases.insert(key.to_owned(), (holder.clone(), now));
                if let Some(r) = self.refused.get_mut(&user) {
                    r.remove(key);
                }
            }
            holder
        };
        if aliases.is_empty() {
            self.aliases.remove(&user);
        }
        found
    }

    /// Which device behind `key` this request is: the one refreshing its
    /// playback (or, by channel: links without one, and another key's
    /// requests); else after [`ZAP_MS`] the one that went quiet (it zapped or
    /// re-tuned) or a new one (two devices on one key). Call after pruning
    /// `users`.
    fn lane(&mut self, user: i64, key: &str, info: &DeviceInfo, limit: i64, now: i64) -> Lane {
        self.pending.retain(|(u, _), started| {
            started.retain(|_, (_, last)| now - *last < ZAP_MS);
            *u != user || !started.is_empty()
        });
        let Some(devices) = self.users.get_mut(&user) else {
            return Lane::Slot(key.to_owned());
        };
        let mut lanes: Vec<(&String, &Device)> = devices.iter().filter(|(k, _)| base_key(k) == key).collect();
        lanes.sort_by_key(|(_, d)| d.first_seen);
        let Some((oldest_key, oldest)) = lanes.first().map(|(k, d)| ((*k).clone(), d.first_seen)) else {
            return Lane::Slot(key.to_owned());
        };
        let on_channel = |d: &Device| d.info.channel == info.channel;
        let found = if info.play.is_empty() {
            lanes.iter().find(|(_, d)| on_channel(d))
        } else {
            // Its own playback, or a device on that channel not tied to one yet.
            lanes
                .iter()
                .find(|(_, d)| d.info.play == info.play)
                .or_else(|| lanes.iter().find(|(_, d)| d.info.play.is_empty() && on_channel(d)))
        };
        if let Some((k, _)) = found {
            return Lane::Slot((*k).clone());
        }
        let quiet = lanes
            .iter()
            .filter(|(_, d)| now - d.last_seen >= ZAP_MS)
            .max_by_key(|(_, d)| d.last_seen)
            .map(|(k, _)| (*k).clone());
        let started = if info.play.is_empty() {
            format!("c:{}", info.channel)
        } else {
            format!("p:{}", info.play)
        };
        let pending = self.pending.entry((user, key.to_owned())).or_default();
        let (first, _) = *pending
            .entry(started.clone())
            .and_modify(|p| p.1 = now)
            .or_insert((now, now));
        if now - first < ZAP_MS {
            // A zap or a second device: it plays if the device it would be does.
            let rank = devices.values().filter(|d| d.first_seen < oldest).count() as i64;
            return Lane::Pending(!(limit > 0 && rank >= limit), oldest_key);
        }
        pending.remove(&started);
        if let Some(k) = quiet {
            return Lane::Slot(k);
        }
        let k = (1..=devices.len())
            .map(|i| format!("{key}#{i}"))
            .find(|k| !devices.contains_key(k))
            .unwrap_or_else(|| format!("{key}#0"));
        devices.insert(
            k.clone(),
            Device {
                info: info.clone(),
                first_seen: first,
                last_seen: now,
            },
        );
        Lane::Slot(k)
    }

    /// Ask for a slot. `limit` 0 = unlimited.
    pub fn admit(&mut self, user: i64, key: &str, limit: i64, mut info: DeviceInfo, now: i64) -> Admission {
        prune(&mut self.users, user, now, self.idle_ms);
        let holder = self.holder_of(user, key, &info, now);
        let base = holder.as_deref().map_or(key, base_key).to_owned();
        let lane = self.lane(user, &base, &info, limit, now);
        let active = self.users.get(&user).map_or(0, HashMap::len);
        let slot = match lane {
            Lane::Slot(k) => k,
            Lane::Pending(allowed, slot) => {
                return Admission {
                    allowed,
                    active,
                    limit,
                    slot,
                };
            }
        };
        let key = slot.as_str();

        if let Some(devices) = self.users.get_mut(&user)
            && let Some(first_seen) = devices.get(key).map(|d| d.first_seen)
        {
            // Oldest first: a device keeps its slot only while it is among the
            // first `limit` arrivals still watching (matters after lowering it).
            let rank = devices.values().filter(|d| d.first_seen < first_seen).count() as i64;
            if limit > 0 && rank >= limit {
                return Admission {
                    allowed: false,
                    active,
                    limit,
                    slot,
                };
            }
            if let Some(d) = devices.get_mut(key) {
                if !info.play.is_empty() {
                    d.info.play = std::mem::take(&mut info.play);
                }
                // A device keeps the name it is known by: its other key, or a
                // request that names nothing, only says what it plays now.
                if !d.info.player.is_empty() && (holder.is_some() || info.player.is_empty()) {
                    d.info.channel = info.channel;
                } else {
                    info.play = std::mem::take(&mut d.info.play);
                    d.info = info;
                }
                d.last_seen = now;
            }
            return Admission {
                allowed: true,
                active,
                limit,
                slot,
            };
        }

        if limit > 0 && active as i64 >= limit {
            let refused = self.refused.entry(user).or_default();
            let first_seen = refused.get(key).map_or(now, |d| d.first_seen);
            refused.insert(
                key.to_owned(),
                Device {
                    info,
                    first_seen,
                    last_seen: now,
                },
            );
            return Admission {
                allowed: false,
                active,
                limit,
                slot,
            };
        }
        if let Some(r) = self.refused.get_mut(&user) {
            r.remove(key);
        }
        let devices = self.users.entry(user).or_default();
        devices.insert(
            key.to_owned(),
            Device {
                info,
                first_seen: now,
                last_seen: now,
            },
        );
        Admission {
            allowed: true,
            active: devices.len(),
            limit,
            slot,
        }
    }

    /// A device is playing a built-in loop. Listed as watching; no slot.
    pub fn view(&mut self, user: i64, key: &str, info: DeviceInfo, now: i64) {
        prune(&mut self.viewing, user, now, self.idle_ms);
        let devices = self.viewing.entry(user).or_default();
        let first_seen = devices.get(key).map_or(now, |d| d.first_seen);
        devices.insert(
            key.to_owned(),
            Device {
                info,
                first_seen,
                last_seen: now,
            },
        );
    }

    pub fn idle_ms(&self) -> i64 {
        self.idle_ms
    }

    /// Devices holding a slot (oldest first, flagged with whether they are
    /// inside the limit), then the ones only on a built-in loop, then the
    /// newcomers recently turned away.
    ///
    /// The loops are fetched without the playlist's device tag, so a device
    /// that switches between a gated channel and a loop is matched by address
    /// and player instead, and listed once, on whatever it played last.
    pub fn list(&mut self, user: i64, limit: i64, now: i64) -> Vec<ListedDevice> {
        for map in [&mut self.users, &mut self.refused, &mut self.viewing] {
            prune(map, user, now, self.idle_ms);
        }
        let empty = HashMap::new();
        let slots = self.users.get(&user).unwrap_or(&empty);
        let same = |a: &Device, b: &Device| a.info.ip == b.info.ip && a.info.player == b.info.player;

        let mut held: Vec<&Device> = slots.values().collect();
        held.sort_by_key(|d| d.first_seen);
        let mut out: Vec<ListedDevice> = held
            .into_iter()
            .enumerate()
            .map(|(i, d)| ListedDevice {
                device: d.clone(),
                allowed: !(limit > 0 && i as i64 >= limit),
                slot: true,
            })
            .collect();

        let mut loops: Vec<&Device> = self
            .viewing
            .get(&user)
            .map(|m| m.values().collect())
            .unwrap_or_default();
        loops.sort_by_key(|d| d.first_seen);
        let mut away: Vec<&Device> = self
            .refused
            .get(&user)
            .map(|m| {
                m.iter()
                    .filter(|(k, _)| !slots.contains_key(*k))
                    .map(|(_, d)| d)
                    .collect()
            })
            .unwrap_or_default();
        away.sort_by_key(|d| d.first_seen);

        for v in loops {
            if let Some(row) = out.iter_mut().find(|r| same(&r.device, v)) {
                if v.last_seen > row.device.last_seen {
                    row.device.info.channel.clone_from(&v.info.channel);
                    row.device.last_seen = v.last_seen;
                }
                continue;
            }
            if away.iter().any(|r| same(r, v) && r.last_seen > v.last_seen) {
                continue;
            }
            out.push(ListedDevice {
                device: v.clone(),
                allowed: true,
                slot: false,
            });
        }
        for r in away {
            if out.iter().any(|row| !row.slot && same(&row.device, r)) {
                continue;
            }
            out.push(ListedDevice {
                device: r.clone(),
                allowed: false,
                slot: false,
            });
        }
        out
    }

    /// Drop every device of one customer (deleted account, rotated token).
    pub fn forget(&mut self, user: i64) {
        self.users.remove(&user);
        self.refused.remove(&user);
        self.viewing.remove(&user);
        self.aliases.remove(&user);
        self.pending.retain(|(u, _), _| *u != user);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;

    fn slots(t: &mut DeviceTracker, user: i64, now: i64) -> usize {
        t.list(user, 0, now).iter().filter(|d| d.slot).count()
    }

    fn ch(c: &str) -> DeviceInfo {
        DeviceInfo {
            channel: c.into(),
            ..DeviceInfo::default()
        }
    }

    #[test]
    fn first_devices_get_slots() {
        let mut t = DeviceTracker::new(60_000);
        assert!(t.admit(1, "tv", 2, DeviceInfo::default(), T0).allowed);
        assert!(t.admit(1, "phone", 2, DeviceInfo::default(), T0 + 1).allowed);
        assert_eq!(
            t.admit(1, "tablet", 2, DeviceInfo::default(), T0 + 2),
            Admission {
                allowed: false,
                active: 2,
                limit: 2,
                slot: "tablet".into()
            }
        );
        assert!(t.admit(1, "tv", 2, DeviceInfo::default(), T0 + 3).allowed);
        assert!(t.admit(1, "phone", 2, DeviceInfo::default(), T0 + 4).allowed);
    }

    #[test]
    fn refused_holds_no_slot_and_idle_frees() {
        let mut t = DeviceTracker::new(60_000);
        t.admit(1, "tv", 1, DeviceInfo::default(), T0);
        for i in 1..=5 {
            assert!(!t.admit(1, "phone", 1, DeviceInfo::default(), T0 + i * 1000).allowed);
        }
        assert_eq!(slots(&mut t, 1, T0 + 5000), 1);
        assert!(t.admit(1, "phone", 1, DeviceInfo::default(), T0 + 60_001).allowed);
        assert!(!t.admit(1, "tv", 1, DeviceInfo::default(), T0 + 60_002).allowed);
    }

    fn summary(t: &mut DeviceTracker, now: i64) -> Vec<(String, bool)> {
        t.list(1, 1, now)
            .into_iter()
            .map(|d| (d.device.info.channel, d.allowed))
            .collect()
    }

    #[test]
    fn turned_away_listed_until_idle() {
        let mut t = DeviceTracker::new(60_000);
        t.admit(1, "tv", 1, ch("A"), T0);
        t.admit(1, "phone", 1, ch("B"), T0 + 1000);
        t.admit(1, "tv", 1, ch("A"), T0 + 2000);
        assert_eq!(summary(&mut t, T0 + 3000), [("A".into(), true), ("B".into(), false)]);
        assert_eq!(slots(&mut t, 1, T0 + 3000), 1);
        assert!(t.admit(1, "phone", 1, ch("B"), T0 + 62_001).allowed);
        assert_eq!(summary(&mut t, T0 + 62_002), [("B".into(), true)]);
        t.admit(1, "tablet", 1, DeviceInfo::default(), T0 + 62_003);
        assert_eq!(t.list(1, 1, T0 + 62_004).len(), 2);
        assert_eq!(t.list(1, 1, T0 + 200_000).len(), 0);
    }

    #[test]
    fn lowering_limit_keeps_earliest() {
        let mut t = DeviceTracker::new(60_000);
        for (i, k) in ["a", "b", "c"].iter().enumerate() {
            t.admit(1, k, 3, DeviceInfo::default(), T0 + i as i64);
        }
        assert!(!t.admit(1, "c", 2, DeviceInfo::default(), T0 + 3).allowed);
        assert!(t.admit(1, "a", 2, DeviceInfo::default(), T0 + 4).allowed);
        assert!(t.admit(1, "b", 2, DeviceInfo::default(), T0 + 5).allowed);
        assert_eq!(
            t.list(1, 2, T0 + 6).iter().map(|d| d.allowed).collect::<Vec<_>>(),
            [true, true, false]
        );
    }

    #[test]
    fn zero_is_unlimited_and_customers_separate() {
        let mut t = DeviceTracker::new(60_000);
        for i in 0..20 {
            assert!(t.admit(1, &format!("d{i}"), 0, DeviceInfo::default(), T0).allowed);
        }
        assert!(t.admit(2, "tv", 1, DeviceInfo::default(), T0).allowed);
        assert_eq!(slots(&mut t, 1, T0), 20);
        t.forget(1);
        assert_eq!(slots(&mut t, 1, T0), 0);
        assert_eq!(slots(&mut t, 2, T0), 1);
    }

    fn on(ip: &str, player: &str, c: &str) -> DeviceInfo {
        DeviceInfo {
            ip: ip.into(),
            player: player.into(),
            channel: c.into(),
            ..DeviceInfo::default()
        }
    }

    #[test]
    fn loop_viewers_are_listed_without_a_slot() {
        let mut t = DeviceTracker::new(60_000);
        t.admit(1, "tv", 1, on("10.0.0.2", "TiviMate", "Спорт"), T0);
        // Another device on the info channel: watching, but the limit of one
        // still lets nobody else onto a gated channel.
        t.view(1, "ua:phone", on("10.0.0.3", "VLC", "Инфоканал"), T0 + 1000);
        assert!(
            !t.admit(1, "tablet", 1, on("10.0.0.4", "Kodi", "Спорт"), T0 + 2000)
                .allowed
        );
        let rows: Vec<(String, bool, bool)> = t
            .list(1, 1, T0 + 3000)
            .into_iter()
            .map(|d| (d.device.info.channel, d.allowed, d.slot))
            .collect();
        assert_eq!(
            rows,
            [
                ("Спорт".into(), true, true),
                ("Инфоканал".into(), true, false),
                ("Спорт".into(), false, false),
            ]
        );
        // The slot holder switches to the info channel: still one device, on
        // what it plays now, keeping its slot until it goes idle.
        t.view(1, "ua:tv", on("10.0.0.2", "TiviMate", "Инфоканал"), T0 + 4000);
        let tv = &t.list(1, 1, T0 + 5000)[0];
        assert_eq!((tv.device.info.channel.as_str(), tv.slot), ("Инфоканал", true));
        assert_eq!(t.list(1, 1, T0 + 5000).len(), 3);
        // Idle loop viewers drop out like everyone else.
        assert!(t.list(1, 1, T0 + 200_000).is_empty());
        t.view(1, "ua:phone", on("10.0.0.3", "VLC", "Инфоканал"), T0 + 200_000);
        t.forget(1);
        assert!(t.list(1, 1, T0 + 200_001).is_empty());
    }

    fn stack(ip: &str, ua: &str, player: &str, c: &str) -> DeviceInfo {
        DeviceInfo {
            ua: ua.into(),
            ..on(ip, player, c)
        }
    }

    /// One player refreshing its playlist every 5 s over `[from, to]`.
    fn poll(t: &mut DeviceTracker, key: &str, limit: i64, info: &DeviceInfo, from: i64, to: i64) -> Vec<bool> {
        (from..=to)
            .step_by(5000)
            .map(|at| t.admit(1, key, limit, info.clone(), T0 + at).allowed)
            .collect()
    }

    fn rows(t: &mut DeviceTracker, limit: i64, at: i64) -> Vec<(String, String, bool)> {
        t.list(1, limit, T0 + at)
            .into_iter()
            .map(|d| (d.device.info.player, d.device.info.channel, d.allowed))
            .collect()
    }

    #[test]
    fn second_stack_of_a_watching_device_shares_its_slot() {
        let mut t = DeviceTracker::new(60_000);
        let home = "89.235.208.216";
        let tv = stack(home, "samsung-agent/1.1", "Samsung TV", "Россия 1");
        assert!(t.admit(1, "tv", 2, tv.clone(), T0).allowed);
        let phone = stack(home, "OTT-play/1.6", "OTT Play", "Матч ТВ");
        assert!(t.admit(1, "phone", 2, phone, T0 + 1000).allowed);
        // The TV's app fetches the same channel itself, under another key.
        let app = stack(home, "OTT-play/1.6", "OTT Play", "Россия 1");
        let seen = t.admit(1, "tv-app", 2, app, T0 + 2000);
        assert_eq!((seen.allowed, seen.slot.as_str()), (true, "tv"));
        assert_eq!(
            rows(&mut t, 2, 3000),
            [
                ("Samsung TV".into(), "Россия 1".into(), true),
                ("OTT Play".into(), "Матч ТВ".into(), true),
            ]
        );
        // Another TV of the same kind on the same channel, a device at home
        // on another channel or one elsewhere: over the limit.
        assert!(!t.admit(1, "tv2", 2, tv, T0 + 4000).allowed);
        let kodi = stack(home, "Kodi/20", "Kodi", "Спорт");
        assert!(!t.admit(1, "tablet", 2, kodi, T0 + 4000).allowed);
        let away = stack("10.1.1.1", "OTT-play/1.6", "OTT Play", "Россия 1");
        assert!(!t.admit(1, "away", 2, away, T0 + 4000).allowed);
    }

    #[test]
    fn another_app_playing_alongside_is_another_device() {
        let home = "89.235.208.216";
        let tv = stack(home, "samsung-agent/1.1", "Samsung TV", "Россия 1");
        let app = stack(home, "OTT-play/1.6", "OTT Play", "Россия 1");
        let watching = playing(&tv, "aaaaaaaaaa");

        // The TV's app probes the channel and stops: one device.
        let mut t = DeviceTracker::new(60_000);
        assert!(t.admit(1, "tv", 1, tv.clone(), T0).allowed);
        assert!(t.admit(1, "tv-app", 1, app.clone(), T0 + 500).allowed);
        assert!(t.admit(1, "tv-app", 1, playing(&app, "pppppppppp"), T0 + 800).allowed);
        assert!(poll(&mut t, "tv", 1, &watching, 1000, 60_000).iter().all(|a| *a));
        assert_eq!(
            rows(&mut t, 1, 61_000),
            [("Samsung TV".into(), "Россия 1".into(), true)]
        );

        // A phone at home plays the same channel next to the TV: two.
        let mut t = DeviceTracker::new(60_000);
        assert!(t.admit(1, "tv", 1, tv, T0).allowed);
        assert!(poll(&mut t, "tv", 1, &watching, 1000, 20_000).iter().all(|a| *a));
        assert!(t.admit(1, "phone", 1, app.clone(), T0 + 21_000).allowed);
        let phone = playing(&app, "pppppppppp");
        let mut both = Vec::new();
        for at in (22_000..=47_000).step_by(5000) {
            both.push((
                t.admit(1, "tv", 1, watching.clone(), T0 + at - 1000).allowed,
                t.admit(1, "phone", 1, phone.clone(), T0 + at).allowed,
            ));
        }
        assert!(both.iter().all(|(a, _)| *a));
        assert_eq!(both.last(), Some(&(true, false)));
        assert_eq!(
            rows(&mut t, 1, 48_000),
            [
                ("Samsung TV".into(), "Россия 1".into(), true),
                ("OTT Play".into(), "Россия 1".into(), false),
            ]
        );
    }

    #[test]
    fn two_channels_on_one_key_are_two_devices() {
        // Identical TVs behind one router: one key.
        let mut t = DeviceTracker::new(60_000);
        let first = stack("88.196.217.142", "samsung-agent/1.1", "Samsung TV", "Россия 1");
        let second = DeviceInfo {
            channel: "НТВ".into(),
            ..first.clone()
        };
        assert!(poll(&mut t, "home", 1, &first, 0, 20_000).iter().all(|a| *a));
        // Could be a zap at first, so the second plays…
        assert!(t.admit(1, "home", 1, second.clone(), T0 + 21_000).allowed);
        assert_eq!(rows(&mut t, 1, 22_000).len(), 1);
        // …but the first keeps playing its channel: the second is a newcomer.
        let mut both = Vec::new();
        for at in (26_000..=46_000).step_by(5000) {
            both.push((
                t.admit(1, "home", 1, first.clone(), T0 + at - 1000).allowed,
                t.admit(1, "home", 1, second.clone(), T0 + at).allowed,
            ));
        }
        assert!(both.iter().all(|(a, _)| *a));
        assert_eq!(both.last(), Some(&(true, false)));
        assert_eq!(
            rows(&mut t, 1, 47_000),
            [
                ("Samsung TV".into(), "Россия 1".into(), true),
                ("Samsung TV".into(), "НТВ".into(), false),
            ]
        );
        assert_eq!(rows(&mut t, 2, 47_000).iter().filter(|r| r.2).count(), 2);
        // The first leaves: the second has the slot.
        assert_eq!(poll(&mut t, "home", 1, &second, 51_000, 120_000).last(), Some(&true));
        assert_eq!(rows(&mut t, 1, 121_000), [("Samsung TV".into(), "НТВ".into(), true)]);
    }

    fn playing(info: &DeviceInfo, play: &str) -> DeviceInfo {
        DeviceInfo {
            play: play.into(),
            ..info.clone()
        }
    }

    #[test]
    fn two_playbacks_of_one_channel_are_two_devices() {
        // Identical TVs on one key and one channel: only their playback links
        // differ.
        let mut t = DeviceTracker::new(60_000);
        let r1 = stack("88.196.217.142", "samsung-agent/1.1", "Samsung TV", "Россия 1");
        // Tune-in: the entry link (no play id), then its own variant link.
        assert!(t.admit(1, "home", 1, r1.clone(), T0).allowed);
        let first = playing(&r1, "aaaaaaaaaa");
        assert!(poll(&mut t, "home", 1, &first, 1000, 20_000).iter().all(|a| *a));
        // The second TV tunes in to the same channel.
        assert!(t.admit(1, "home", 1, r1, T0 + 21_000).allowed);
        let second = playing(&first, "bbbbbbbbbb");
        let mut both = Vec::new();
        for at in (22_000..=47_000).step_by(5000) {
            both.push((
                t.admit(1, "home", 1, first.clone(), T0 + at - 1000).allowed,
                t.admit(1, "home", 1, second.clone(), T0 + at).allowed,
            ));
        }
        assert!(both.iter().all(|(a, _)| *a));
        assert_eq!(both.first(), Some(&(true, true)), "could have been a re-tune");
        assert_eq!(both.last(), Some(&(true, false)));
        assert_eq!(
            rows(&mut t, 1, 48_000),
            [
                ("Samsung TV".into(), "Россия 1".into(), true),
                ("Samsung TV".into(), "Россия 1".into(), false),
            ]
        );
    }

    #[test]
    fn a_retune_stays_one_device() {
        let mut t = DeviceTracker::new(60_000);
        let r1 = stack("10.0.0.2", "samsung-agent/1.1", "Samsung TV", "Россия 1");
        assert!(
            poll(&mut t, "tv", 1, &playing(&r1, "aaaaaaaaaa"), 0, 20_000)
                .iter()
                .all(|a| *a)
        );
        // The player restarts the stream: a new playback, the old one stops.
        assert!(t.admit(1, "tv", 1, r1.clone(), T0 + 21_000).allowed);
        assert!(
            poll(&mut t, "tv", 1, &playing(&r1, "bbbbbbbbbb"), 22_000, 60_000)
                .iter()
                .all(|a| *a)
        );
        let listed = t.list(1, 1, T0 + 61_000);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].device.first_seen, T0);
        // Another device on the key is still told apart afterwards.
        let (now, other) = (playing(&r1, "bbbbbbbbbb"), playing(&r1, "cccccccccc"));
        let mut last = true;
        for at in (62_000..=82_000).step_by(5000) {
            assert!(t.admit(1, "tv", 1, now.clone(), T0 + at - 500).allowed);
            last = t.admit(1, "tv", 1, other.clone(), T0 + at).allowed;
        }
        assert!(!last);
    }

    #[test]
    fn a_zap_stays_one_device() {
        let mut t = DeviceTracker::new(60_000);
        let r1 = stack("10.0.0.2", "samsung-agent/1.1", "Samsung TV", "Россия 1");
        let ntv = DeviceInfo {
            channel: "НТВ".into(),
            ..r1.clone()
        };
        assert!(poll(&mut t, "tv", 1, &r1, 0, 20_000).iter().all(|a| *a));
        assert!(poll(&mut t, "tv", 1, &ntv, 21_000, 61_000).iter().all(|a| *a));
        assert!(poll(&mut t, "tv", 1, &r1, 62_000, 92_000).iter().all(|a| *a));
        let listed = t.list(1, 1, T0 + 93_000);
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (listed[0].device.info.channel.as_str(), listed[0].device.first_seen),
            ("Россия 1", T0)
        );
    }

    #[test]
    fn device_is_ip_plus_tag() {
        let tag = device_tag("TiviMate/5.0 (Android TV)");
        assert_eq!(tag, device_tag("TiviMate/5.0 (Android TV)"));
        assert!(crate::regex!(r"^[A-Za-z0-9_-]{10}$").is_match(&tag));
        assert_eq!(
            device_key("1.2.3.4", &tag, "okhttp/4.12"),
            device_key("1.2.3.4", &tag, "ExoPlayerLib/2.19")
        );
        assert_ne!(device_key("1.2.3.4", &tag, ""), device_key("5.6.7.8", &tag, ""));
        assert_ne!(device_key("1.2.3.4", "", "VLC"), device_key("1.2.3.4", "", "Kodi"));
    }
}
