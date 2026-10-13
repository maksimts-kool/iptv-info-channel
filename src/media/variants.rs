//! Who sees what on the media channel. Pure — no I/O.
//!
//! With PRIVATE content (an article for an audience, or a private section in
//! one) customers can see different channels. One loop per customer would
//! not scale, so customers are grouped by what they actually see: a VARIANT
//! is "these articles, with these of their private sections", and everyone in
//! the same variant shares one loop. The PUBLIC variant (no audience) is a
//! subset of every other, which is why its loop is a safe stand-in while a
//! customer's own is still being built.

use indexmap::IndexMap;

use super::doc::{doc_has_content, filter_private, private_sections};
use super::model::Article;
use crate::core::audience::{Audience, audience_matches};
use crate::data::model::DecoratedUser;

/// Who is looking.
#[derive(Debug, Clone, Copy)]
pub enum Viewer<'a> {
    /// The admin preview: every private section shown.
    All,
    /// A customer in no audience.
    Public,
    Customer(&'a DecoratedUser),
}

impl Viewer<'_> {
    pub fn can_see(&self, audience: &Audience) -> bool {
        match self {
            Self::All => true,
            Self::Public => audience_matches::<DecoratedUser>(Some(audience), None),
            Self::Customer(u) => audience_matches(Some(audience), Some(*u)),
        }
    }
}

/// One article as a viewer sees it, plus which private sections it kept.
#[derive(Debug, Clone)]
pub struct Entry {
    pub article: Article,
    pub mask: String,
}

/// The articles this viewer sees, in play order, each resolved to the
/// document they see. Articles that end up empty are left out.
pub fn articles_for(articles: &[Article], viewer: Viewer<'_>) -> Vec<Entry> {
    let see = |a: &Audience| viewer.can_see(a);
    articles
        .iter()
        .filter(|a| a.audience.as_ref().is_none_or(see))
        .filter_map(|a| {
            let doc = filter_private(&a.doc, &see);
            if !doc_has_content(&doc) {
                return None;
            }
            let mask = private_sections(&a.doc)
                .into_iter()
                .map(|aud| if see(aud) { '1' } else { '0' })
                .collect();
            Some(Entry {
                article: Article { doc, ..a.clone() },
                mask,
            })
        })
        .collect()
}

/// A stable name for "what this viewer sees". Equal keys = identical channel.
pub fn variant_key(entries: &[Entry]) -> String {
    entries
        .iter()
        .map(|e| format!("{}:{}", e.article.id, e.mask))
        .collect::<Vec<_>>()
        .join(",")
}

#[derive(Debug, Clone)]
pub struct Variant {
    pub entries: Vec<Entry>,
    pub user_ids: Vec<i64>,
    pub public: bool,
}

/// Every variant the customers need, plus the public one (always present:
/// it is the fallback). Ordered with the public variant first.
pub fn media_variants(articles: &[Article], users: &[DecoratedUser]) -> (String, IndexMap<String, Variant>) {
    let mut variants = IndexMap::new();
    let public_entries = articles_for(articles, Viewer::Public);
    let public_key = variant_key(&public_entries);
    variants.insert(
        public_key.clone(),
        Variant {
            entries: public_entries,
            user_ids: vec![],
            public: true,
        },
    );
    for user in users {
        let entries = articles_for(articles, Viewer::Customer(user));
        let key = variant_key(&entries);
        variants
            .entry(key)
            .or_insert_with(|| Variant {
                entries,
                user_ids: vec![],
                public: false,
            })
            .user_ids
            .push(user.id);
    }
    (public_key, variants)
}

/// Whether any article holds private content at all — when none does,
/// customer changes need no media rebuild.
pub fn has_private_content(articles: &[Article]) -> bool {
    articles
        .iter()
        .any(|a| a.audience.is_some() || !private_sections(&a.doc).is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::epg::tests::user;
    use crate::media::doc::sanitize_doc;
    use serde_json::json;

    fn article(id: &str, doc: serde_json::Value, audience: Option<Audience>) -> Article {
        Article {
            id: id.into(),
            doc: sanitize_doc(&doc).unwrap(),
            audience,
            ..Article::default()
        }
    }
    fn p(t: &str) -> serde_json::Value {
        json!({"type": "paragraph", "content": [{"type": "text", "text": t}]})
    }
    fn customer(id: i64, plan: &str) -> DecoratedUser {
        let mut u = user("t", "u", None, true, false);
        u.user.id = id;
        u.user.plan_id = plan.into();
        u
    }

    fn fixture() -> Vec<Article> {
        vec![
            article("news", json!({"type": "doc", "content": [p("всем")]}), None),
            article(
                "vip",
                json!({"type": "doc", "content": [p("только про")]}),
                Some(Audience {
                    users: vec![],
                    plans: vec!["pro".into()],
                }),
            ),
            article(
                "mixed",
                json!({"type": "doc", "content": [p("общая часть"), {"type": "privateSection", "attrs": {"audience": {"users": [2], "plans": []}}, "content": [p("для Боба")]}]}),
                None,
            ),
            article(
                "empty-for-public",
                json!({"type": "doc", "content": [{"type": "privateSection", "attrs": {"audience": {"users": [3], "plans": []}}, "content": [p("для Кэрол")]}]}),
                None,
            ),
        ]
    }

    #[test]
    fn each_viewer_sees_their_share() {
        let arts = fixture();
        let (alice, bob, carol) = (customer(1, "pro"), customer(2, "std"), customer(3, "std"));
        let ids = |v: Viewer<'_>| {
            articles_for(&arts, v)
                .iter()
                .map(|e| {
                    if e.mask.is_empty() {
                        e.article.id.clone()
                    } else {
                        format!("{}:{}", e.article.id, e.mask)
                    }
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(Viewer::Public), ["news", "mixed:0"]);
        assert_eq!(ids(Viewer::Customer(&alice)), ["news", "vip", "mixed:0"]);
        assert_eq!(ids(Viewer::Customer(&bob)), ["news", "mixed:1"]);
        assert_eq!(ids(Viewer::Customer(&carol)), ["news", "mixed:0", "empty-for-public:1"]);
        assert_eq!(articles_for(&arts, Viewer::All).len(), 4);
        let bobs = serde_json::to_string(&articles_for(&arts, Viewer::Customer(&bob))[1].article.doc).unwrap();
        assert!(bobs.contains("для Боба") && !bobs.contains("privateSection"));
    }

    #[test]
    fn same_view_same_variant() {
        let arts = fixture();
        let users = [
            customer(1, "pro"),
            customer(2, "std"),
            customer(3, "std"),
            customer(4, "free"),
        ];
        let (public, variants) = media_variants(&arts, &users);
        assert_eq!(variants.len(), 4);
        assert_eq!(variants[&public].user_ids, [4]);
        assert!(variants[&public].public);
        assert!(!has_private_content(&arts[..1]) && has_private_content(&arts));
        assert_eq!(media_variants(&arts[..1], &users[..2]).1.len(), 1);
    }
}
