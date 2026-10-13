//! The media channel's article format: a TipTap/ProseMirror document as the
//! admin's editor produces it, held as a typed tree. Pure — no I/O.
//!
//! The server never trusts the incoming shape: [`sanitize_doc`] keeps only the
//! node types and marks the TV renderer can draw, with attributes coerced, so
//! a hand-crafted request can't smuggle anything else in. Images and videos
//! are referenced by ASSET id, never by URL.
//!
//! A `privateSection` wraps part of an article only an audience sees. It
//! never reaches the renderer: [`filter_private`] resolves every section for
//! one viewer first — unwrapped for a member, dropped for everyone else.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::audience::{Audience, clean_audience};
use crate::regex;

pub const DOC_MAX_BYTES: usize = 300_000;
const MAX_DEPTH: usize = 12;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaSize {
    #[default]
    Full,
    Half,
    Small,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Mark {
    Bold,
    Italic,
    Strike,
    Code,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAttrs {
    pub asset_id: String,
    #[serde(default)]
    pub size: MediaSize,
    #[serde(default)]
    pub caption: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadingAttrs {
    pub level: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListAttrs {
    pub start: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivateAttrs {
    #[serde(default)]
    pub audience: Audience,
}

type Children = Vec<Node>;

fn no_children(c: &Children) -> bool {
    c.is_empty()
}

/// One node of an article.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Node {
    Doc {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    Paragraph {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    Heading {
        attrs: HeadingAttrs,
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    BulletList {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    OrderedList {
        attrs: ListAttrs,
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    ListItem {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    Blockquote {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    CodeBlock {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    Table {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    TableRow {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    TableHeader {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    TableCell {
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
    HorizontalRule,
    HardBreak,
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        marks: Vec<Mark>,
    },
    MediaImage {
        attrs: MediaAttrs,
    },
    MediaVideo {
        attrs: MediaAttrs,
    },
    PrivateSection {
        attrs: PrivateAttrs,
        #[serde(default, skip_serializing_if = "no_children")]
        content: Children,
    },
}

const EMPTY: &[Node] = &[];

impl Node {
    pub fn children(&self) -> &[Node] {
        match self {
            Self::Doc { content }
            | Self::Paragraph { content }
            | Self::Heading { content, .. }
            | Self::BulletList { content }
            | Self::OrderedList { content, .. }
            | Self::ListItem { content }
            | Self::Blockquote { content }
            | Self::CodeBlock { content }
            | Self::Table { content }
            | Self::TableRow { content }
            | Self::TableHeader { content }
            | Self::TableCell { content }
            | Self::PrivateSection { content, .. } => content,
            _ => EMPTY,
        }
    }

    fn children_mut(&mut self) -> Option<&mut Children> {
        match self {
            Self::Doc { content }
            | Self::Paragraph { content }
            | Self::Heading { content, .. }
            | Self::BulletList { content }
            | Self::OrderedList { content, .. }
            | Self::ListItem { content }
            | Self::Blockquote { content }
            | Self::CodeBlock { content }
            | Self::Table { content }
            | Self::TableRow { content }
            | Self::TableHeader { content }
            | Self::TableCell { content }
            | Self::PrivateSection { content, .. } => Some(content),
            _ => None,
        }
    }

    pub fn media(&self) -> Option<&MediaAttrs> {
        match self {
            Self::MediaImage { attrs } | Self::MediaVideo { attrs } => Some(attrs),
            _ => None,
        }
    }
}

/// An empty article: one empty paragraph.
pub fn empty_doc() -> Node {
    Node::Doc {
        content: vec![Node::Paragraph { content: vec![] }],
    }
}

fn short(value: Option<&Value>, max: usize) -> String {
    let s = value.and_then(Value::as_str).unwrap_or("");
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn clean_media(node: &Value, video: bool) -> Option<Node> {
    let attrs = node.get("attrs");
    let id = attrs
        .and_then(|a| a.get("assetId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !regex!(r"^[a-z0-9]{6,32}$").is_match(id) {
        return None;
    }
    let size = match attrs.and_then(|a| a.get("size")).and_then(Value::as_str) {
        Some("half") => MediaSize::Half,
        Some("small") => MediaSize::Small,
        _ => MediaSize::Full,
    };
    let attrs = MediaAttrs {
        asset_id: id.to_owned(),
        size,
        caption: short(attrs.and_then(|a| a.get("caption")), 200),
    };
    Some(if video {
        Node::MediaVideo { attrs }
    } else {
        Node::MediaImage { attrs }
    })
}

fn clean_text(node: &Value) -> Option<Node> {
    let text = node.get("text").and_then(Value::as_str).unwrap_or("");
    if text.is_empty() {
        return None;
    }
    let marks = node
        .get("marks")
        .and_then(Value::as_array)
        .map(|ms| {
            ms.iter()
                .filter_map(|m| match m.get("type").and_then(Value::as_str) {
                    Some("bold") => Some(Mark::Bold),
                    Some("italic") => Some(Mark::Italic),
                    Some("strike") => Some(Mark::Strike),
                    Some("code") => Some(Mark::Code),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Node::Text {
        text: text.to_owned(),
        marks,
    })
}

/// A cleaned child may expand to several: a private section nested in
/// another is spliced into its parent.
fn clean_children(node: &Value, depth: usize, in_private: bool) -> Children {
    node.get("content")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter()
                .flat_map(|child| clean_node(child, depth + 1, in_private))
                .collect()
        })
        .unwrap_or_default()
}

fn clean_node(node: &Value, depth: usize, in_private: bool) -> Vec<Node> {
    if !node.is_object() || depth > MAX_DEPTH {
        return vec![];
    }
    let kids = || clean_children(node, depth, in_private);
    let one = |n: Node| vec![n];
    match node.get("type").and_then(Value::as_str).unwrap_or("") {
        "privateSection" => {
            let content = clean_children(node, depth, true);
            if in_private {
                return content;
            }
            if content.is_empty() {
                return vec![];
            }
            let audience = node
                .get("attrs")
                .and_then(|a| a.get("audience"))
                .and_then(clean_audience)
                .unwrap_or_default();
            one(Node::PrivateSection {
                attrs: PrivateAttrs { audience },
                content,
            })
        }
        "doc" => one(Node::Doc { content: kids() }),
        "paragraph" => one(Node::Paragraph { content: kids() }),
        "bulletList" => one(Node::BulletList { content: kids() }),
        "listItem" => one(Node::ListItem { content: kids() }),
        "blockquote" => one(Node::Blockquote { content: kids() }),
        "table" => one(Node::Table { content: kids() }),
        "tableRow" => one(Node::TableRow { content: kids() }),
        "tableHeader" => one(Node::TableHeader { content: kids() }),
        "tableCell" => one(Node::TableCell { content: kids() }),
        "codeBlock" => one(Node::CodeBlock { content: kids() }),
        "heading" => {
            let level = crate::http::api::num_of(node.get("attrs").and_then(|a| a.get("level")))
                .filter(|l| *l != 0.0)
                .unwrap_or(1.0);
            one(Node::Heading {
                attrs: HeadingAttrs {
                    level: level.clamp(1.0, 3.0) as u8,
                },
                content: kids(),
            })
        }
        "orderedList" => {
            let start = crate::http::api::num_of(node.get("attrs").and_then(|a| a.get("start")))
                .filter(|s| *s != 0.0)
                .unwrap_or(1.0);
            one(Node::OrderedList {
                attrs: ListAttrs {
                    start: start.floor().max(1.0) as u32,
                },
                content: kids(),
            })
        }
        "horizontalRule" => one(Node::HorizontalRule),
        "hardBreak" => one(Node::HardBreak),
        "text" => clean_text(node).into_iter().collect(),
        "mediaImage" => clean_media(node, false).into_iter().collect(),
        "mediaVideo" => clean_media(node, true).into_iter().collect(),
        // Unknown wrapper: keep what is inside rather than lose the text.
        _ => {
            let has = node
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|c| !c.is_empty());
            if has {
                one(Node::Paragraph { content: kids() })
            } else {
                vec![]
            }
        }
    }
}

/// Clean an incoming document, or refuse it.
pub fn sanitize_doc(doc: &Value) -> Result<Node, String> {
    if doc.get("type").and_then(Value::as_str) != Some("doc") {
        return Err("doc must be a document".into());
    }
    if doc.to_string().len() > DOC_MAX_BYTES {
        return Err(format!("the article is too long ({} KB max)", DOC_MAX_BYTES / 1000));
    }
    Ok(clean_node(doc, 0, false)
        .into_iter()
        .next()
        .unwrap_or(Node::Doc { content: vec![] }))
}

fn walk<'a>(node: &'a Node, f: &mut impl FnMut(&'a Node)) {
    f(node);
    for child in node.children() {
        walk(child, f);
    }
}

/// Every asset an article uses, in document order, each once.
pub fn doc_asset_ids(doc: &Node) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    walk(doc, &mut |n| {
        if let Some(m) = n.media()
            && !ids.contains(&m.asset_id)
        {
            ids.push(m.asset_id.clone());
        }
    });
    ids
}

/// Whether there is anything to show: text, an image, a video or a rule.
pub fn doc_has_content(doc: &Node) -> bool {
    let mut found = false;
    walk(doc, &mut |n| match n {
        Node::Text { text, .. } if !text.trim().is_empty() => found = true,
        Node::MediaImage { .. } | Node::MediaVideo { .. } | Node::HorizontalRule => found = true,
        _ => {}
    });
    found
}

/// Plain text of the first block with any, for the admin list.
pub fn doc_summary(doc: &Node, max: usize) -> String {
    for block in doc.children() {
        let mut parts = String::new();
        walk(block, &mut |n| {
            if let Node::Text { text, .. } = n {
                parts.push_str(text);
            }
        });
        let text = parts.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            return text.chars().take(max).collect();
        }
    }
    String::new()
}

/// A run of ordinary blocks, or one top-level video.
#[derive(Debug, Clone, PartialEq)]
pub enum Section<'a> {
    Flow(Vec<&'a Node>),
    Video(&'a MediaAttrs),
}

/// Split an article at its top-level videos. The renderer lays each piece
/// out separately so it knows exactly where every video sits, and pauses the
/// scroll there. A video nested in a list or quote stays a still poster.
pub fn doc_sections(doc: &Node) -> Vec<Section<'_>> {
    let mut out = Vec::new();
    let mut flow: Vec<&Node> = Vec::new();
    for node in doc.children() {
        if let Node::MediaVideo { attrs } = node {
            if !flow.is_empty() {
                out.push(Section::Flow(std::mem::take(&mut flow)));
            }
            out.push(Section::Video(attrs));
        } else {
            flow.push(node);
        }
    }
    if !flow.is_empty() {
        out.push(Section::Flow(flow));
    }
    out
}

/// Resolve every private section for one viewer: unwrapped where `can_see`,
/// removed otherwise. The result is a plain document.
pub fn filter_private(doc: &Node, can_see: &impl Fn(&Audience) -> bool) -> Node {
    fn resolve(node: &Node, can_see: &impl Fn(&Audience) -> bool) -> Vec<Node> {
        if let Node::PrivateSection { attrs, content } = node {
            return if can_see(&attrs.audience) {
                content.iter().flat_map(|c| resolve(c, can_see)).collect()
            } else {
                vec![]
            };
        }
        let mut copy = node.clone();
        if let Some(kids) = copy.children_mut() {
            *kids = node.children().iter().flat_map(|c| resolve(c, can_see)).collect();
        }
        vec![copy]
    }
    resolve(doc, can_see)
        .into_iter()
        .next()
        .unwrap_or(Node::Doc { content: vec![] })
}

/// The private sections' audiences, in document order.
pub fn private_sections(doc: &Node) -> Vec<&Audience> {
    let mut out = Vec::new();
    walk(doc, &mut |n| {
        if let Node::PrivateSection { attrs, .. } = n {
            out.push(&attrs.audience);
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: Value) -> Node {
        sanitize_doc(&v).unwrap()
    }

    #[test]
    fn keeps_exactly_what_the_tv_can_draw() {
        let doc = parse(json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"level": 7, "id": "x"}, "content": [{"type": "text", "text": "Заголовок"}]},
            {"type": "paragraph", "content": [
                {"type": "text", "text": "жирный", "marks": [{"type": "bold"}]},
                {"type": "text", "text": " и подчёркнутый", "marks": [{"type": "underline"}, {"type": "italic"}]},
                {"type": "hardBreak"}]},
            {"type": "orderedList", "attrs": {"start": "3"}, "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "пункт"}]}]}]},
            {"type": "mediaImage", "attrs": {"assetId": "abc123def456", "size": "gigantic", "caption": format!("  {} ", "x".repeat(300))}},
            {"type": "iframe", "attrs": {"src": "http://evil"}},
            {"type": "details", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "внутри неизвестного блока"}]}]},
            {"type": "mediaImage", "attrs": {"assetId": "../../etc/passwd"}}
        ]}));
        let c = doc.children();
        assert_eq!(c.len(), 5);
        assert!(matches!(
            c[0],
            Node::Heading {
                attrs: HeadingAttrs { level: 3 },
                ..
            }
        ));
        let Node::Paragraph { content } = &c[1] else { panic!() };
        assert!(matches!(&content[1], Node::Text { marks, .. } if marks == &[Mark::Italic]));
        assert!(matches!(content[2], Node::HardBreak));
        assert!(matches!(
            c[2],
            Node::OrderedList {
                attrs: ListAttrs { start: 3 },
                ..
            }
        ));
        let Node::MediaImage { attrs } = &c[3] else { panic!() };
        assert_eq!((attrs.size, attrs.caption.chars().count()), (MediaSize::Full, 200));
        assert!(serde_json::to_string(&c[4]).unwrap().contains("внутри"));
        // Round-trips as TipTap JSON.
        let v = serde_json::to_value(&doc).unwrap();
        assert_eq!(
            v["content"][0],
            json!({"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "Заголовок"}]})
        );
        assert_eq!(serde_json::from_value::<Node>(v).unwrap(), doc);
    }

    #[test]
    fn refuses_non_documents_and_huge_ones() {
        assert!(sanitize_doc(&Value::Null).is_err());
        assert!(sanitize_doc(&json!({"type": "paragraph"})).is_err());
        let huge = json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x".repeat(DOC_MAX_BYTES)}]}]});
        assert!(sanitize_doc(&huge).unwrap_err().contains("too long"));
    }

    fn img(id: &str) -> Value {
        json!({"type": "mediaImage", "attrs": {"assetId": id, "size": "half", "caption": "Фото"}})
    }
    fn vid(id: &str) -> Value {
        json!({"type": "mediaVideo", "attrs": {"assetId": id, "size": "full", "caption": ""}})
    }
    fn p(text: &str) -> Value {
        json!({"type": "paragraph", "content": [{"type": "text", "text": text}]})
    }
    fn private(audience: Value, content: Vec<Value>) -> Value {
        json!({"type": "privateSection", "attrs": {"audience": audience}, "content": content})
    }

    #[test]
    fn assets_content_summary_sections() {
        let doc = parse(
            json!({"type": "doc", "content": [img("img111111"), {"type": "bulletList", "content": [{"type": "listItem", "content": [vid("vid222222")]}]}, img("img111111"), vid("vid333333")]}),
        );
        assert_eq!(doc_asset_ids(&doc), ["img111111", "vid222222", "vid333333"]);
        assert!(!doc_has_content(&empty_doc()));
        assert!(!doc_has_content(&parse(json!({"type": "doc", "content": [p("   ")]}))));
        assert!(doc_has_content(&parse(
            json!({"type": "doc", "content": [p("Привет")]})
        )));
        let s = parse(
            json!({"type": "doc", "content": [img("img111111"), {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Как "}, {"type": "text", "text": "настроить", "marks": [{"type": "bold"}]}]}]}),
        );
        assert_eq!(doc_summary(&s, 90), "Как настроить");
        let d = parse(
            json!({"type": "doc", "content": [p("до"), vid("vid111111"), vid("vid222222"), p("после"), {"type": "blockquote", "content": [vid("vid333333")]}]}),
        );
        let kinds: Vec<&str> = doc_sections(&d)
            .iter()
            .map(|s| if matches!(s, Section::Flow(_)) { "flow" } else { "video" })
            .collect();
        assert_eq!(kinds, ["flow", "video", "video", "flow"]);
        assert!(matches!(&doc_sections(&d)[3], Section::Flow(n) if n.len() == 2));
    }

    #[test]
    fn private_sections_clean_and_resolve() {
        let doc = parse(json!({"type": "doc", "content": [
            private(json!({"users": ["4", 4], "plans": ["pro"], "extra": 1}), vec![p("для своих"), private(json!({"users": [9]}), vec![p("вложенный")])]),
            private(Value::Null, vec![p("без аудитории")]),
            private(json!({"users": [1]}), vec![])
        ]}));
        let c = doc.children();
        assert_eq!(c.len(), 2);
        let Node::PrivateSection { attrs, content } = &c[0] else {
            panic!()
        };
        assert_eq!(
            attrs.audience,
            Audience {
                users: vec![4],
                plans: vec!["pro".into()]
            }
        );
        assert_eq!(content.len(), 2);
        let Node::PrivateSection { attrs, .. } = &c[1] else {
            panic!()
        };
        assert_eq!(attrs.audience, Audience::default());

        let doc = parse(
            json!({"type": "doc", "content": [p("для всех"), private(json!({"users": [1], "plans": []}), vec![p("секрет"), vid("vid111111")]), {"type": "blockquote", "content": [private(json!({"users": [2], "plans": []}), vec![p("цитата")])]}]}),
        );
        let member = filter_private(&doc, &|a| a.users.contains(&1));
        let types: Vec<String> = member
            .children()
            .iter()
            .map(|n| serde_json::to_value(n).unwrap()["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(types, ["paragraph", "paragraph", "mediaVideo", "blockquote"]);
        assert!(member.children()[3].children().is_empty());
        assert_eq!(doc_sections(&member).len(), 3);
        let outsider = filter_private(&doc, &|_| false);
        assert_eq!(outsider.children().len(), 2);
        assert!(!serde_json::to_string(&outsider).unwrap().contains("секрет"));
        assert_eq!(private_sections(&doc).len(), 2);
    }
}
