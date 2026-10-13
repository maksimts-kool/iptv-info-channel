//! An AUDIENCE: a hand-picked group of customers, named by customer id and/or
//! by plan. Shared by the two features that address only some customers —
//! private media-channel articles/sections and the email newsletter — so "who
//! is in the group" means the same thing in both.
//!
//! A customer belongs when their id is listed OR their current plan is, so a
//! plan-wide group follows the customer when their plan changes. An audience
//! with neither list is a group of nobody (not "everyone": "everyone" is the
//! absence of an audience, `None`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_MEMBERS: usize = 500;

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Audience {
    #[serde(default)]
    pub users: Vec<i64>,
    #[serde(default)]
    pub plans: Vec<String>,
}

/// Anything a client sent -> a clean audience, or `None` when the value is not
/// an object at all (callers use `None` for "no restriction"). Ids are
/// de-duplicated; users are positive integers, plans non-empty strings.
pub fn clean_audience(raw: &Value) -> Option<Audience> {
    let obj = raw.as_object()?;
    let list = |key: &str| obj.get(key).and_then(Value::as_array).cloned().unwrap_or_default();

    let mut users = Vec::new();
    for v in list("users") {
        let id = match &v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        };
        if let Some(id) = id.filter(|f| f.fract() == 0.0 && *f > 0.0).map(|f| f as i64)
            && !users.contains(&id)
        {
            users.push(id);
        }
    }
    users.truncate(MAX_MEMBERS);

    let mut plans: Vec<String> = Vec::new();
    for v in list("plans") {
        let id = match &v {
            Value::String(s) => s.trim().to_owned(),
            Value::Number(n) => n.to_string(),
            _ => continue,
        };
        if !id.is_empty() && id.chars().count() <= 64 && !plans.contains(&id) {
            plans.push(id);
        }
    }
    plans.truncate(MAX_MEMBERS);
    Some(Audience { users, plans })
}

/// Anything with an id and a plan can be matched against an audience.
pub trait Member {
    fn member_id(&self) -> i64;
    fn member_plan(&self) -> &str;
}

/// Does this customer belong? `None` audience = no restriction; a missing
/// customer (the "general public" viewer) belongs to no audience.
pub fn audience_matches<M: Member + ?Sized>(audience: Option<&Audience>, user: Option<&M>) -> bool {
    let Some(audience) = audience else {
        return true;
    };
    let Some(user) = user else { return false };
    audience.users.contains(&user.member_id()) || audience.plans.iter().any(|p| p == user.member_plan())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct U(i64, &'static str);
    impl Member for U {
        fn member_id(&self) -> i64 {
            self.0
        }
        fn member_plan(&self) -> &str {
            self.1
        }
    }

    #[test]
    fn cleans_to_unique_ids() {
        assert_eq!(clean_audience(&Value::Null), None);
        assert_eq!(clean_audience(&json!("everyone")), None);
        assert_eq!(clean_audience(&json!([1, 2])), None);
        assert_eq!(clean_audience(&json!({})), Some(Audience::default()));
        let long = "x".repeat(65);
        assert_eq!(
            clean_audience(&json!({"users": [3, "3", "7", -1, 2.5, "x", null], "plans": [" pro ", "pro", "", long]})),
            Some(Audience {
                users: vec![3, 7],
                plans: vec!["pro".into()]
            })
        );
    }

    #[test]
    fn membership_by_id_or_plan() {
        let alice = U(1, "pro");
        let bob = U(2, "std");
        let group = Audience {
            users: vec![2],
            plans: vec!["pro".into()],
        };
        assert!(audience_matches(Some(&group), Some(&alice)));
        assert!(audience_matches(Some(&group), Some(&bob)));
        let vip = Audience {
            users: vec![],
            plans: vec!["vip".into()],
        };
        assert!(!audience_matches(Some(&vip), Some(&bob)));
        assert!(audience_matches(None, Some(&bob)));
        assert!(!audience_matches::<U>(Some(&group), None));
    }
}
