//! One-time migration from the Node version's JSON files (`db.json` and
//! `catalog.json`) into PostgreSQL: `iptv-server import-json [data-dir]`.
//!
//! Everything goes in one transaction, so a failed import leaves the
//! database as it was. It refuses to run against a database that already
//! has customers or channels unless `--force`, which empties it first.

use std::path::Path;

use anyhow::{Context, bail};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::PgPool;

use super::jsonfile::{self, Loaded};
use super::model::{Incident, Newsletter, NotifyLogEntry, Payment, Plan, Subscriber, User};
use super::store::{Change, persist};
use crate::playlist::catalog::sql::persist_diff;
use crate::playlist::model::{CatalogData, ensure_builtins};

/// The `db.json` document as the Node version wrote it.
#[derive(Debug, Default, Deserialize)]
struct LegacyDb {
    #[serde(default)]
    plans: Vec<Plan>,
    #[serde(default)]
    users: Vec<User>,
    #[serde(default)]
    incidents: Vec<Incident>,
    #[serde(default)]
    subscribers: Vec<Subscriber>,
    #[serde(default)]
    notify_log: Vec<NotifyLogEntry>,
    #[serde(default)]
    payments: Vec<Payment>,
    #[serde(default)]
    newsletters: Vec<Newsletter>,
    #[serde(default)]
    settings: Map<String, Value>,
}

/// What an import moved.
#[derive(Debug, Default, serde::Serialize)]
pub struct ImportReport {
    pub plans: usize,
    pub users: usize,
    pub subscribers: usize,
    pub payments: usize,
    pub incidents: usize,
    pub newsletters: usize,
    pub sources: usize,
    pub categories: usize,
    pub channels: usize,
    pub overrides: usize,
    pub articles: usize,
    pub assets: usize,
    pub skipped: Vec<String>,
}

/// Settings `media_channel` ({ articles, assets }) -> typed rows. Documents
/// are re-sanitized, so anything the TV can't draw is dropped on the way in.
fn legacy_media(v: &Value) -> crate::media::store::MediaData {
    use crate::media::model::{Article, Asset};
    let list = |k: &str| v.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let articles = list("articles")
        .iter()
        .filter_map(|a| {
            let mut a = a.clone();
            let doc = crate::media::doc::sanitize_doc(a.get("doc")?).ok()?;
            a["doc"] = serde_json::to_value(doc).ok()?;
            serde_json::from_value::<Article>(a).ok()
        })
        .collect();
    let assets = list("assets")
        .into_iter()
        .filter_map(|a| serde_json::from_value::<Asset>(a).ok())
        .collect();
    crate::media::store::MediaData { articles, assets }
}

/// Subscribers that predate verification and the `content`/`news` topics are
/// grandfathered as on, exactly as the Node store did on load.
fn grandfather_subscribers(value: &mut Value) {
    let Some(subs) = value.get_mut("subscribers").and_then(Value::as_array_mut) else {
        return;
    };
    for s in subs.iter_mut().filter_map(Value::as_object_mut) {
        if !s.contains_key("verified") {
            s.insert("verified".into(), json!(true));
            s.insert("verify_token".into(), Value::Null);
        }
        if let Some(o) = s.get_mut("options").and_then(Value::as_object_mut) {
            o.entry("content").or_insert(json!(true));
            o.entry("news").or_insert(json!(true));
            o.insert("renewal".into(), json!(true));
        }
    }
}

fn is_date(s: &str) -> bool {
    crate::core::util::parse_ymd(s).is_some()
}

/// Drop a value a DATE column would reject, noting it.
fn clean_date(field: &mut Option<String>, what: &str, skipped: &mut Vec<String>) {
    if let Some(v) = field.as_deref()
        && !is_date(v)
    {
        if !v.is_empty() {
            skipped.push(format!("{what}: unparseable date {v:?} dropped"));
        }
        *field = None;
    }
}

fn read_json(path: &Path) -> anyhow::Result<Option<Value>> {
    match jsonfile::load::<Value>(path)? {
        Loaded::Existing(v) => Ok(Some(v)),
        Loaded::Missing => Ok(None),
        Loaded::Corrupt { backup, error } => bail!(
            "{} is not valid JSON ({error}); moved to {}",
            path.display(),
            backup.display()
        ),
    }
}

pub async fn import_json(
    pool: &PgPool,
    data_dir: &Path,
    force: bool,
    info_category_name: &str,
) -> anyhow::Result<ImportReport> {
    let db_value = read_json(&data_dir.join("db.json"))?;
    let catalog_value = read_json(&data_dir.join("catalog.json"))?;
    if db_value.is_none() && catalog_value.is_none() {
        bail!("neither db.json nor catalog.json found in {}", data_dir.display());
    }

    let mut db: LegacyDb = match db_value {
        Some(mut v) => {
            grandfather_subscribers(&mut v);
            serde_json::from_value(v).context("db.json has an unexpected shape")?
        }
        None => LegacyDb::default(),
    };
    let mut catalog: CatalogData = match catalog_value {
        Some(v) => serde_json::from_value(v).context("catalog.json has an unexpected shape")?,
        None => CatalogData::default(),
    };
    ensure_builtins(&mut catalog, info_category_name);
    for source in &mut catalog.sources {
        if source.last_sync_ms.is_none() {
            source.last_sync_ms = source
                .last_sync_at
                .as_deref()
                .and_then(crate::core::util::parse_instant)
                .map(jiff::Timestamp::as_millisecond);
        }
    }

    let mut tx = pool.begin().await?;
    let existing: i64 =
        sqlx::query_scalar("SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM channels WHERE NOT builtin)")
            .fetch_one(&mut *tx)
            .await?;
    if existing > 0 && !force {
        bail!("the database already has data; re-run with --force to replace it");
    }
    sqlx::query(
        "TRUNCATE settings, plans, users, incidents, subscribers, notify_log, payments, newsletters, sources, categories, channels, user_overrides, media_articles, media_assets RESTART IDENTITY CASCADE",
    )
    .execute(&mut *tx)
    .await?;

    let mut report = ImportReport::default();
    let user_ids: std::collections::HashSet<i64> = db.users.iter().map(|u| u.id).collect();

    // The media channel used to live in Settings `media_channel`; it has its
    // own tables now.
    let media = db
        .settings
        .remove("media_channel")
        .as_ref()
        .map(legacy_media)
        .unwrap_or_default();
    report.articles = media.articles.len();
    report.assets = media.assets.len();
    let mut changes: Vec<Change> = db
        .settings
        .iter()
        .map(|(k, v)| Change::Setting(k.clone(), v.clone()))
        .collect();
    for (index, mut plan) in db.plans.drain(..).enumerate() {
        if plan.sort == 0.0 {
            plan.sort = (index + 1) as f64;
        }
        plan.max_devices = plan.max_devices.max(0);
        if !["", "month", "year"].contains(&plan.billing_period.as_str()) {
            plan.billing_period.clear();
        }
        changes.push(Change::Plan(plan));
        report.plans += 1;
    }
    for mut user in db.users.drain(..) {
        clean_date(&mut user.expires_at, &format!("user {}", user.id), &mut report.skipped);
        if user.notify_token.is_empty() {
            user.notify_token = crate::core::util::make_token(16);
        }
        changes.push(Change::User(user));
        report.users += 1;
    }
    for mut sub in db.subscribers.drain(..) {
        if !user_ids.contains(&sub.user_id) {
            report
                .skipped
                .push(format!("subscriber of missing user {}", sub.user_id));
            continue;
        }
        clean_date(&mut sub.last_expiry_notice, "subscriber", &mut report.skipped);
        changes.push(Change::Subscriber(sub));
        report.subscribers += 1;
    }
    for mut inc in db.incidents.drain(..) {
        if inc.severity().is_none() {
            report
                .skipped
                .push(format!("incident {} with severity {:?}", inc.id, inc.severity));
            continue;
        }
        clean_date(&mut inc.starts_on, "incident", &mut report.skipped);
        clean_date(&mut inc.ends_on, "incident", &mut report.skipped);
        changes.push(Change::Incident(inc));
        report.incidents += 1;
    }
    changes.extend(db.notify_log.drain(..).map(Change::NotifyLog));
    for mut p in db.payments.drain(..) {
        clean_date(&mut p.previous_expires_at, "payment", &mut report.skipped);
        clean_date(&mut p.expires_at, "payment", &mut report.skipped);
        changes.push(Change::Payment(p));
        report.payments += 1;
    }
    for n in db.newsletters.drain(..) {
        changes.push(Change::Newsletter(n));
        report.newsletters += 1;
    }
    for change in &changes {
        persist(&mut tx, change).await?;
    }
    // New customers continue after the highest imported id.
    sqlx::query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM users), 1), (SELECT count(*) > 0 FROM users))")
        .execute(&mut *tx)
        .await?;

    // Catalog: drop rows the schema can't hold (a channel whose category is
    // gone, pins of deleted customers), then insert everything.
    let category_ids: std::collections::HashSet<String> = catalog.categories.iter().map(|c| c.id.clone()).collect();
    let source_ids: std::collections::HashSet<String> = catalog.sources.iter().map(|s| s.id.clone()).collect();
    let before = catalog.channels.len();
    catalog.channels.retain(|c| {
        category_ids.contains(&c.category_id) && c.source_id.as_ref().is_none_or(|s| source_ids.contains(s))
    });
    if catalog.channels.len() != before {
        report.skipped.push(format!(
            "{} channels without a category/source",
            before - catalog.channels.len()
        ));
    }
    catalog
        .overrides
        .retain(|k, _| k.parse::<i64>().is_ok_and(|id| user_ids.contains(&id)));
    report.sources = catalog.sources.len();
    report.categories = catalog.categories.len();
    report.channels = catalog.channels.len();
    report.overrides = catalog
        .overrides
        .values()
        .map(crate::playlist::model::UserOverrides::len)
        .sum();
    persist_diff(&mut tx, &CatalogData::default(), &catalog).await?;
    crate::media::store::persist_diff(&mut tx, &crate::media::store::MediaData::default(), &media).await?;

    tx.commit().await?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::db::testing::TestDb;
    use crate::data::store::Store;

    #[tokio::test]
    async fn imports_node_era_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("db.json"),
            r#"{"seq":7,"plans":[{"id":"p","name":"P","price_cents":100,"currency":"EUR","features":["x"]}],
               "users":[{"id":7,"username":"a","token":"t1","notify_token":"n1","plan_id":"p","expires_at":"2026-06-30","active":1,"created_at":"2026-01-01 10:00:00","updated_at":"2026-01-01 10:00:00"}],
               "subscribers":[{"user_id":7,"email":"a@b.c","options":{"server":true}},{"user_id":99,"email":"x@y.z","options":{}}],
               "payments":[{"id":"pay1","at":"2026-05-01T10:00:00.000Z","user_id":7,"count":1,"period":"month","expires_at":"2026-06-30","amount_cents":100}],
               "settings":{"brand_name":"B","gateway_enabled":true,"media_channel":{"articles":[{"id":"art1","title":"Т","doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]},{"type":"iframe"}]},"seconds":15,"scroll_speed":40,"audience":null,"created_at":"2026-05-01T10:00:00.000Z","updated_at":"2026-05-01T10:00:00.000Z"}],"assets":[{"id":"img111111","article_id":"art1","kind":"image","status":"ready","file":"img111111.jpg","width":10,"height":10,"created_at":"2026-05-01T10:00:00.000Z"}]}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("catalog.json"),
            r#"{"sources":[{"id":"s","name":"S","url":"http://x","last_sync_at":"2026-05-01 00:00:00"}],
                "categories":[{"id":"c","key":"спорт","name":"Спорт","enabled":true,"builtin":false,"sort":1}],
                "channels":[{"id":"ch","key":"s|id:a","source_id":"s","category_id":"c","name":"A","url":"http://a.m3u8","attrs":{"tvg-id":"a"}},
                            {"id":"orphan","key":"k","source_id":"s","category_id":"gone","name":"O","url":"u"}],
                "overrides":{"7":{"categories":{"c":false}},"99":{"channels":{"ch":true}}}}"#,
        )
        .unwrap();
        let t = TestDb::new().await;
        let report = import_json(&t.pool, dir.path(), false, "Информация").await.unwrap();
        assert_eq!(
            (report.users, report.subscribers, report.channels, report.overrides),
            (1, 1, 3, 1)
        );

        let store = Store::open(t.pool.clone()).await.unwrap();
        let u = store.user(7).unwrap();
        assert_eq!(
            (u.token.as_str(), u.plan_name.as_str(), u.expires_at.as_deref()),
            ("t1", "P", Some("2026-06-30"))
        );
        let s = store.subscriber(7).unwrap();
        assert!(s.verified && s.options.content && s.options.news);
        assert_eq!(store.plan("p").unwrap().extra["features"], json!(["x"]));
        assert_eq!(store.setting("gateway_enabled"), Some(json!(true)));
        assert_eq!(store.setting("media_channel"), None, "moved out of settings");
        assert_eq!((report.articles, report.assets), (1, 1));
        let dirs = crate::media::store::MediaDirs::new(&dir.path().join("media"), &dir.path().join("hls"));
        let media = crate::media::store::MediaStore::open(t.pool.clone(), dirs)
            .await
            .unwrap();
        assert_eq!(media.articles()[0].doc.children().len(), 1, "re-sanitized");
        assert_eq!(media.asset("img111111").unwrap().width, 10);
        assert_eq!(store.payments()[0].at, "2026-05-01T10:00:00.000Z");
        // The next customer gets an id after the imported ones.
        assert_eq!(
            store
                .create_user("b".into(), "p".into(), None, true, None)
                .await
                .unwrap()
                .id,
            8
        );

        // A second import needs --force.
        assert!(import_json(&t.pool, dir.path(), false, "Информация").await.is_err());
        assert!(import_json(&t.pool, dir.path(), true, "Информация").await.is_ok());
        t.drop().await;
    }
}
