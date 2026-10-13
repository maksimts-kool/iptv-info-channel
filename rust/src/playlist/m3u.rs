//! Pure M3U/M3U8 *playlist* parsing and serialization (no I/O, no state).
//!
//! This is the extended-M3U format IPTV providers publish, NOT the HLS media
//! playlists in `encode::liveloop` — don't confuse the two. Provider quirks
//! this handles, because real playlists are messy:
//!   - attribute values may contain commas, so the channel title is split off
//!     at the last comma OUTSIDE quotes;
//!   - the group can arrive as a `group-title` attribute or a separate
//!     `#EXTGRP:` line (attribute wins, EXTGRP fills in);
//!   - per-channel directives (`#EXTVLCOPT` / `#KODIPROP` / `#EXTHTTP`) sit
//!     between the `#EXTINF` and the URL and are load-bearing for playback, so
//!     they are kept verbatim and re-emitted in order;
//!   - BOM, CRLF and blank/comment lines appear everywhere.

use indexmap::IndexMap;

use crate::regex;

/// Ordered attribute map — order is preserved on output, as in the original.
pub type Attrs = IndexMap<String, String>;

/// Directives that belong to the channel that follows and must survive a
/// round-trip (user agents, referers, DRM properties, …).
const PASSTHROUGH_PREFIXES: [&str; 4] = ["#EXTVLCOPT:", "#KODIPROP:", "#EXTHTTP:", "#EXTM3A:"];

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Item {
    pub name: String,
    pub url: String,
    pub duration: String,
    pub attrs: Attrs,
    pub group: String,
    pub extras: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Parsed {
    pub header_attrs: Attrs,
    pub items: Vec<Item>,
    /// `#EXTINF` entries that never got a URL line (truncated downloads).
    pub malformed: usize,
}

/// Parse `key="value"` / `key=value` pairs out of an attribute region.
pub fn parse_attrs(text: &str) -> Attrs {
    let re = regex!(r#"([A-Za-z0-9_-]+)="([^"]*)"|([A-Za-z0-9_-]+)=([^\s,"]+)"#);
    let mut attrs = Attrs::new();
    for c in re.captures_iter(text) {
        let key = c
            .get(1)
            .or_else(|| c.get(3))
            .map_or("", |m| m.as_str())
            .to_lowercase();
        let value = c.get(2).or_else(|| c.get(4)).map_or("", |m| m.as_str());
        attrs.insert(key, value.to_owned());
    }
    attrs
}

/// Byte index of the last comma not inside a double-quoted attribute value.
fn last_top_level_comma(text: &str) -> Option<usize> {
    let mut in_quotes = false;
    let mut index = None;
    for (i, c) in text.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => index = Some(i),
            _ => {}
        }
    }
    index
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extinf {
    pub duration: String,
    pub attrs: Attrs,
    pub title: String,
}

/// Split an `#EXTINF:` payload into duration, attributes and title.
pub fn parse_extinf(payload: &str) -> Extinf {
    let (head, title) = match last_top_level_comma(payload) {
        Some(i) => (&payload[..i], payload[i + 1..].trim()),
        None => (payload, ""),
    };
    let dur = regex!(r"^\s*(-?\d+(?:\.\d+)?)").captures(head);
    let (duration, rest) = match dur {
        Some(c) => (c[1].to_owned(), &head[c[0].len()..]),
        None => ("-1".to_owned(), head),
    };
    Extinf {
        duration,
        attrs: parse_attrs(rest),
        title: title.to_owned(),
    }
}

/// Parse a whole playlist.
pub fn parse_m3u(text: &str) -> Parsed {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut parsed = Parsed::default();
    let mut pending: Option<Item> = None;

    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTM3U") {
            parsed.header_attrs.extend(parse_attrs(rest));
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            // A second #EXTINF before a URL means the previous entry had none.
            if pending.is_some() {
                parsed.malformed += 1;
            }
            let info = parse_extinf(rest);
            pending = Some(Item {
                name: info.title,
                group: info.attrs.get("group-title").cloned().unwrap_or_default(),
                duration: info.duration,
                attrs: info.attrs,
                extras: Vec::new(),
                url: String::new(),
            });
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTGRP:") {
            if let Some(p) = pending.as_mut().filter(|p| p.group.is_empty()) {
                rest.trim().clone_into(&mut p.group);
            }
            continue;
        }
        if PASSTHROUGH_PREFIXES.iter().any(|p| line.starts_with(p)) {
            if let Some(p) = pending.as_mut() {
                p.extras.push(line.to_owned());
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        // A bare URL line closes the pending entry; a URL with no #EXTINF is
        // kept with the URL as its name.
        match pending.take() {
            Some(mut p) => {
                line.clone_into(&mut p.url);
                parsed.items.push(p);
            }
            None => parsed.items.push(Item {
                name: line.to_owned(),
                url: line.to_owned(),
                duration: "-1".to_owned(),
                ..Item::default()
            }),
        }
    }
    if pending.is_some() {
        parsed.malformed += 1;
    }
    parsed
}

fn attr_string<'a>(attrs: impl IntoIterator<Item = (&'a String, &'a String)>) -> String {
    attrs
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        // Values are quoted, so an embedded quote would break the entry — the
        // straight quote becomes a typographic one rather than being dropped.
        .map(|(k, v)| {
            format!(
                "{k}=\"{}\"",
                v.replace('"', "”").replace("\r\n", " ").replace('\n', " ")
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// One entry to serialize.
#[derive(Debug, Clone, Default)]
pub struct OutItem<'a> {
    pub name: &'a str,
    pub url: &'a str,
    pub duration: Option<&'a str>,
    pub attrs: Attrs,
    pub extras: &'a [String],
}

/// Serialize back to extended-M3U text.
pub fn build_m3u(items: &[OutItem<'_>], header_attrs: &Attrs) -> String {
    let header = attr_string(header_attrs);
    let mut out = vec![if header.is_empty() {
        "#EXTM3U".to_owned()
    } else {
        format!("#EXTM3U {header}")
    }];
    for item in items {
        let attrs = attr_string(&item.attrs);
        let name = item.name.replace("\r\n", " ").replace('\n', " ");
        let sep = if attrs.is_empty() { "" } else { " " };
        out.push(format!(
            "#EXTINF:{}{sep}{attrs},{name}",
            item.duration.unwrap_or("-1")
        ));
        out.extend(item.extras.iter().cloned());
        out.push(item.url.to_owned());
    }
    out.push(String::new());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_attrs_quoted_and_bare() {
        let a = parse_attrs(r#"tvg-id="x1" tvg-logo="http://a/b.png?w=1" radio=true"#);
        assert_eq!(a["tvg-id"], "x1");
        assert_eq!(a["tvg-logo"], "http://a/b.png?w=1");
        assert_eq!(a["radio"], "true");
    }

    #[test]
    fn title_split_outside_quotes() {
        let p = parse_extinf(
            r#"-1 tvg-id="a" tvg-name="News, Sport и всё" group-title="Микс",Первый канал"#,
        );
        assert_eq!(p.title, "Первый канал");
        assert_eq!(p.attrs["tvg-name"], "News, Sport и всё");
        assert_eq!(p.attrs["group-title"], "Микс");
        assert_eq!(p.duration, "-1");
    }

    #[test]
    fn reads_header_groups_extras_urls() {
        let text = [
            "\u{feff}#EXTM3U url-tvg=\"http://p/epg.xml\" x-tvg-url=\"http://p/other.xml\"",
            "",
            "# a comment",
            "#EXTINF:-1 tvg-id=\"s1\" tvg-logo=\"http://p/1.png\" group-title=\"Спорт\",Sport 1",
            "#EXTVLCOPT:http-user-agent=VLC",
            "#KODIPROP:inputstream=ffmpeg",
            "http://p/live/1.ts",
            "#EXTINF:-1 tvg-id=\"n1\",News 1",
            "#EXTGRP:Новости",
            "http://p/live/2.ts",
        ]
        .join("\r\n");
        let p = parse_m3u(&text);
        assert_eq!(p.malformed, 0);
        assert_eq!(p.header_attrs["url-tvg"], "http://p/epg.xml");
        assert_eq!(p.items.len(), 2);
        assert_eq!(
            p.items[0].extras,
            [
                "#EXTVLCOPT:http-user-agent=VLC",
                "#KODIPROP:inputstream=ffmpeg"
            ]
        );
        assert_eq!(p.items[0].group, "Спорт");
        assert_eq!(p.items[0].name, "Sport 1");
        assert_eq!(p.items[0].url, "http://p/live/1.ts");
        assert_eq!(p.items[1].group, "Новости");
    }

    #[test]
    fn group_title_beats_extgrp() {
        let p = parse_m3u(
            "#EXTM3U\n#EXTINF:-1 group-title=\"Кино\",Film\n#EXTGRP:Другое\nhttp://p/3.ts",
        );
        assert_eq!(p.items[0].group, "Кино");
    }

    #[test]
    fn counts_entries_without_url() {
        let p = parse_m3u("#EXTM3U\n#EXTINF:-1,A\n#EXTINF:-1,B\nhttp://p/b.ts\n#EXTINF:-1,C");
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].name, "B");
        assert_eq!(p.malformed, 2);
    }

    #[test]
    fn bare_url_is_imported() {
        let p = parse_m3u("#EXTM3U\nhttp://p/bare.ts\n");
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].url, "http://p/bare.ts");
        assert_eq!(p.items[0].name, "http://p/bare.ts");
    }

    #[test]
    fn round_trips() {
        let text = "#EXTM3U url-tvg=\"http://p/epg.xml\"\n#EXTINF:-1 tvg-id=\"s1\" group-title=\"Спорт\",Sport 1\n#EXTVLCOPT:http-user-agent=VLC\nhttp://p/live/1.ts\n";
        let p = parse_m3u(text);
        let items: Vec<OutItem<'_>> = p
            .items
            .iter()
            .map(|i| OutItem {
                name: &i.name,
                url: &i.url,
                duration: Some(&i.duration),
                attrs: i.attrs.clone(),
                extras: &i.extras,
            })
            .collect();
        assert_eq!(build_m3u(&items, &p.header_attrs), text);
    }

    #[test]
    fn drops_empty_attrs_neutralises_quotes() {
        let mut attrs = Attrs::new();
        attrs.insert("tvg-id".into(), String::new());
        attrs.insert("group-title".into(), "G".into());
        let out = build_m3u(
            &[OutItem {
                name: "A \"quoted\" name",
                url: "http://a",
                attrs,
                ..OutItem::default()
            }],
            &Attrs::new(),
        );
        assert_eq!(
            out,
            "#EXTM3U\n#EXTINF:-1 group-title=\"G\",A \"quoted\" name\nhttp://a\n"
        );
    }
}
