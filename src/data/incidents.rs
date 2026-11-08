//! The problem register in PostgreSQL (`channel_incidents`), written by the
//! gateway's channel diagnostics (`playlist::diagnostics`).
//!
//! [`save`] upserts the incidents the tracker hands out; a channel leaves the
//! register when the tracker has shown it works, and [`resolve`] stamps its
//! rows and records the way out (`channel_resolutions`).

use std::collections::BTreeSet;

use sqlx::{PgConnection, PgPool, Row};

use crate::core::util::make_token;
use crate::playlist::diagnostics::{IncidentRow, Kind, Resolved, Verdict};

/// Upsert incidents in one transaction. A stored row only grows: its end and
/// peak never move back, and a cleared row stays cleared.
pub async fn save(pool: &PgPool, rows: &[IncidentRow]) -> anyhow::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    upsert(&mut tx, rows).await?;
    tx.commit().await?;
    Ok(())
}

async fn upsert(conn: &mut PgConnection, rows: &[IncidentRow]) -> anyhow::Result<()> {
    for r in rows {
        sqlx::query(
            "INSERT INTO channel_incidents (id, channel_id, channel_name, kind, detail, peak, user_ids, started_at, ended_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0))
             ON CONFLICT (id) DO UPDATE SET
                 channel_name = EXCLUDED.channel_name,
                 detail = EXCLUDED.detail,
                 peak = GREATEST(channel_incidents.peak, EXCLUDED.peak),
                 user_ids = ARRAY(SELECT DISTINCT u FROM unnest(channel_incidents.user_ids || EXCLUDED.user_ids) AS u ORDER BY u),
                 ended_at = GREATEST(channel_incidents.ended_at, EXCLUDED.ended_at)",
        )
        .bind(&r.id)
        .bind(&r.channel_id)
        .bind(&r.channel_name)
        .bind(r.kind.as_str())
        .bind(&r.detail)
        .bind(r.peak)
        .bind(&r.users)
        .bind(r.started)
        .bind(r.ended)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// The register: every incident not cleared, optionally of one channel.
pub async fn load_open(pool: &PgPool, channel_id: Option<&str>) -> anyhow::Result<Vec<IncidentRow>> {
    let rows = sqlx::query(
        "SELECT id, channel_id, channel_name, kind, detail, peak, user_ids,
                (extract(epoch FROM started_at) * 1000)::bigint AS started,
                (extract(epoch FROM ended_at) * 1000)::bigint AS ended
         FROM channel_incidents
         WHERE cleared_at IS NULL AND ($1::text IS NULL OR channel_id = $1)",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let kind: String = r.try_get("kind")?;
        // A kind this version no longer knows is skipped, not an error.
        let Some(kind) = Kind::parse(&kind) else {
            continue;
        };
        out.push(IncidentRow {
            id: r.try_get("id")?,
            channel_id: r.try_get("channel_id")?,
            channel_name: r.try_get("channel_name")?,
            kind,
            detail: r.try_get("detail")?,
            peak: r.try_get("peak")?,
            users: r.try_get("user_ids")?,
            started: r.try_get("started")?,
            ended: r.try_get("ended")?,
        });
    }
    Ok(out)
}

/// Channels the register lists, for the menu badge at startup.
pub async fn problem_channels(pool: &PgPool) -> anyhow::Result<BTreeSet<String>> {
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT channel_id FROM channel_incidents WHERE cleared_at IS NULL")
            .fetch_all(pool)
            .await?;
    Ok(ids.into_iter().collect())
}

/// One channel's way out of the register, as recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolutionRow {
    pub id: String,
    pub channel_id: String,
    pub channel_name: String,
    /// What it had.
    pub kinds: Vec<Kind>,
    pub incidents: i64,
    /// Customers who had it.
    pub users: Vec<i64>,
    /// Epoch ms: the first incident's start, the last one's end, the way out.
    pub first: i64,
    pub last: i64,
    pub resolved: i64,
    pub how: Resolved,
    /// What showed it works: checks passed, viewing without trouble (ms)
    /// and by how many customers.
    pub probes: i32,
    pub viewing_ms: i64,
    pub viewers: i32,
}

/// Take a channel out of the register at `at` (epoch ms), in one
/// transaction: `unsaved` (the tracker's rows of it not stored yet) go in
/// first, every incident of it that started by `at` is stamped, and the way
/// out is recorded. `None` when the register had nothing of it.
pub async fn resolve(
    pool: &PgPool,
    verdict: &Verdict,
    at: i64,
    unsaved: &[IncidentRow],
) -> anyhow::Result<Option<ResolutionRow>> {
    let mut tx = pool.begin().await?;
    upsert(&mut tx, unsaved).await?;
    let rows = sqlx::query(
        "UPDATE channel_incidents SET cleared_at = to_timestamp($2 / 1000.0)
         WHERE channel_id = $1 AND cleared_at IS NULL AND started_at <= to_timestamp($2 / 1000.0)
         RETURNING channel_name, kind, user_ids,
                   (extract(epoch FROM started_at) * 1000)::bigint AS started,
                   (extract(epoch FROM ended_at) * 1000)::bigint AS ended",
    )
    .bind(&verdict.channel_id)
    .bind(at)
    .fetch_all(&mut *tx)
    .await?;
    if rows.is_empty() {
        tx.commit().await?;
        return Ok(None);
    }
    let mut kinds = BTreeSet::new();
    let mut users = BTreeSet::new();
    let (mut first, mut last) = (i64::MAX, i64::MIN);
    let mut channel_name = String::new();
    for r in &rows {
        if let Some(kind) = Kind::parse(&r.try_get::<String, _>("kind")?) {
            kinds.insert(kind);
        }
        users.extend(r.try_get::<Vec<i64>, _>("user_ids")?);
        first = first.min(r.try_get("started")?);
        let ended: i64 = r.try_get("ended")?;
        if ended >= last {
            last = ended;
            channel_name = r.try_get("channel_name")?;
        }
    }
    let row = ResolutionRow {
        id: make_token(16),
        channel_id: verdict.channel_id.clone(),
        channel_name,
        kinds: kinds.into_iter().collect(),
        incidents: rows.len() as i64,
        users: users.into_iter().collect(),
        first,
        last,
        resolved: at,
        how: verdict.how,
        probes: i32::try_from(verdict.probes).unwrap_or(i32::MAX),
        viewing_ms: verdict.viewing_ms,
        viewers: i32::try_from(verdict.viewers).unwrap_or(i32::MAX),
    };
    let kind_names: Vec<&str> = row.kinds.iter().map(|k| k.as_str()).collect();
    sqlx::query(
        "INSERT INTO channel_resolutions
             (id, channel_id, channel_name, kinds, incidents, user_ids, first_at, last_at, resolved_at, how, probes, viewing_ms, viewers)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0),
                 $10, $11, $12, $13)",
    )
    .bind(&row.id)
    .bind(&row.channel_id)
    .bind(&row.channel_name)
    .bind(&kind_names)
    .bind(row.incidents)
    .bind(&row.users)
    .bind(row.first)
    .bind(row.last)
    .bind(row.resolved)
    .bind(row.how.as_str())
    .bind(row.probes)
    .bind(row.viewing_ms)
    .bind(row.viewers)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(row))
}

/// Ways out since `since_ms`, newest first, optionally of one channel.
pub async fn resolutions(
    pool: &PgPool,
    since_ms: i64,
    channel_id: Option<&str>,
    limit: i64,
) -> anyhow::Result<Vec<ResolutionRow>> {
    let rows = sqlx::query(
        "SELECT id, channel_id, channel_name, kinds, incidents, user_ids, how, probes, viewing_ms, viewers,
                (extract(epoch FROM first_at) * 1000)::bigint AS first,
                (extract(epoch FROM last_at) * 1000)::bigint AS last,
                (extract(epoch FROM resolved_at) * 1000)::bigint AS resolved
         FROM channel_resolutions
         WHERE resolved_at >= to_timestamp($1 / 1000.0) AND ($2::text IS NULL OR channel_id = $2)
         ORDER BY resolved_at DESC
         LIMIT $3",
    )
    .bind(since_ms)
    .bind(channel_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let Some(how) = Resolved::parse(&r.try_get::<String, _>("how")?) else {
            continue;
        };
        let kinds: Vec<String> = r.try_get("kinds")?;
        out.push(ResolutionRow {
            id: r.try_get("id")?,
            channel_id: r.try_get("channel_id")?,
            channel_name: r.try_get("channel_name")?,
            kinds: kinds.iter().filter_map(|k| Kind::parse(k)).collect(),
            incidents: r.try_get("incidents")?,
            users: r.try_get("user_ids")?,
            first: r.try_get("first")?,
            last: r.try_get("last")?,
            resolved: r.try_get("resolved")?,
            how,
            probes: r.try_get("probes")?,
            viewing_ms: r.try_get("viewing_ms")?,
            viewers: r.try_get("viewers")?,
        });
    }
    Ok(out)
}

/// Delete incidents cleared, and ways out recorded, before `before_ms`. The
/// register itself is kept until its channels are shown to work.
pub async fn prune(pool: &PgPool, before_ms: i64) -> anyhow::Result<u64> {
    let mut tx = pool.begin().await?;
    let incidents = sqlx::query("DELETE FROM channel_incidents WHERE cleared_at < to_timestamp($1 / 1000.0)")
        .bind(before_ms)
        .execute(&mut *tx)
        .await?;
    let resolutions = sqlx::query("DELETE FROM channel_resolutions WHERE resolved_at < to_timestamp($1 / 1000.0)")
        .bind(before_ms)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(incidents.rows_affected() + resolutions.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::db::testing::TestDb;

    const T0: i64 = 1_760_000_000_000;

    fn incident(id: &str, channel: &str, kind: Kind, started: i64, ended: i64) -> IncidentRow {
        IncidentRow {
            id: id.into(),
            channel_id: channel.into(),
            channel_name: "НТВ".into(),
            kind,
            detail: "502".into(),
            peak: 3,
            users: vec![1, 2],
            started,
            ended,
        }
    }

    #[tokio::test]
    async fn save_resolve_and_prune() {
        let db = TestDb::new().await;
        let mut a = incident("a", "ntv", Kind::Errors, T0, T0 + 60_000);
        let b = incident("b", "sts", Kind::Frozen, T0, T0 + 30_000);
        save(&db.pool, &[a.clone(), b.clone()]).await.unwrap();
        // It grows; an older copy never shrinks it.
        a.ended = T0 + 120_000;
        a.peak = 7;
        a.users = vec![1, 2, 3];
        save(&db.pool, &[a.clone()]).await.unwrap();
        save(&db.pool, &[incident("a", "ntv", Kind::Errors, T0, T0 + 1_000)])
            .await
            .unwrap();
        assert_eq!(load_open(&db.pool, Some("ntv")).await.unwrap(), [a.clone()]);
        assert_eq!(load_open(&db.pool, None).await.unwrap().len(), 2);
        assert_eq!(
            problem_channels(&db.pool)
                .await
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            ["ntv", "sts"]
        );

        // Shown to work: gone from the register, recorded; a later flush of
        // it stays cleared.
        let at = T0 + 200_000;
        let verdict = |channel: &str| Verdict {
            channel_id: channel.into(),
            how: Resolved::Verified,
            probes: 3,
            viewing_ms: 900_000,
            viewers: 2,
        };
        // A row the tracker had not stored yet goes in with it; one that
        // started after the way out stays.
        let unsaved = incident("u", "ntv", Kind::Slow, T0 + 150_000, T0 + 160_000);
        let later = incident("l", "ntv", Kind::Errors, at + 1, at + 2);
        save(&db.pool, &[later.clone()]).await.unwrap();
        let res = resolve(&db.pool, &verdict("ntv"), at, &[unsaved])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(res.kinds, [Kind::Errors, Kind::Slow]);
        assert_eq!(res.incidents, 2);
        assert_eq!(res.users, [1, 2, 3]);
        assert_eq!((res.first, res.last, res.resolved), (T0, T0 + 160_000, at));
        save(&db.pool, &[a.clone()]).await.unwrap();
        assert_eq!(load_open(&db.pool, Some("ntv")).await.unwrap(), [later]);
        assert_eq!(resolutions(&db.pool, T0, None, 10).await.unwrap(), [res.clone()]);
        assert!(resolutions(&db.pool, at + 1, None, 10).await.unwrap().is_empty());
        // Nothing left of it: nothing recorded.
        assert!(resolve(&db.pool, &verdict("ntv"), at, &[]).await.unwrap().is_none());

        assert!(resolve(&db.pool, &verdict("sts"), at, &[]).await.unwrap().is_some());
        assert_eq!(prune(&db.pool, at - 1).await.unwrap(), 0);
        // Three cleared incidents and two recorded ways out.
        assert_eq!(prune(&db.pool, at + 1).await.unwrap(), 5);
        assert_eq!(load_open(&db.pool, None).await.unwrap().len(), 1);
        db.drop().await;
    }
}
