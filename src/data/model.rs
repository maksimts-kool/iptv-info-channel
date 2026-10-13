//! Record types of the JSON store (`db.json`). Field names and shapes match
//! what the Node version wrote, so an existing data directory loads as-is;
//! fields this version does not know are carried through untouched (`extra`).

use std::collections::HashSet;
use std::ops::Deref;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::core::audience::Member;

/// `active` was stored as 1/0 (an old SQLite habit); accept bools too.
pub mod int_bool {
    use super::{Deserialize, Deserializer, Serializer, Value};

    #[allow(clippy::trivially_copy_pass_by_ref)] // serde's `with` signature
    pub fn serialize<S: Serializer>(v: &bool, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(u8::from(*v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
        Ok(match Value::deserialize(d)? {
            Value::Bool(b) => b,
            Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
            Value::String(s) => !s.is_empty() && s != "0" && s != "false",
            _ => false,
        })
    }
}

const fn one() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Plan {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub price_cents: i64,
    #[serde(default = "default_currency")]
    pub currency: String,
    #[serde(default)]
    pub billing_period: String,
    #[serde(default)]
    pub sort: f64,
    /// The catalog categories this plan sells.
    #[serde(default)]
    pub category_ids: Vec<String>,
    /// Simultaneous-device cap; 0 = no limit.
    #[serde(default)]
    pub max_devices: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_currency() -> String {
    "EUR".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub token: String,
    #[serde(default)]
    pub notify_token: String,
    #[serde(default)]
    pub plan_id: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(with = "int_bool", default = "one")]
    pub active: bool,
    /// Personal device cap; `None` = follow the plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_devices: Option<i64>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A user with their plan's fields merged on (mimics the old SQL join).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DecoratedUser {
    #[serde(flatten)]
    pub user: User,
    pub plan_name: String,
    pub price_cents: i64,
    pub currency: String,
    pub billing_period: String,
    /// The categories the plan grants — the base of the channel list.
    pub plan_categories: Vec<String>,
    pub plan_max_devices: i64,
    /// The cap that applies: personal override, else the plan's. 0 = none.
    pub device_limit: i64,
}

impl Deref for DecoratedUser {
    type Target = User;
    fn deref(&self) -> &User {
        &self.user
    }
}

impl DecoratedUser {
    pub fn decorate(user: User, plan: Option<&Plan>) -> Self {
        let plan_max = plan.map_or(0, |p| p.max_devices);
        Self {
            plan_name: plan.map_or_else(|| user.plan_id.clone(), |p| p.name.clone()),
            price_cents: plan.map_or(0, |p| p.price_cents),
            currency: plan.map_or_else(default_currency, |p| p.currency.clone()),
            billing_period: plan.map(|p| p.billing_period.clone()).unwrap_or_default(),
            plan_categories: plan.map(|p| p.category_ids.clone()).unwrap_or_default(),
            plan_max_devices: plan_max,
            device_limit: effective_device_limit(user.max_devices, plan_max),
            user,
        }
    }

    /// The plan's categories as a lookup set for the resolver.
    pub fn plan_category_set(&self) -> HashSet<String> {
        self.plan_categories.iter().cloned().collect()
    }
}

impl Member for User {
    fn member_id(&self) -> i64 {
        self.id
    }
    fn member_plan(&self) -> &str {
        &self.plan_id
    }
}

impl Member for DecoratedUser {
    fn member_id(&self) -> i64 {
        self.id
    }
    fn member_plan(&self) -> &str {
        &self.plan_id
    }
}

/// A personal override wins, else the plan's. Negative means "none".
pub fn effective_device_limit(personal: Option<i64>, plan_limit: i64) -> i64 {
    match personal {
        Some(p) if p >= 0 => p,
        _ => plan_limit.max(0),
    }
}

/// Incident severities, worst last. `Operational` is the implicit
/// no-incident state and is never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Operational,
    Degraded,
    Outage,
}

impl Severity {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "operational" => Some(Self::Operational),
            "degraded" => Some(Self::Degraded),
            "outage" => Some(Self::Outage),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Operational => "operational",
            Self::Degraded => "degraded",
            Self::Outage => "outage",
        }
    }

    pub fn color(self) -> &'static str {
        match self {
            Self::Operational => "#16a34a",
            Self::Degraded => "#d97706",
            Self::Outage => "#dc2626",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Operational => "Работает",
            Self::Degraded => "Деградация",
            Self::Outage => "Сбой",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Incident {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Kept as text: a record with an unknown severity is ignored, not fatal.
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub starts_on: Option<String>,
    #[serde(default)]
    pub ends_on: Option<String>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

impl Incident {
    /// The severity, when it is one an incident can be stored as.
    pub fn severity(&self) -> Option<Severity> {
        Severity::parse(&self.severity).filter(|s| *s != Severity::Operational)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotifyOptions {
    #[serde(default)]
    pub server: bool,
    #[serde(default)]
    pub expiry: bool,
    #[serde(default)]
    pub content: bool,
    #[serde(default)]
    pub news: bool,
    #[serde(default = "one")]
    pub renewal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Subscriber {
    pub user_id: i64,
    pub email: String,
    #[serde(default)]
    pub options: NotifyOptions,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub verify_token: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub last_expiry_notice: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Payment {
    pub id: String,
    /// ISO instant the payment was recorded.
    pub at: String,
    pub user_id: i64,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub plan_id: String,
    #[serde(default)]
    pub plan_name: String,
    #[serde(default = "one_count")]
    pub count: i64,
    #[serde(default)]
    pub period: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub previous_expires_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub amount_cents: Option<i64>,
    #[serde(default = "default_currency")]
    pub currency: String,
    #[serde(default)]
    pub note: String,
}

const fn one_count() -> i64 {
    1
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Newsletter {
    pub id: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub important: bool,
    #[serde(default)]
    pub audience: Option<crate::core::audience::Audience>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub recipients: usize,
    #[serde(default)]
    pub sent: usize,
    #[serde(default)]
    pub failed: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct NotifyLogEntry {
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default)]
    pub email: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
