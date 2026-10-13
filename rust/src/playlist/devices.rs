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

    /// Devices watching now (oldest first, flagged with whether they are inside
    /// the limit), then the newcomers recently turned away.
    pub fn list(&mut self, user: i64, limit: i64, now: i64) -> Vec<ListedDevice> {
        prune(&mut self.users, user, now, self.idle_ms);
        prune(&mut self.refused, user, now, self.idle_ms);
        let empty = HashMap::new();
        let watching_map = self.users.get(&user).unwrap_or(&empty);
        let mut watching: Vec<&Device> = watching_map.values().collect();
        watching.sort_by_key(|d| d.first_seen);
        let mut out: Vec<ListedDevice> = watching
            .into_iter()
            .enumerate()
            .map(|(i, d)| ListedDevice {
                device: d.clone(),
                allowed: !(limit > 0 && i as i64 >= limit),
            })
            .collect();
        if let Some(refused) = self.refused.get(&user) {
            let mut away: Vec<&Device> = refused
                .iter()
                .filter(|(k, _)| !watching_map.contains_key(*k))
                .map(|(_, d)| d)
                .collect();
            away.sort_by_key(|d| d.first_seen);
            out.extend(away.into_iter().map(|d| ListedDevice {
                device: d.clone(),
                allowed: false,
            }));
        }
        out
    }

    pub fn count(&mut self, user: i64, now: i64) -> usize {
        prune(&mut self.users, user, now, self.idle_ms);
        self.users.get(&user).map_or(0, HashMap::len)
    }

    /// Drop every device of one customer (deleted account, rotated token).
    pub fn forget(&mut self, user: i64) {
        self.users.remove(&user);
        self.refused.remove(&user);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;

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
        assert_eq!(t.count(1, T0 + 5000), 1);
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
        assert_eq!(t.count(1, T0 + 3000), 1);
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
        assert_eq!(t.count(1, T0), 20);
        t.forget(1);
        assert_eq!(t.count(1, T0), 0);
        assert_eq!(t.count(2, T0), 1);
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
