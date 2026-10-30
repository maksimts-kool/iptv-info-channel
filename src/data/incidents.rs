//! The problem register in PostgreSQL (`channel_incidents`), written by the
//! gateway's channel diagnostics (`playlist::diagnostics`).
//!
//! [`save`] upserts the incidents the tracker hands out; a channel leaves the
//! register when [`clear`] stamps its rows, and [`restore`] undoes exactly
//! that stamp.

use std::collections::BTreeSet;

use sqlx::{PgPool, Row};

use crate::playlist::diagnostics::{IncidentRow, Kind};

/// Upsert incidents in one transaction. A stored row only grows: its end and
/// peak never move back, and a cleared row stays cleared.
pub async fn save(pool: &PgPool, rows: &[IncidentRow]) -> anyhow::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
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
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
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

/// Mark a channel fixed at `at` (epoch ms): its incidents leave the register.
/// Returns how many there were.
pub async fn clear(pool: &PgPool, channel_id: &str, at: i64) -> anyhow::Result<u64> {
    let done = sqlx::query(
        "UPDATE channel_incidents SET cleared_at = to_timestamp($2 / 1000.0)
         WHERE channel_id = $1 AND cleared_at IS NULL",
    )
    .bind(channel_id)
    .bind(at)
    .execute(pool)
    .await?;
    Ok(done.rows_affected())
}

/// Undo [`clear`]: put back exactly the incidents that call stamped.
pub async fn restore(pool: &PgPool, channel_id: &str, at: i64) -> anyhow::Result<u64> {
    let done = sqlx::query(
        "UPDATE channel_incidents SET cleared_at = NULL
         WHERE channel_id = $1 AND cleared_at = to_timestamp($2 / 1000.0)",
    )
    .bind(channel_id)
    .bind(at)
    .execute(pool)
    .await?;
    Ok(done.rows_affected())
}

/// Delete incidents cleared before `before_ms`. The register itself is kept
/// until the admin clears it.
pub async fn prune(pool: &PgPool, before_ms: i64) -> anyhow::Result<u64> {
    let done = sqlx::query("DELETE FROM channel_incidents WHERE cleared_at < to_timestamp($1 / 1000.0)")
        .bind(before_ms)
        .execute(pool)
        .await?;
    Ok(done.rows_affected())
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
    async fn save_clear_restore_and_prune() {
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

        // Fixed: gone from the register; a later flush of it stays cleared.
        let at = T0 + 200_000;
        assert_eq!(clear(&db.pool, "ntv", at).await.unwrap(), 1);
        save(&db.pool, &[a.clone()]).await.unwrap();
        assert!(load_open(&db.pool, Some("ntv")).await.unwrap().is_empty());
        // A new incident after the fix is listed on its own.
        save(&db.pool, &[incident("c", "ntv", Kind::Errors, at + 1, at + 2)])
            .await
            .unwrap();
        assert_eq!(load_open(&db.pool, Some("ntv")).await.unwrap().len(), 1);
        // Undo puts back exactly what that fix cleared.
        assert_eq!(restore(&db.pool, "ntv", at + 5).await.unwrap(), 0);
        assert_eq!(restore(&db.pool, "ntv", at).await.unwrap(), 1);
        assert_eq!(load_open(&db.pool, Some("ntv")).await.unwrap().len(), 2);

        assert_eq!(clear(&db.pool, "sts", at).await.unwrap(), 1);
        assert_eq!(prune(&db.pool, at - 1).await.unwrap(), 0);
        assert_eq!(prune(&db.pool, at + 1).await.unwrap(), 1);
        assert_eq!(load_open(&db.pool, None).await.unwrap().len(), 2);
        db.drop().await;
    }
}
