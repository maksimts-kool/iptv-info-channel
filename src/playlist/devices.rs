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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Admission {
    pub allowed: bool,
    pub active: usize,
    pub limit: i64,
}

type Slots = HashMap<i64, HashMap<String, Device>>;

#[derive(Debug, Default)]
pub struct DeviceTracker {
    idle_ms: i64,
    users: Slots,
    refused: Slots,
    /// Devices playing a built-in loop: listed, but holding no slot.
    viewing: Slots,
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

    /// Ask for a slot. `limit` 0 = unlimited.
    pub fn admit(&mut self, user: i64, key: &str, limit: i64, info: DeviceInfo, now: i64) -> Admission {
        prune(&mut self.users, user, now, self.idle_ms);
        let active = self.users.get(&user).map_or(0, HashMap::len);

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
                };
            }
            if let Some(d) = devices.get_mut(key) {
                d.info = info;
                d.last_seen = now;
            }
            return Admission {
                allowed: true,
                active,
                limit,
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
                limit: 2
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
