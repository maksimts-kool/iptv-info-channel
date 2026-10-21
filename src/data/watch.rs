//! Viewing history in PostgreSQL (`watch_sessions`) and the statistics the
//! admin's Статистика page is built from.
//!
//! The recorder (`playlist::watch`) hands out changed rows; [`save`] upserts
//! them, [`prune`] applies the retention. [`summarize`] is pure: it clips the
//! watches to the requested window and splits each one across the local
//! hours and days it spans, so a programme watched over midnight counts on
//! both days.

use std::collections::{HashMap, HashSet};

use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};
use serde::Serialize;
use sqlx::{PgPool, Row};

use crate::core::util::iso;
use crate::playlist::watch::WatchRow;

/// How many of the latest watches the page lists.
pub const RECENT_MAX: usize = 100;

const HOUR_MS: i64 = 3_600_000;

/// Upsert changed watches in one statement. Rows of a customer deleted in the
/// meantime are skipped rather than failing the batch.
pub async fn save(pool: &PgPool, rows: &[WatchRow]) -> anyhow::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut ids = Vec::with_capacity(rows.len());
    let mut users = Vec::with_capacity(rows.len());
    let mut channel_ids = Vec::with_capacity(rows.len());
    let mut channel_names = Vec::with_capacity(rows.len());
    let mut players = Vec::with_capacity(rows.len());
    let mut ips = Vec::with_capacity(rows.len());
    let mut starts = Vec::with_capacity(rows.len());
    let mut ends = Vec::with_capacity(rows.len());
    for r in rows {
        ids.push(r.id.clone());
        users.push(r.user_id);
        channel_ids.push(r.channel_id.clone());
        channel_names.push(r.channel_name.clone());
        players.push(r.player.clone());
        ips.push(r.ip.clone());
        starts.push(r.started);
        ends.push(r.ended);
    }
    sqlx::query(
        "INSERT INTO watch_sessions (id, user_id, channel_id, channel_name, player, ip, started_at, ended_at)
         SELECT r.id, r.user_id, r.channel_id, r.channel_name, r.player, r.ip,
                to_timestamp(r.started / 1000.0), to_timestamp(r.ended / 1000.0)
         FROM UNNEST($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[], $8::bigint[])
              AS r (id, user_id, channel_id, channel_name, player, ip, started, ended)
         WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)
         ON CONFLICT (id) DO UPDATE SET ended_at = GREATEST(watch_sessions.ended_at, EXCLUDED.ended_at)",
    )
    .bind(ids)
    .bind(users)
    .bind(channel_ids)
    .bind(channel_names)
    .bind(players)
    .bind(ips)
    .bind(starts)
    .bind(ends)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete watches that ended before `before_ms`.
pub async fn prune(pool: &PgPool, before_ms: i64) -> anyhow::Result<u64> {
    let done = sqlx::query("DELETE FROM watch_sessions WHERE ended_at < to_timestamp($1 / 1000.0)")
        .bind(before_ms)
        .execute(pool)
        .await?;
    Ok(done.rows_affected())
}

/// Watches overlapping `[from_ms, to_ms)`, optionally of one customer.
pub async fn load(pool: &PgPool, from_ms: i64, to_ms: i64, user_id: Option<i64>) -> anyhow::Result<Vec<WatchRow>> {
    let rows = sqlx::query(
        "SELECT id, user_id, channel_id, channel_name, player, ip,
                (extract(epoch FROM started_at) * 1000)::bigint AS started,
                (extract(epoch FROM ended_at) * 1000)::bigint AS ended
         FROM watch_sessions
         WHERE ended_at > to_timestamp($1 / 1000.0) AND started_at < to_timestamp($2 / 1000.0)
           AND ($3::bigint IS NULL OR user_id = $3)",
    )
    .bind(from_ms)
    .bind(to_ms)
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(WatchRow {
                id: r.try_get("id")?,
                user_id: r.try_get("user_id")?,
                channel_id: r.try_get("channel_id")?,
                channel_name: r.try_get("channel_name")?,
                player: r.try_get("player")?,
                ip: r.try_get("ip")?,
                started: r.try_get("started")?,
                ended: r.try_get("ended")?,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Totals {
    pub seconds: i64,
    pub sessions: usize,
    pub viewers: usize,
    pub channels: usize,
    /// Most watches running at the same moment.
    pub peak: usize,
    pub peak_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Day {
    pub date: String,
    pub seconds: i64,
    pub sessions: usize,
    pub viewers: usize,
    pub peak: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UserShare {
    pub user_id: i64,
    pub username: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChannelShare {
    pub id: String,
    pub name: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChannelStat {
    pub id: String,
    pub name: String,
    pub seconds: i64,
    pub sessions: usize,
    pub viewers: usize,
    /// Who watched it, most first.
    pub users: Vec<UserShare>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CustomerStat {
    pub user_id: i64,
    pub username: String,
    pub seconds: i64,
    pub sessions: usize,
    pub last_seen: String,
    /// What they watched, most first.
    pub channels: Vec<ChannelShare>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Recent {
    pub id: String,
    pub user_id: i64,
    pub username: String,
    pub channel_id: String,
    pub channel: String,
    pub player: String,
    pub ip: String,
    pub started_at: String,
    pub ended_at: String,
    pub seconds: i64,
    pub live: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Summary {
    pub totals: Totals,
    pub daily: Vec<Day>,
    /// Seconds watched by local weekday (Monday first) x hour.
    pub heatmap: Vec<Vec<i64>>,
    pub channels: Vec<ChannelStat>,
    pub customers: Vec<CustomerStat>,
    pub recent: Vec<Recent>,
}

/// The window and the context the numbers are presented in.
#[derive(Debug)]
pub struct Window<'a> {
    pub from_ms: i64,
    pub to_ms: i64,
    pub tz: &'a TimeZone,
    pub usernames: &'a HashMap<i64, String>,
    /// Ids of the watches still in progress.
    pub live: &'a HashSet<String>,
}

fn secs(ms: i64) -> i64 {
    (ms + 500) / 1000
}

fn ts(ms: i64) -> Timestamp {
    Timestamp::from_millisecond(ms).unwrap_or(Timestamp::UNIX_EPOCH)
}

/// The end of the local hour `ms` falls in, its weekday (Monday = 0), hour
/// and date.
fn local_hour(ms: i64, tz: &TimeZone) -> (i64, usize, usize, jiff::civil::Date) {
    let z = ts(ms).to_zoned(tz.clone());
    let next = z
        .with()
        .minute(0)
        .second(0)
        .subsec_nanosecond(0)
        .build()
        .and_then(|h| h.checked_add(1.hour()))
        .map_or(ms - ms.rem_euclid(HOUR_MS) + HOUR_MS, |n| {
            n.timestamp().as_millisecond()
        });
    (
        next.max(ms + 1),
        z.weekday().to_monday_zero_offset() as usize,
        z.hour() as usize,
        z.date(),
    )
}

pub fn summarize(rows: &[WatchRow], w: &Window<'_>) -> Summary {
    let tz = w.tz;
    let name_of = |id: i64| w.usernames.get(&id).cloned().unwrap_or_else(|| format!("#{id}"));

    // The local days of the window, in order.
    let first = ts(w.from_ms).to_zoned(tz.clone()).date();
    let last = ts((w.to_ms - 1).max(w.from_ms)).to_zoned(tz.clone()).date();
    let mut dates = vec![first];
    while let Some(next) = dates.last().and_then(|d| d.tomorrow().ok()).filter(|d| *d <= last) {
        dates.push(next);
    }
    let day_index: HashMap<jiff::civil::Date, usize> = dates.iter().enumerate().map(|(i, d)| (*d, i)).collect();
    let mut day_ms = vec![0_i64; dates.len()];
    let mut day_sessions = vec![0_usize; dates.len()];
    let mut day_viewers: Vec<HashSet<i64>> = vec![HashSet::new(); dates.len()];
    let mut day_peak = vec![0_usize; dates.len()];
    let mut heatmap = vec![vec![0_i64; 24]; 7];

    // Latest name per channel: a rename shows under the current name.
    let mut channel_names: HashMap<&str, (i64, &str)> = HashMap::new();
    let mut pair_ms: HashMap<(i64, &str), i64> = HashMap::new();
    let mut channel_sessions: HashMap<&str, usize> = HashMap::new();
    let mut user_sessions: HashMap<i64, usize> = HashMap::new();
    let mut user_last: HashMap<i64, i64> = HashMap::new();
    let mut events: Vec<(i64, i32)> = Vec::new();
    let mut total_ms = 0;
    let mut kept: Vec<&WatchRow> = Vec::new();

    for r in rows {
        let (start, end) = (r.started.max(w.from_ms), r.ended.min(w.to_ms));
        if end <= start {
            continue;
        }
        kept.push(r);
        let name = channel_names
            .entry(&r.channel_id)
            .or_insert((r.started, &r.channel_name));
        if r.started >= name.0 && !r.channel_name.is_empty() {
            *name = (r.started, &r.channel_name);
        }
        *pair_ms.entry((r.user_id, &r.channel_id)).or_default() += end - start;
        *channel_sessions.entry(&r.channel_id).or_default() += 1;
        *user_sessions.entry(r.user_id).or_default() += 1;
        let last = user_last.entry(r.user_id).or_default();
        *last = (*last).max(r.ended);
        total_ms += end - start;
        events.push((start, 1));
        events.push((end, -1));

        let mut cursor = start;
        let mut first_piece = true;
        while cursor < end {
            let (hour_end, weekday, hour, date) = local_hour(cursor, tz);
            let piece_end = hour_end.min(end);
            heatmap[weekday][hour] += piece_end - cursor;
            if let Some(&d) = day_index.get(&date) {
                day_ms[d] += piece_end - cursor;
                day_viewers[d].insert(r.user_id);
                if first_piece {
                    day_sessions[d] += 1;
                }
            }
            first_piece = false;
            cursor = piece_end;
        }
    }

    // Concurrency: sweep the start/end events (ends first on a tie, so a
    // channel switch is not a moment with two watches). Each day starts with
    // whatever was still running at its midnight.
    events.sort_unstable();
    let mut boundaries: Vec<(i64, usize)> = dates
        .iter()
        .enumerate()
        .filter_map(|(i, d)| d.to_zoned(tz.clone()).ok().map(|z| (z.timestamp().as_millisecond(), i)))
        .collect();
    boundaries.reverse();
    let (mut running, mut peak, mut peak_at) = (0_usize, 0_usize, None);
    for (t, delta) in events {
        while boundaries.last().is_some_and(|(b, _)| *b <= t) {
            if let Some((_, i)) = boundaries.pop() {
                day_peak[i] = day_peak[i].max(running);
            }
        }
        if delta > 0 {
            running += 1;
            if running > peak {
                peak = running;
                peak_at = Some(t);
            }
            if let Some(&d) = day_index.get(&ts(t).to_zoned(tz.clone()).date()) {
                day_peak[d] = day_peak[d].max(running);
            }
        } else {
            running = running.saturating_sub(1);
        }
    }

    let channel_name = |id: &str| {
        channel_names
            .get(id)
            .map(|(_, n)| (*n).to_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| id.to_owned())
    };

    let mut channels: HashMap<&str, ChannelStat> = HashMap::new();
    let mut customers: HashMap<i64, CustomerStat> = HashMap::new();
    for (&(user_id, channel_id), &ms) in &pair_ms {
        let ch = channels.entry(channel_id).or_insert_with(|| ChannelStat {
            id: channel_id.to_owned(),
            name: channel_name(channel_id),
            seconds: 0,
            sessions: channel_sessions.get(channel_id).copied().unwrap_or(0),
            viewers: 0,
            users: Vec::new(),
        });
        ch.seconds += ms;
        ch.viewers += 1;
        ch.users.push(UserShare {
            user_id,
            username: name_of(user_id),
            seconds: secs(ms),
        });
        let cu = customers.entry(user_id).or_insert_with(|| CustomerStat {
            user_id,
            username: name_of(user_id),
            seconds: 0,
            sessions: user_sessions.get(&user_id).copied().unwrap_or(0),
            last_seen: iso(ts(user_last.get(&user_id).copied().unwrap_or(0))),
            channels: Vec::new(),
        });
        cu.seconds += ms;
        cu.channels.push(ChannelShare {
            id: channel_id.to_owned(),
            name: channel_name(channel_id),
            seconds: secs(ms),
        });
    }
    let mut channels: Vec<ChannelStat> = channels
        .into_values()
        .map(|mut c| {
            c.seconds = secs(c.seconds);
            c.users
                .sort_by(|a, b| b.seconds.cmp(&a.seconds).then(a.username.cmp(&b.username)));
            c
        })
        .collect();
    channels.sort_by(|a, b| b.seconds.cmp(&a.seconds).then(a.name.cmp(&b.name)));
    let mut customers: Vec<CustomerStat> = customers
        .into_values()
        .map(|mut c| {
            c.seconds = secs(c.seconds);
            c.channels
                .sort_by(|a, b| b.seconds.cmp(&a.seconds).then(a.name.cmp(&b.name)));
            c
        })
        .collect();
    customers.sort_by(|a, b| b.seconds.cmp(&a.seconds).then(a.username.cmp(&b.username)));

    kept.sort_by(|a, b| b.started.cmp(&a.started).then(a.id.cmp(&b.id)));
    let recent = kept
        .iter()
        .take(RECENT_MAX)
        .map(|r| Recent {
            id: r.id.clone(),
            user_id: r.user_id,
            username: name_of(r.user_id),
            channel_id: r.channel_id.clone(),
            channel: channel_name(&r.channel_id),
            player: r.player.clone(),
            ip: r.ip.clone(),
            started_at: iso(ts(r.started)),
            ended_at: iso(ts(r.ended)),
            seconds: secs(r.duration_ms()),
            live: w.live.contains(&r.id),
        })
        .collect();

    let daily = dates
        .iter()
        .enumerate()
        .map(|(i, d)| Day {
            date: d.to_string(),
            seconds: secs(day_ms[i]),
            sessions: day_sessions[i],
            viewers: day_viewers[i].len(),
            peak: day_peak[i],
        })
        .collect();

    Summary {
        totals: Totals {
            seconds: secs(total_ms),
            sessions: kept.len(),
            viewers: customers.len(),
            channels: channels.len(),
            peak,
            peak_at: peak_at.map(|t| iso(ts(t))),
        },
        daily,
        heatmap: heatmap.into_iter().map(|h| h.into_iter().map(secs).collect()).collect(),
        channels,
        customers,
        recent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::db::testing::TestDb;

    const MIN: i64 = 60_000;

    fn at(s: &str) -> i64 {
        s.parse::<Timestamp>().unwrap().as_millisecond()
    }

    fn row(id: &str, user_id: i64, channel: &str, started: i64, ended: i64) -> WatchRow {
        WatchRow {
            id: id.into(),
            user_id,
            channel_id: channel.into(),
            channel_name: format!("Канал {channel}"),
            player: "TiviMate".into(),
            ip: "10.0.0.2".into(),
            started,
            ended,
        }
    }

    fn summary(rows: &[WatchRow], from: i64, to: i64, tz: &TimeZone) -> Summary {
        let usernames = HashMap::from([(1, "anna".to_owned()), (2, "boris".to_owned())]);
        let live = HashSet::from(["c".to_owned()]);
        summarize(
            rows,
            &Window {
                from_ms: from,
                to_ms: to,
                tz,
                usernames: &usernames,
                live: &live,
            },
        )
    }

    #[test]
    fn totals_rankings_and_shares() {
        let tz = TimeZone::UTC;
        let t0 = at("2026-10-19T18:00:00Z");
        let rows = [
            row("a", 1, "s1", t0, t0 + 60 * MIN),
            row("b", 2, "s1", t0 + 30 * MIN, t0 + 45 * MIN),
            row("c", 2, "n1", t0 + 50 * MIN, t0 + 70 * MIN),
        ];
        let s = summary(&rows, at("2026-10-19T00:00:00Z"), at("2026-10-20T00:00:00Z"), &tz);
        assert_eq!(s.totals.seconds, 95 * 60);
        assert_eq!((s.totals.sessions, s.totals.viewers, s.totals.channels), (3, 2, 2));
        assert_eq!(s.totals.peak, 2);
        assert_eq!(s.totals.peak_at.as_deref(), Some("2026-10-19T18:30:00.000Z"));
        assert_eq!(s.channels[0].id, "s1");
        assert_eq!(s.channels[0].seconds, 75 * 60);
        assert_eq!(s.channels[0].viewers, 2);
        assert_eq!(s.channels[0].users[0].username, "anna");
        assert_eq!(s.customers[0].username, "anna");
        assert_eq!(s.customers[1].channels[0].name, "Канал n1");
        assert_eq!(s.recent[0].id, "c");
        assert!(s.recent[0].live && !s.recent[1].live);
        // Monday 18:00-19:00 and 19:00-19:10.
        assert_eq!(s.heatmap[0][18], 85 * 60);
        assert_eq!(s.heatmap[0][19], 10 * 60);
        assert_eq!(s.daily.len(), 1);
        assert_eq!(s.daily[0].viewers, 2);
    }

    #[test]
    fn watches_are_clipped_and_split_across_local_midnight() {
        let tz = TimeZone::get("Europe/Tallinn").unwrap();
        // 23:30-00:30 local (UTC+3 in October).
        let rows = [row(
            "a",
            1,
            "s1",
            at("2026-10-19T20:30:00Z"),
            at("2026-10-19T21:30:00Z"),
        )];
        let s = summary(&rows, at("2026-10-18T21:00:00Z"), at("2026-10-20T21:00:00Z"), &tz);
        let days: Vec<(&str, i64, usize)> = s.daily.iter().map(|d| (d.date.as_str(), d.seconds, d.peak)).collect();
        assert_eq!(days, [("2026-10-19", 30 * 60, 1), ("2026-10-20", 30 * 60, 1)]);
        assert_eq!(s.daily[0].sessions + s.daily[1].sessions, 1);
        assert_eq!(s.heatmap[0][23], 30 * 60);
        assert_eq!(s.heatmap[1][0], 30 * 60);
        // The window cuts the part before it off.
        let cut = summary(&rows, at("2026-10-19T21:00:00Z"), at("2026-10-20T21:00:00Z"), &tz);
        assert_eq!(cut.totals.seconds, 30 * 60);
        assert_eq!(cut.daily[0].peak, 1);
    }

    #[test]
    fn a_channel_switch_is_not_a_concurrent_peak() {
        let tz = TimeZone::UTC;
        let t0 = at("2026-10-19T10:00:00Z");
        let rows = [
            row("a", 1, "s1", t0, t0 + 10 * MIN),
            row("b", 1, "s2", t0 + 10 * MIN, t0 + 20 * MIN),
        ];
        let s = summary(&rows, at("2026-10-19T00:00:00Z"), at("2026-10-20T00:00:00Z"), &tz);
        assert_eq!(s.totals.peak, 1);
        assert_eq!(s.totals.viewers, 1);
    }

    #[tokio::test]
    async fn save_upserts_load_filters_and_prune_deletes() {
        let db = TestDb::new().await;
        let uid: i64 = sqlx::query_scalar(
            "INSERT INTO users (username, token, notify_token) VALUES ('anna', 't', 'n') RETURNING id",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        let t0 = at("2026-10-19T18:00:00Z");
        let mut a = row("a", uid, "s1", t0, t0 + 10 * MIN);
        // A deleted customer's row is skipped, not an error.
        save(&db.pool, &[a.clone(), row("x", uid + 1, "s1", t0, t0 + MIN)])
            .await
            .unwrap();
        a.ended = t0 + 20 * MIN;
        save(&db.pool, &[a.clone()]).await.unwrap();
        let loaded = load(&db.pool, t0, t0 + 60 * MIN, None).await.unwrap();
        assert_eq!(loaded, [a.clone()]);
        assert!(
            load(&db.pool, t0, t0 + 60 * MIN, Some(uid + 1))
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            load(&db.pool, t0 + 30 * MIN, t0 + 60 * MIN, None)
                .await
                .unwrap()
                .is_empty()
        );
        // An older end never shortens a stored watch.
        save(&db.pool, &[row("a", uid, "s1", t0, t0 + MIN)]).await.unwrap();
        assert_eq!(load(&db.pool, t0, t0 + 60 * MIN, None).await.unwrap()[0].ended, a.ended);
        assert_eq!(prune(&db.pool, t0 + 30 * MIN).await.unwrap(), 1);
        db.drop().await;
    }
}
