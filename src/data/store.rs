//! The application store: plans, users, incidents, subscribers, payments,
//! newsletters and settings, persisted in PostgreSQL.
//!
//! PostgreSQL is the source of truth; an in-memory copy serves reads, so the
//! hot paths (the playlist and the stream gateway's per-request checks) never
//! wait on a round trip. This is sound because the server is a single
//! instance and every write goes through here:
//!
//! 1. take the async write lock (writes are serialized),
//! 2. apply the change to a COPY of the cached state, collecting the row
//!    changes it implies,
//! 3. persist those rows in one transaction,
//! 4. only then swap the copy in — a failed write leaves memory untouched.

use std::collections::HashMap;
use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard};

use anyhow::Context;
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use tokio::sync::Mutex as AsyncMutex;
use unicode_normalization::UnicodeNormalization;

use super::model::{
    DecoratedUser, Incident, Newsletter, NotifyLogEntry, NotifyOptions, Payment, Plan, Subscriber, User,
};
use crate::core::audience::Audience;
use crate::core::util::{iso_now, locale_cmp, make_token, now_stamp};

const NOTIFY_LOG_MAX: usize = 100;
const PAYMENTS_MAX: usize = 5000;
const NEWSLETTERS_MAX: usize = 200;

/// The cached state.
#[derive(Debug, Clone, Default)]
pub struct Db {
    pub plans: Vec<Plan>,
    pub users: Vec<User>,
    pub incidents: Vec<Incident>,
    pub subscribers: Vec<Subscriber>,
    /// Oldest first.
    pub notify_log: Vec<NotifyLogEntry>,
    /// Oldest first.
    pub payments: Vec<Payment>,
    /// Oldest first.
    pub newsletters: Vec<Newsletter>,
    pub settings: Map<String, Value>,
}

impl Db {
    fn plan(&self, id: &str) -> Option<&Plan> {
        self.plans.iter().find(|p| p.id == id)
    }

    fn decorate(&self, user: &User) -> DecoratedUser {
        DecoratedUser::decorate(user.clone(), self.plan(&user.plan_id))
    }

    pub fn brand_name(&self) -> String {
        setting_str(&self.settings, "brand_name")
            .unwrap_or("Мой IPTV-сервис")
            .to_owned()
    }
}

pub fn setting_str<'a>(settings: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    settings.get(key).and_then(Value::as_str)
}

/// One row-level change to persist.
#[derive(Debug, Clone)]
pub enum Change {
    Setting(String, Value),
    Plan(Plan),
    DeletePlan(String),
    User(User),
    DeleteUser(i64),
    Subscriber(Subscriber),
    DeleteSubscriber(i64),
    NotifyLog(NotifyLogEntry),
    Payment(Payment),
    DeletePayment(String),
    Newsletter(Newsletter),
    DeleteNewsletter(String),
    Incident(Incident),
    DeleteIncident(String),
}

/// Fields a user edit may change; `None` leaves a field alone.
#[derive(Debug, Clone, Default)]
pub struct UserPatch {
    pub username: Option<String>,
    pub plan_id: Option<String>,
    /// `Some(None)` clears the expiry.
    pub expires_at: Option<Option<String>>,
    pub active: Option<bool>,
    /// `Some(None)` clears the personal device cap.
    pub max_devices: Option<Option<i64>>,
}

#[derive(Debug, Clone, Default)]
pub struct PlanPatch {
    pub name: Option<String>,
    pub price_cents: Option<i64>,
    pub currency: Option<String>,
    pub billing_period: Option<String>,
    pub sort: Option<f64>,
    pub max_devices: Option<i64>,
    pub category_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct NewPlan {
    pub name: String,
    pub price_cents: i64,
    pub currency: String,
    pub billing_period: String,
    pub category_ids: Vec<String>,
    pub max_devices: i64,
}

#[derive(Debug, Clone, Default)]
pub struct IncidentFields {
    pub title: Option<String>,
    pub severity: Option<String>,
    pub starts_on: Option<Option<String>>,
    pub ends_on: Option<Option<String>>,
    pub note: Option<String>,
}

/// De-duplicated, trimmed category ids.
pub fn clean_category_ids(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if !out.iter().any(|x| x == id) {
            out.push(id.to_owned());
        }
    }
    out
}

fn slug(name: &str) -> String {
    let folded: String = name
        .nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(36).collect();
    if trimmed.is_empty() { "plan".to_owned() } else { trimmed }
}

fn default_plans() -> Vec<Plan> {
    let plan = |id: &str, name: &str, price, sort| Plan {
        id: id.into(),
        name: name.into(),
        price_cents: price,
        currency: "EUR".into(),
        billing_period: String::new(),
        sort,
        category_ids: Vec::new(),
        max_devices: 0,
        extra: Map::new(),
    };
    vec![plan("standard", "Стандарт", 499, 1.0), plan("pro", "Про", 699, 2.0)]
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/// TIMESTAMPTZ -> the store's `YYYY-MM-DD HH:MM:SS` UTC stamp.
macro_rules! stamp {
    ($col:literal) => {
        concat!("to_char(", $col, " AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')")
    };
}
/// TIMESTAMPTZ -> JS `toISOString()` shape.
macro_rules! iso {
    ($col:literal) => {
        concat!(
            "to_char(",
            $col,
            r#" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')"#
        )
    };
}

fn json_obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

async fn load(pool: &PgPool) -> anyhow::Result<Db> {
    let mut db = Db::default();
    for row in sqlx::query("SELECT key, value FROM settings").fetch_all(pool).await? {
        db.settings.insert(row.try_get("key")?, row.try_get("value")?);
    }
    for r in sqlx::query(
        "SELECT id, name, price_cents, currency, billing_period, sort, category_ids, max_devices, extra FROM plans",
    )
    .fetch_all(pool)
    .await?
    {
        db.plans.push(Plan {
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            price_cents: r.try_get("price_cents")?,
            currency: r.try_get("currency")?,
            billing_period: r.try_get("billing_period")?,
            sort: r.try_get("sort")?,
            category_ids: r.try_get("category_ids")?,
            max_devices: r.try_get("max_devices")?,
            extra: json_obj(r.try_get("extra")?),
        });
    }
    let users_sql = concat!(
        "SELECT id, username, token, notify_token, plan_id, expires_at::text AS expires_at, active, max_devices, ",
        stamp!("created_at"),
        " AS created_at, ",
        stamp!("updated_at"),
        " AS updated_at, extra FROM users ORDER BY id"
    );
    for r in sqlx::query(users_sql).fetch_all(pool).await? {
        db.users.push(User {
            id: r.try_get("id")?,
            username: r.try_get("username")?,
            token: r.try_get("token")?,
            notify_token: r.try_get("notify_token")?,
            plan_id: r.try_get("plan_id")?,
            expires_at: r.try_get("expires_at")?,
            active: r.try_get("active")?,
            max_devices: r.try_get("max_devices")?,
            created_at: r.try_get("created_at")?,
            updated_at: r.try_get("updated_at")?,
            extra: json_obj(r.try_get("extra")?),
        });
    }
    let inc_sql = concat!(
        "SELECT id, title, severity, starts_on::text AS starts_on, ends_on::text AS ends_on, note, ",
        stamp!("created_at"),
        " AS created_at, ",
        stamp!("updated_at"),
        " AS updated_at FROM incidents"
    );
    for r in sqlx::query(inc_sql).fetch_all(pool).await? {
        db.incidents.push(Incident {
            id: r.try_get("id")?,
            title: r.try_get("title")?,
            severity: r.try_get("severity")?,
            starts_on: r.try_get("starts_on")?,
            ends_on: r.try_get("ends_on")?,
            note: r.try_get("note")?,
            created_at: r.try_get("created_at")?,
            updated_at: r.try_get("updated_at")?,
        });
    }
    let sub_sql = concat!(
        "SELECT user_id, email, options, verified, verify_token, ",
        stamp!("created_at"),
        " AS created_at, ",
        stamp!("updated_at"),
        " AS updated_at, last_expiry_notice::text AS last_expiry_notice FROM subscribers ORDER BY user_id"
    );
    for r in sqlx::query(sub_sql).fetch_all(pool).await? {
        db.subscribers.push(Subscriber {
            user_id: r.try_get("user_id")?,
            email: r.try_get("email")?,
            options: serde_json::from_value(r.try_get("options")?).unwrap_or_default(),
            verified: r.try_get("verified")?,
            verify_token: r.try_get("verify_token")?,
            created_at: r.try_get("created_at")?,
            updated_at: r.try_get("updated_at")?,
            last_expiry_notice: r.try_get("last_expiry_notice")?,
        });
    }
    let log_sql = concat!(
        "SELECT ",
        stamp!("at"),
        " AS at, user_id, email, kind, ok, error FROM notify_log ORDER BY id"
    );
    for r in sqlx::query(log_sql).fetch_all(pool).await? {
        db.notify_log.push(NotifyLogEntry {
            at: r.try_get("at")?,
            user_id: r.try_get("user_id")?,
            email: r.try_get("email")?,
            kind: r.try_get("kind")?,
            ok: r.try_get("ok")?,
            error: r.try_get("error")?,
        });
    }
    let pay_sql = concat!(
        "SELECT id, ",
        iso!("at"),
        " AS at, user_id, username, plan_id, plan_name, count, period, \"from\", ",
        "previous_expires_at::text AS previous_expires_at, expires_at::text AS expires_at, amount_cents, currency, note ",
        "FROM payments ORDER BY seq"
    );
    for r in sqlx::query(pay_sql).fetch_all(pool).await? {
        db.payments.push(Payment {
            id: r.try_get("id")?,
            at: r.try_get("at")?,
            user_id: r.try_get("user_id")?,
            username: r.try_get("username")?,
            plan_id: r.try_get("plan_id")?,
            plan_name: r.try_get("plan_name")?,
            count: r.try_get("count")?,
            period: r.try_get("period")?,
            from: r.try_get("from")?,
            previous_expires_at: r.try_get("previous_expires_at")?,
            expires_at: r.try_get("expires_at")?,
            amount_cents: r.try_get("amount_cents")?,
            currency: r.try_get("currency")?,
            note: r.try_get("note")?,
        });
    }
    let nl_sql = concat!(
        "SELECT id, ",
        iso!("created_at"),
        " AS created_at, subject, body, important, audience, status, recipients, sent, failed, error, ",
        iso!("sent_at"),
        " AS sent_at FROM newsletters ORDER BY seq"
    );
    for r in sqlx::query(nl_sql).fetch_all(pool).await? {
        let audience: Option<Value> = r.try_get("audience")?;
        db.newsletters.push(Newsletter {
            id: r.try_get("id")?,
            created_at: r.try_get("created_at")?,
            subject: r.try_get("subject")?,
            body: r.try_get("body")?,
            important: r.try_get("important")?,
            audience: audience.and_then(|a| serde_json::from_value::<Audience>(a).ok()),
            status: r.try_get("status")?,
            recipients: usize::try_from(r.try_get::<i64, _>("recipients")?).unwrap_or(0),
            sent: usize::try_from(r.try_get::<i64, _>("sent")?).unwrap_or(0),
            failed: usize::try_from(r.try_get::<i64, _>("failed")?).unwrap_or(0),
            error: r.try_get("error")?,
            sent_at: r.try_get("sent_at")?,
        });
    }
    Ok(db)
}

fn opt_str(v: &str) -> Option<&str> {
    (!v.is_empty()).then_some(v)
}

pub(crate) async fn persist(tx: &mut Transaction<'_, Postgres>, change: &Change) -> sqlx::Result<()> {
    match change {
        Change::Setting(key, value) => {
            sqlx::query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
                .bind(key)
                .bind(value)
                .execute(&mut **tx)
                .await?;
        }
        Change::Plan(p) => {
            sqlx::query(
                "INSERT INTO plans (id, name, price_cents, currency, billing_period, sort, category_ids, max_devices, extra)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, price_cents=EXCLUDED.price_cents, currency=EXCLUDED.currency,
                   billing_period=EXCLUDED.billing_period, sort=EXCLUDED.sort, category_ids=EXCLUDED.category_ids,
                   max_devices=EXCLUDED.max_devices, extra=EXCLUDED.extra",
            )
            .bind(&p.id)
            .bind(&p.name)
            .bind(p.price_cents)
            .bind(&p.currency)
            .bind(&p.billing_period)
            .bind(p.sort)
            .bind(&p.category_ids)
            .bind(p.max_devices)
            .bind(Value::Object(p.extra.clone()))
            .execute(&mut **tx)
            .await?;
        }
        Change::DeletePlan(id) => {
            sqlx::query("DELETE FROM plans WHERE id = $1")
                .bind(id)
                .execute(&mut **tx)
                .await?;
        }
        Change::User(u) => {
            sqlx::query(
                "INSERT INTO users (id, username, token, notify_token, plan_id, expires_at, active, max_devices, created_at, updated_at, extra)
                 VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,COALESCE(NULLIF($9,'')::timestamptz, now()),COALESCE(NULLIF($10,'')::timestamptz, now()),$11)
                 ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, token=EXCLUDED.token, notify_token=EXCLUDED.notify_token,
                   plan_id=EXCLUDED.plan_id, expires_at=EXCLUDED.expires_at, active=EXCLUDED.active, max_devices=EXCLUDED.max_devices,
                   updated_at=EXCLUDED.updated_at, extra=EXCLUDED.extra",
            )
            .bind(u.id)
            .bind(&u.username)
            .bind(&u.token)
            .bind(&u.notify_token)
            .bind(&u.plan_id)
            .bind(u.expires_at.as_deref().and_then(opt_str))
            .bind(u.active)
            .bind(u.max_devices)
            .bind(&u.created_at)
            .bind(&u.updated_at)
            .bind(Value::Object(u.extra.clone()))
            .execute(&mut **tx)
            .await?;
        }
        Change::DeleteUser(id) => {
            // Subscribers and personal pins go with the account (FK cascade).
            sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(&mut **tx)
                .await?;
        }
        Change::Subscriber(s) => {
            sqlx::query(
                "INSERT INTO subscribers (user_id, email, options, verified, verify_token, created_at, updated_at, last_expiry_notice)
                 VALUES ($1,$2,$3,$4,$5,COALESCE(NULLIF($6,'')::timestamptz, now()),COALESCE(NULLIF($7,'')::timestamptz, now()),$8::date)
                 ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email, options=EXCLUDED.options, verified=EXCLUDED.verified,
                   verify_token=EXCLUDED.verify_token, updated_at=EXCLUDED.updated_at, last_expiry_notice=EXCLUDED.last_expiry_notice",
            )
            .bind(s.user_id)
            .bind(&s.email)
            .bind(json!(s.options))
            .bind(s.verified)
            .bind(&s.verify_token)
            .bind(&s.created_at)
            .bind(&s.updated_at)
            .bind(s.last_expiry_notice.as_deref().and_then(opt_str))
            .execute(&mut **tx)
            .await?;
        }
        Change::DeleteSubscriber(user_id) => {
            sqlx::query("DELETE FROM subscribers WHERE user_id = $1")
                .bind(user_id)
                .execute(&mut **tx)
                .await?;
        }
        Change::NotifyLog(e) => {
            sqlx::query(
                "INSERT INTO notify_log (at, user_id, email, kind, ok, error) VALUES (COALESCE(NULLIF($1,'')::timestamptz, now()),$2,$3,$4,$5,$6)",
            )
            .bind(&e.at)
            .bind(e.user_id)
            .bind(&e.email)
            .bind(&e.kind)
            .bind(e.ok)
            .bind(&e.error)
            .execute(&mut **tx)
            .await?;
            sqlx::query("DELETE FROM notify_log WHERE id NOT IN (SELECT id FROM notify_log ORDER BY id DESC LIMIT $1)")
                .bind(NOTIFY_LOG_MAX as i64)
                .execute(&mut **tx)
                .await?;
        }
        Change::Payment(p) => {
            sqlx::query(
                "INSERT INTO payments (id, at, user_id, username, plan_id, plan_name, count, period, \"from\", previous_expires_at, expires_at, amount_cents, currency, note)
                 VALUES ($1,COALESCE(NULLIF($2,'')::timestamptz, now()),$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14)
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(&p.id)
            .bind(&p.at)
            .bind(p.user_id)
            .bind(&p.username)
            .bind(&p.plan_id)
            .bind(&p.plan_name)
            .bind(p.count)
            .bind(&p.period)
            .bind(&p.from)
            .bind(p.previous_expires_at.as_deref().and_then(opt_str))
            .bind(p.expires_at.as_deref().and_then(opt_str))
            .bind(p.amount_cents)
            .bind(&p.currency)
            .bind(&p.note)
            .execute(&mut **tx)
            .await?;
            sqlx::query("DELETE FROM payments WHERE seq NOT IN (SELECT seq FROM payments ORDER BY seq DESC LIMIT $1)")
                .bind(PAYMENTS_MAX as i64)
                .execute(&mut **tx)
                .await?;
        }
        Change::DeletePayment(id) => {
            sqlx::query("DELETE FROM payments WHERE id = $1")
                .bind(id)
                .execute(&mut **tx)
                .await?;
        }
        Change::Newsletter(n) => {
            sqlx::query(
                "INSERT INTO newsletters (id, created_at, subject, body, important, audience, status, recipients, sent, failed, error, sent_at)
                 VALUES ($1,COALESCE(NULLIF($2,'')::timestamptz, now()),$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,'')::timestamptz)
                 ON CONFLICT (id) DO UPDATE SET subject=EXCLUDED.subject, body=EXCLUDED.body, important=EXCLUDED.important,
                   audience=EXCLUDED.audience, status=EXCLUDED.status, recipients=EXCLUDED.recipients, sent=EXCLUDED.sent,
                   failed=EXCLUDED.failed, error=EXCLUDED.error, sent_at=EXCLUDED.sent_at",
            )
            .bind(&n.id)
            .bind(&n.created_at)
            .bind(&n.subject)
            .bind(&n.body)
            .bind(n.important)
            .bind(n.audience.as_ref().map(|a| json!(a)))
            .bind(&n.status)
            .bind(n.recipients as i64)
            .bind(n.sent as i64)
            .bind(n.failed as i64)
            .bind(&n.error)
            .bind(n.sent_at.as_deref().unwrap_or(""))
            .execute(&mut **tx)
            .await?;
            sqlx::query(
                "DELETE FROM newsletters WHERE seq NOT IN (SELECT seq FROM newsletters ORDER BY seq DESC LIMIT $1)",
            )
            .bind(NEWSLETTERS_MAX as i64)
            .execute(&mut **tx)
            .await?;
        }
        Change::DeleteNewsletter(id) => {
            sqlx::query("DELETE FROM newsletters WHERE id = $1")
                .bind(id)
                .execute(&mut **tx)
                .await?;
        }
        Change::Incident(i) => {
            sqlx::query(
                "INSERT INTO incidents (id, title, severity, starts_on, ends_on, note, created_at, updated_at)
                 VALUES ($1,$2,$3,$4::date,$5::date,$6,COALESCE(NULLIF($7,'')::timestamptz, now()),COALESCE(NULLIF($8,'')::timestamptz, now()))
                 ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, severity=EXCLUDED.severity, starts_on=EXCLUDED.starts_on,
                   ends_on=EXCLUDED.ends_on, note=EXCLUDED.note, updated_at=EXCLUDED.updated_at",
            )
            .bind(&i.id)
            .bind(&i.title)
            .bind(&i.severity)
            .bind(i.starts_on.as_deref().and_then(opt_str))
            .bind(i.ends_on.as_deref().and_then(opt_str))
            .bind(&i.note)
            .bind(&i.created_at)
            .bind(&i.updated_at)
            .execute(&mut **tx)
            .await?;
        }
        Change::DeleteIncident(id) => {
            sqlx::query("DELETE FROM incidents WHERE id = $1")
                .bind(id)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

/// Apply in-memory the effect of `trim` caps, mirroring the SQL trims.
fn trim_front<T>(v: &mut Vec<T>, max: usize) {
    let excess = v.len().saturating_sub(max);
    v.drain(..excess);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct Store {
    pool: PgPool,
    cache: RwLock<Arc<Db>>,
    writes: AsyncMutex<()>,
}

impl Store {
    /// Load the store from an already-migrated pool, seeding a fresh install
    /// (no settings at all) with the default branding and plans.
    pub async fn open(pool: PgPool) -> anyhow::Result<Self> {
        let db = load(&pool).await.context("loading the store")?;
        let store = Self {
            pool,
            cache: RwLock::new(Arc::new(db)),
            writes: AsyncMutex::new(()),
        };
        if store.read().settings.is_empty() && store.read().plans.is_empty() {
            store
                .write(|_| {
                    let mut changes = vec![
                        Change::Setting("brand_name".into(), json!("Мой IPTV-сервис")),
                        Change::Setting("tagline".into(), json!("Информационный канал аккаунта")),
                    ];
                    changes.extend(default_plans().into_iter().map(Change::Plan));
                    ((), changes)
                })
                .await?;
        }
        Ok(store)
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// A consistent read snapshot.
    pub fn read(&self) -> Arc<Db> {
        Arc::clone(&self.cache.read().unwrap_or_else(PoisonError::into_inner))
    }

    fn cache(&self) -> RwLockReadGuard<'_, Arc<Db>> {
        self.cache.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// Run a mutation: `f` edits a copy of the state and returns the row
    /// changes it made; they are persisted in one transaction before the copy
    /// becomes the cache. Cache effects of `Change`s are applied here, so `f`
    /// only has to describe them.
    pub async fn write<R>(&self, f: impl FnOnce(&Db) -> (R, Vec<Change>)) -> anyhow::Result<R> {
        let _guard = self.writes.lock().await;
        let current = self.read();
        let (result, changes) = f(&current);
        if changes.is_empty() {
            return Ok(result);
        }
        let mut tx = self.pool.begin().await?;
        for change in &changes {
            persist(&mut tx, change)
                .await
                .with_context(|| format!("persisting {}", change_name(change)))?;
        }
        tx.commit().await?;
        let mut next = (*current).clone();
        for change in changes {
            apply(&mut next, change);
        }
        *self.cache.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(next);
        Ok(result)
    }

    // ---- Settings ----

    pub fn settings(&self) -> Map<String, Value> {
        self.cache().settings.clone()
    }

    pub fn setting(&self, key: &str) -> Option<Value> {
        self.cache().settings.get(key).cloned()
    }

    pub async fn set_setting(&self, key: &str, value: Value) -> anyhow::Result<()> {
        self.write(|_| ((), vec![Change::Setting(key.to_owned(), value)])).await
    }

    pub fn brand_name(&self) -> String {
        self.cache().brand_name()
    }

    // ---- Plans ----

    pub fn plans(&self) -> Vec<Plan> {
        let mut plans = self.cache().plans.clone();
        plans.sort_by(|a, b| a.sort.total_cmp(&b.sort).then_with(|| locale_cmp(&a.name, &b.name)));
        plans
    }

    pub fn plan(&self, id: &str) -> Option<Plan> {
        self.cache().plan(id).cloned()
    }

    pub async fn create_plan(&self, new: NewPlan) -> anyhow::Result<Plan> {
        self.write(|db| {
            let base = slug(&new.name);
            let mut id = base.clone();
            let mut suffix = 2;
            while db.plans.iter().any(|p| p.id == id) {
                id = format!("{base}-{suffix}");
                suffix += 1;
            }
            let plan = Plan {
                id,
                name: new.name,
                price_cents: new.price_cents,
                currency: new.currency,
                billing_period: new.billing_period,
                category_ids: clean_category_ids(&new.category_ids),
                max_devices: new.max_devices,
                sort: db.plans.iter().map(|p| p.sort).fold(0.0, f64::max) + 1.0,
                extra: Map::new(),
            };
            (plan.clone(), vec![Change::Plan(plan)])
        })
        .await
    }

    pub async fn update_plan(&self, id: &str, patch: PlanPatch) -> anyhow::Result<Option<Plan>> {
        self.write(|db| {
            let Some(mut plan) = db.plan(id).cloned() else {
                return (None, vec![]);
            };
            if let Some(v) = patch.name {
                plan.name = v;
            }
            if let Some(v) = patch.price_cents {
                plan.price_cents = v;
            }
            if let Some(v) = patch.currency {
                plan.currency = v;
            }
            if let Some(v) = patch.billing_period {
                plan.billing_period = v;
            }
            if let Some(v) = patch.sort {
                plan.sort = v;
            }
            if let Some(v) = patch.max_devices {
                plan.max_devices = v;
            }
            if let Some(v) = patch.category_ids {
                plan.category_ids = clean_category_ids(&v);
            }
            (Some(plan.clone()), vec![Change::Plan(plan)])
        })
        .await
    }

    pub async fn remove_plan(&self, id: &str) -> anyhow::Result<bool> {
        self.write(|db| {
            let found = db.plan(id).is_some();
            (
                found,
                if found {
                    vec![Change::DeletePlan(id.to_owned())]
                } else {
                    vec![]
                },
            )
        })
        .await
    }

    /// Drop a deleted category from every plan that granted it.
    pub async fn plans_remove_category(&self, category_id: &str) -> anyhow::Result<usize> {
        self.write(|db| {
            let changes: Vec<Change> = db
                .plans
                .iter()
                .filter(|p| p.category_ids.iter().any(|c| c == category_id))
                .map(|p| {
                    let mut p = p.clone();
                    p.category_ids.retain(|c| c != category_id);
                    Change::Plan(p)
                })
                .collect();
            (changes.len(), changes)
        })
        .await
    }

    // ---- Users ----

    /// Every user, decorated, sorted by name.
    pub fn users(&self) -> Vec<DecoratedUser> {
        let db = self.read();
        let plans: HashMap<&str, &Plan> = db.plans.iter().map(|p| (p.id.as_str(), p)).collect();
        let mut users: Vec<DecoratedUser> = db
            .users
            .iter()
            .map(|u| DecoratedUser::decorate(u.clone(), plans.get(u.plan_id.as_str()).copied()))
            .collect();
        users.sort_by(|a, b| locale_cmp(&a.username, &b.username));
        users
    }

    pub fn user(&self, id: i64) -> Option<DecoratedUser> {
        let db = self.cache();
        db.users.iter().find(|u| u.id == id).map(|u| db.decorate(u))
    }

    pub fn user_by_token(&self, token: &str) -> Option<DecoratedUser> {
        if token.is_empty() {
            return None;
        }
        let db = self.cache();
        db.users.iter().find(|u| u.token == token).map(|u| db.decorate(u))
    }

    pub fn user_by_notify_token(&self, token: &str) -> Option<DecoratedUser> {
        if token.is_empty() {
            return None;
        }
        let db = self.cache();
        db.users
            .iter()
            .find(|u| u.notify_token == token)
            .map(|u| db.decorate(u))
    }

    pub async fn create_user(
        &self,
        username: String,
        plan_id: String,
        expires_at: Option<String>,
        active: bool,
        token: Option<String>,
    ) -> anyhow::Result<DecoratedUser> {
        let id: i64 = sqlx::query_scalar("SELECT nextval(pg_get_serial_sequence('users', 'id'))")
            .fetch_one(&self.pool)
            .await?;
        self.write(|db| {
            let user = User {
                id,
                username,
                token: token.unwrap_or_else(|| make_token(16)),
                notify_token: make_token(16),
                plan_id,
                expires_at,
                active,
                max_devices: None,
                created_at: now_stamp(),
                updated_at: now_stamp(),
                extra: Map::new(),
            };
            (db.decorate(&user), vec![Change::User(user)])
        })
        .await
    }

    fn update_user_with(db: &Db, id: i64, f: impl FnOnce(&mut User)) -> (Option<DecoratedUser>, Vec<Change>) {
        let Some(mut user) = db.users.iter().find(|u| u.id == id).cloned() else {
            return (None, vec![]);
        };
        f(&mut user);
        user.updated_at = now_stamp();
        (Some(db.decorate(&user)), vec![Change::User(user)])
    }

    pub async fn update_user(&self, id: i64, patch: UserPatch) -> anyhow::Result<Option<DecoratedUser>> {
        self.write(|db| {
            Self::update_user_with(db, id, |user| {
                if let Some(v) = patch.username {
                    user.username = v;
                }
                if let Some(v) = patch.plan_id {
                    user.plan_id = v;
                }
                if let Some(v) = patch.expires_at {
                    user.expires_at = v;
                }
                if let Some(v) = patch.active {
                    user.active = v;
                }
                if let Some(v) = patch.max_devices {
                    user.max_devices = v;
                }
            })
        })
        .await
    }

    pub async fn regenerate_token(&self, id: i64) -> anyhow::Result<Option<DecoratedUser>> {
        self.write(|db| Self::update_user_with(db, id, |u| u.token = make_token(16)))
            .await
    }

    /// Remove a user; their subscriber row and pins go too.
    pub async fn remove_user(&self, id: i64) -> anyhow::Result<()> {
        self.write(|_| ((), vec![Change::DeleteUser(id)])).await
    }

    // ---- Subscribers (one per user) ----

    pub fn subscribers(&self) -> Vec<Subscriber> {
        self.cache().subscribers.clone()
    }

    pub fn subscriber(&self, user_id: i64) -> Option<Subscriber> {
        self.cache().subscribers.iter().find(|s| s.user_id == user_id).cloned()
    }

    /// Create or update; a new/changed address must re-prove control.
    pub async fn upsert_subscriber(
        &self,
        user_id: i64,
        email: &str,
        options: &NotifyOptions,
    ) -> anyhow::Result<Subscriber> {
        let options = NotifyOptions {
            renewal: true,
            ..options.clone()
        };
        self.write(|db| {
            let sub = match db.subscribers.iter().find(|s| s.user_id == user_id) {
                Some(existing) => {
                    let mut s = existing.clone();
                    if s.email != email {
                        s.verified = false;
                        s.verify_token = Some(make_token(16));
                        s.last_expiry_notice = None;
                    }
                    email.clone_into(&mut s.email);
                    s.options = options;
                    s.updated_at = now_stamp();
                    s
                }
                None => Subscriber {
                    user_id,
                    email: email.to_owned(),
                    options,
                    verified: false,
                    verify_token: Some(make_token(16)),
                    created_at: now_stamp(),
                    updated_at: now_stamp(),
                    last_expiry_notice: None,
                },
            };
            (sub.clone(), vec![Change::Subscriber(sub)])
        })
        .await
    }

    pub fn subscriber_by_verify_token(&self, token: &str) -> Option<Subscriber> {
        self.cache()
            .subscribers
            .iter()
            .find(|s| s.verify_token.as_deref() == Some(token))
            .cloned()
    }

    async fn update_subscriber(
        &self,
        user_id: i64,
        f: impl FnOnce(&mut Subscriber),
    ) -> anyhow::Result<Option<Subscriber>> {
        self.write(|db| {
            let Some(mut s) = db.subscribers.iter().find(|s| s.user_id == user_id).cloned() else {
                return (None, vec![]);
            };
            f(&mut s);
            (Some(s.clone()), vec![Change::Subscriber(s)])
        })
        .await
    }

    pub async fn mark_verified(&self, user_id: i64) -> anyhow::Result<Option<Subscriber>> {
        self.update_subscriber(user_id, |s| {
            s.verified = true;
            s.verify_token = None;
            s.updated_at = now_stamp();
        })
        .await
    }

    pub async fn set_expiry_notice(&self, user_id: i64, value: Option<String>) -> anyhow::Result<()> {
        self.update_subscriber(user_id, |s| s.last_expiry_notice = value)
            .await
            .map(|_| ())
    }

    pub async fn remove_subscriber(&self, user_id: i64) -> anyhow::Result<()> {
        self.write(|_| ((), vec![Change::DeleteSubscriber(user_id)])).await
    }

    // ---- Notification send log ----

    pub fn notify_log_recent(&self, n: usize) -> Vec<NotifyLogEntry> {
        self.cache().notify_log.iter().rev().take(n).cloned().collect()
    }

    pub async fn notify_log_add(&self, mut entry: NotifyLogEntry) -> anyhow::Result<()> {
        entry.at = now_stamp();
        self.write(|_| ((), vec![Change::NotifyLog(entry)])).await
    }

    // ---- Payments ----

    /// Newest first.
    pub fn payments(&self) -> Vec<Payment> {
        self.cache().payments.iter().rev().cloned().collect()
    }

    pub fn payment(&self, id: &str) -> Option<Payment> {
        self.cache().payments.iter().find(|p| p.id == id).cloned()
    }

    pub fn last_payment_for(&self, user_id: i64) -> Option<Payment> {
        self.cache()
            .payments
            .iter()
            .rev()
            .find(|p| p.user_id == user_id)
            .cloned()
    }

    pub async fn add_payment(&self, mut payment: Payment) -> anyhow::Result<Payment> {
        payment.id = make_token(10);
        payment.at = iso_now();
        self.write(|_| (payment.clone(), vec![Change::Payment(payment)])).await
    }

    pub async fn remove_payment(&self, id: &str) -> anyhow::Result<Option<Payment>> {
        self.write(|db| {
            let found = db.payments.iter().find(|p| p.id == id).cloned();
            let changes = found.iter().map(|_| Change::DeletePayment(id.to_owned())).collect();
            (found, changes)
        })
        .await
    }

    // ---- Newsletters ----

    /// Newest first.
    pub fn newsletters(&self) -> Vec<Newsletter> {
        self.cache().newsletters.iter().rev().cloned().collect()
    }

    pub async fn create_newsletter(&self, mut n: Newsletter) -> anyhow::Result<Newsletter> {
        n.id = make_token(10);
        n.created_at = iso_now();
        self.write(|_| (n.clone(), vec![Change::Newsletter(n)])).await
    }

    pub async fn update_newsletter(
        &self,
        id: &str,
        f: impl FnOnce(&mut Newsletter),
    ) -> anyhow::Result<Option<Newsletter>> {
        self.write(|db| {
            let Some(mut n) = db.newsletters.iter().find(|n| n.id == id).cloned() else {
                return (None, vec![]);
            };
            f(&mut n);
            (Some(n.clone()), vec![Change::Newsletter(n)])
        })
        .await
    }

    pub async fn remove_newsletter(&self, id: &str) -> anyhow::Result<bool> {
        self.write(|db| {
            let found = db.newsletters.iter().any(|n| n.id == id);
            (
                found,
                if found {
                    vec![Change::DeleteNewsletter(id.to_owned())]
                } else {
                    vec![]
                },
            )
        })
        .await
    }

    // ---- Incidents ----

    /// Newest first by start date, then most recently created.
    pub fn incidents(&self) -> Vec<Incident> {
        let mut list = self.cache().incidents.clone();
        list.sort_by(|a, b| {
            b.starts_on
                .cmp(&a.starts_on)
                .then_with(|| b.created_at.cmp(&a.created_at))
        });
        list
    }

    pub fn incident(&self, id: &str) -> Option<Incident> {
        self.cache().incidents.iter().find(|i| i.id == id).cloned()
    }

    pub async fn create_incident(&self, f: IncidentFields) -> anyhow::Result<Incident> {
        let inc = Incident {
            id: make_token(10),
            title: f.title.unwrap_or_default().trim().to_owned(),
            severity: f
                .severity
                .filter(|s| s == "degraded" || s == "outage")
                .unwrap_or_else(|| "degraded".into()),
            starts_on: f.starts_on.flatten().filter(|s| !s.is_empty()),
            ends_on: f.ends_on.flatten().filter(|s| !s.is_empty()),
            note: f.note.unwrap_or_default().trim().to_owned(),
            created_at: now_stamp(),
            updated_at: now_stamp(),
        };
        self.write(|_| (inc.clone(), vec![Change::Incident(inc)])).await
    }

    pub async fn update_incident(&self, id: &str, f: IncidentFields) -> anyhow::Result<Option<Incident>> {
        self.write(|db| {
            let Some(mut inc) = db.incidents.iter().find(|i| i.id == id).cloned() else {
                return (None, vec![]);
            };
            if let Some(v) = f.title {
                v.trim().clone_into(&mut inc.title);
            }
            if let Some(v) = f.severity.filter(|s| s == "degraded" || s == "outage") {
                inc.severity = v;
            }
            if let Some(v) = f.starts_on {
                inc.starts_on = v.filter(|s| !s.is_empty());
            }
            if let Some(v) = f.ends_on {
                inc.ends_on = v.filter(|s| !s.is_empty());
            }
            if let Some(v) = f.note {
                v.trim().clone_into(&mut inc.note);
            }
            inc.updated_at = now_stamp();
            (Some(inc.clone()), vec![Change::Incident(inc)])
        })
        .await
    }

    pub async fn remove_incident(&self, id: &str) -> anyhow::Result<bool> {
        self.write(|db| {
            let found = db.incidents.iter().any(|i| i.id == id);
            (
                found,
                if found {
                    vec![Change::DeleteIncident(id.to_owned())]
                } else {
                    vec![]
                },
            )
        })
        .await
    }

    /// A few sample users so the channel is visible immediately. No-op when
    /// any user exists.
    pub async fn seed_demo(&self) -> anyhow::Result<Vec<DecoratedUser>> {
        if !self.cache().users.is_empty() {
            return Ok(Vec::new());
        }
        let today = jiff::Zoned::now().date();
        let in_days = |n: i64| today.checked_add(jiff::Span::new().days(n)).map(|d| d.to_string()).ok();
        let mut out = Vec::new();
        for (name, plan, days) in [
            ("Alice", "pro", 90),
            ("Bob", "standard", 4),
            ("Charlie", "standard", -3),
        ] {
            out.push(
                self.create_user(name.into(), plan.into(), in_days(days), true, None)
                    .await?,
            );
        }
        Ok(out)
    }
}

fn change_name(c: &Change) -> &'static str {
    match c {
        Change::Setting(..) => "setting",
        Change::Plan(_) | Change::DeletePlan(_) => "plan",
        Change::User(_) | Change::DeleteUser(_) => "user",
        Change::Subscriber(_) | Change::DeleteSubscriber(_) => "subscriber",
        Change::NotifyLog(_) => "notify log",
        Change::Payment(_) | Change::DeletePayment(_) => "payment",
        Change::Newsletter(_) | Change::DeleteNewsletter(_) => "newsletter",
        Change::Incident(_) | Change::DeleteIncident(_) => "incident",
    }
}

fn upsert<T>(list: &mut Vec<T>, item: T, same: impl Fn(&T) -> bool) {
    match list.iter_mut().find(|x| same(x)) {
        Some(slot) => *slot = item,
        None => list.push(item),
    }
}

/// Mirror a persisted change in the cached state.
fn apply(db: &mut Db, change: Change) {
    match change {
        Change::Setting(k, v) => {
            db.settings.insert(k, v);
        }
        Change::Plan(p) => {
            let id = p.id.clone();
            upsert(&mut db.plans, p, |x| x.id == id);
        }
        Change::DeletePlan(id) => db.plans.retain(|p| p.id != id),
        Change::User(u) => {
            let id = u.id;
            upsert(&mut db.users, u, |x| x.id == id);
        }
        Change::DeleteUser(id) => {
            db.users.retain(|u| u.id != id);
            db.subscribers.retain(|s| s.user_id != id);
        }
        Change::Subscriber(s) => {
            let id = s.user_id;
            upsert(&mut db.subscribers, s, |x| x.user_id == id);
        }
        Change::DeleteSubscriber(id) => db.subscribers.retain(|s| s.user_id != id),
        Change::NotifyLog(e) => {
            db.notify_log.push(e);
            trim_front(&mut db.notify_log, NOTIFY_LOG_MAX);
        }
        Change::Payment(p) => {
            db.payments.push(p);
            trim_front(&mut db.payments, PAYMENTS_MAX);
        }
        Change::DeletePayment(id) => db.payments.retain(|p| p.id != id),
        Change::Newsletter(n) => {
            let id = n.id.clone();
            if db.newsletters.iter().any(|x| x.id == id) {
                upsert(&mut db.newsletters, n, |x| x.id == id);
            } else {
                db.newsletters.push(n);
                trim_front(&mut db.newsletters, NEWSLETTERS_MAX);
            }
        }
        Change::DeleteNewsletter(id) => db.newsletters.retain(|n| n.id != id),
        Change::Incident(i) => {
            let id = i.id.clone();
            upsert(&mut db.incidents, i, |x| x.id == id);
        }
        Change::DeleteIncident(id) => db.incidents.retain(|i| i.id != id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::db::testing::TestDb;

    #[test]
    fn plan_slugs() {
        assert_eq!(slug("Премиум HD"), "hd");
        assert_eq!(slug("Café Plus!"), "cafe-plus");
        assert_eq!(slug("Тариф"), "plan");
    }

    #[tokio::test]
    async fn fresh_install_round_trips_through_postgres() {
        let t = TestDb::new().await;
        let store = Store::open(t.pool.clone()).await.unwrap();
        assert_eq!(
            store.plans().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["standard", "pro"]
        );
        let u = store
            .create_user("Ivan".into(), "pro".into(), Some("2026-06-30".into()), true, None)
            .await
            .unwrap();
        assert_eq!(u.plan_name, "Про");
        assert_ne!(u.token, u.notify_token);
        let opts = NotifyOptions {
            server: true,
            ..NotifyOptions::default()
        };
        store.upsert_subscriber(u.id, "a@b.c", &opts).await.unwrap();
        store
            .add_payment(Payment {
                user_id: u.id,
                expires_at: Some("2026-07-30".into()),
                amount_cents: Some(699),
                ..Payment::default()
            })
            .await
            .unwrap();
        store.set_setting("gateway_enabled", json!(true)).await.unwrap();

        // A second store over the same database sees exactly the same state.
        let again = Store::open(t.pool.clone()).await.unwrap();
        let back = again.user(u.id).unwrap();
        assert_eq!(back.username, "Ivan");
        assert_eq!(back.expires_at.as_deref(), Some("2026-06-30"));
        assert_eq!(back.created_at, u.created_at);
        assert_eq!(again.user_by_token(&u.token).unwrap().id, u.id);
        assert!(again.subscriber(u.id).unwrap().options.server);
        assert_eq!(again.payments()[0].amount_cents, Some(699));
        assert!(again.payments()[0].at.ends_with('Z'));
        assert_eq!(again.setting("gateway_enabled"), Some(json!(true)));

        // Deleting the user takes the subscriber with it.
        again.remove_user(u.id).await.unwrap();
        let third = Store::open(t.pool.clone()).await.unwrap();
        assert!(third.user(u.id).is_none() && third.subscriber(u.id).is_none());
        t.drop().await;
    }

    #[tokio::test]
    async fn failed_write_leaves_cache_untouched() {
        let t = TestDb::new().await;
        let store = Store::open(t.pool.clone()).await.unwrap();
        let u = store
            .create_user("x".into(), "pro".into(), None, true, None)
            .await
            .unwrap();
        // An unparseable date is rejected by the DATE column…
        let bad = UserPatch {
            expires_at: Some(Some("not-a-date".into())),
            ..UserPatch::default()
        };
        assert!(store.update_user(u.id, bad).await.is_err());
        // …and memory still matches the database.
        assert_eq!(store.user(u.id).unwrap().expires_at, None);
        t.drop().await;
    }

    #[tokio::test]
    async fn subscriber_change_requires_reverification_and_caps_hold() {
        let t = TestDb::new().await;
        let store = Store::open(t.pool.clone()).await.unwrap();
        let u = store
            .create_user("x".into(), "pro".into(), None, true, None)
            .await
            .unwrap();
        let opts = NotifyOptions::default();
        assert!(!store.upsert_subscriber(u.id, "a@b.c", &opts).await.unwrap().verified);
        store.mark_verified(u.id).await.unwrap();
        assert!(store.upsert_subscriber(u.id, "a@b.c", &opts).await.unwrap().verified);
        assert!(!store.upsert_subscriber(u.id, "new@b.c", &opts).await.unwrap().verified);
        for i in 0..(NOTIFY_LOG_MAX + 5) {
            store
                .notify_log_add(NotifyLogEntry {
                    email: format!("{i}"),
                    ok: true,
                    ..NotifyLogEntry::default()
                })
                .await
                .unwrap();
        }
        let again = Store::open(t.pool.clone()).await.unwrap();
        assert_eq!(again.notify_log_recent(1000).len(), NOTIFY_LOG_MAX);
        assert_eq!(again.notify_log_recent(1)[0].email, format!("{}", NOTIFY_LOG_MAX + 4));
        t.drop().await;
    }
}
