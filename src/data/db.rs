//! The PostgreSQL connection pool and schema migrations.

use std::str::FromStr;
use std::time::Duration;

use anyhow::Context;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};

/// Embedded migrations (`migrations/`), applied on startup.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Connect and migrate. Sessions run in UTC so timestamps without a zone
/// (the store's `YYYY-MM-DD HH:MM:SS` stamps) mean UTC, as they always did.
pub async fn connect(url: &str) -> anyhow::Result<PgPool> {
    let opts = PgConnectOptions::from_str(url)
        .context("parsing DATABASE_URL")?
        .options([("timezone", "UTC")]);
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts)
        .await
        .context("connecting to PostgreSQL")?;
    MIGRATOR.run(&pool).await.context("running database migrations")?;
    Ok(pool)
}

#[cfg(test)]
pub mod testing {
    //! Each test gets its own throwaway schema in the database named by
    //! `TEST_DATABASE_URL` (default: the local dev container), so tests can
    //! run in parallel and leave nothing behind.

    use super::*;

    pub const DEFAULT_URL: &str = "postgres://iptv:iptv@127.0.0.1:55432/iptv";

    pub struct TestDb {
        pub pool: PgPool,
        schema: String,
        admin: PgPool,
    }

    impl TestDb {
        pub async fn new() -> Self {
            let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| DEFAULT_URL.to_owned());
            let admin = PgPool::connect(&url)
                .await
                .expect("test database reachable (see TEST_DATABASE_URL)");
            let schema = format!("t_{}", crate::core::util::make_token(12));
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
                .execute(&admin)
                .await
                .unwrap();
            let opts = PgConnectOptions::from_str(&url)
                .unwrap()
                .options([("timezone", "UTC"), ("search_path", schema.as_str())]);
            let pool = PgPoolOptions::new()
                .max_connections(4)
                .connect_with(opts)
                .await
                .unwrap();
            MIGRATOR.run(&pool).await.unwrap();
            Self { pool, schema, admin }
        }

        pub async fn drop(self) {
            self.pool.close().await;
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {} CASCADE", self.schema)))
                .execute(&self.admin)
                .await;
        }
    }
}
