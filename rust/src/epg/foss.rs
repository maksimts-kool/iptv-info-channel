//! OTT-play FOSS JSON guide and match-protocol helpers. Pure logic, no I/O.
//!
//! Two different hashes, and getting either wrong means silently no EPG:
//! [`foss_id_hash`] names `epg/<hash>.json` (xxhash32 of the LOWERCASED
//! tvg-id); [`foss_url_hash`] fills `meta.url-hashes` (xxhash32 of `url-tvg`
//! with the scheme cut off and NO case folding). Both are pinned against
//! OTT-play's live reference providers — re-verify before touching them.

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};

use super::epg::{EpgOptions, day_start_unix, each_epg_day, epg_channel_id};
use super::xxhash32::xxhash32;
use crate::core::util::xml_escape;
use crate::data::model::DecoratedUser;
use crate::regex;

const DEFAULT_PROVIDER_ID: &str = "infochannel";
pub const MATCH_BLOCK_SEP: &str = "\n\t\n";
const FIELD_SEP: char = '¦';

pub fn normalize_foss_provider_id(value: &str) -> String {
    let id = value.trim().trim_start_matches('=');
    let id = if id.is_empty() { DEFAULT_PROVIDER_ID } else { id };
    if regex!(r"^[A-Za-z0-9._-]+$").is_match(id) { id.to_owned() } else { DEFAULT_PROVIDER_ID.to_owned() }
}

/// The channel-id hash a programme file is looked up by.
pub fn foss_id_hash(token: &str) -> u32 {
    xxhash32(&epg_channel_id(token).to_lowercase())
}

/// The binding hash of a `url-tvg`: scheme cut off, case preserved.
pub fn foss_url_hash(url: &str) -> u32 {
    let cut = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).unwrap_or(url);
    xxhash32(cut)
}

pub fn build_foss_channels_json(
    user: &DecoratedUser,
    opts: &EpgOptions<'_>,
    provider_id: &str,
    epg_urls: &[String],
    logo_url: &str,
) -> Value {
    let name = format!("{} — {}", opts.brand, user.username);
    let days = each_epg_day(user, opts);
    let now_unix = opts.now.as_second();
    // channels.json only needs the latest programme start (the top of the guide).
    let top = days.last().map_or(now_unix, |d| day_start_unix(d.date, opts.tz));
    let id_hash = foss_id_hash(&user.token).to_string();
    let hashes: Vec<u32> = epg_urls.iter().filter(|u| !u.is_empty()).map(|u| foss_url_hash(u)).collect();
    let mut data = serde_json::Map::new();
    data.insert(
        id_hash,
        json!([format!("{}{FIELD_SEP}{top}{FIELD_SEP}{logo_url}", epg_channel_id(&user.token)), name]),
    );
    json!({
        "meta": {
            "id": normalize_foss_provider_id(provider_id),
            "url-hashes": hashes,
            "last-upd": now_unix,
            "last-epg": top,
        },
        "data": data,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct FossProgramme {
    pub name: String,
    pub descr: String,
    pub time: i64,
    pub time_to: i64,
}

/// OTT-play shows `name` in the list and `descr` in the details — the same
/// roles XMLTV gives title/desc, so both guides render identical day records.
pub fn build_foss_epg_json(user: &DecoratedUser, opts: &EpgOptions<'_>) -> Value {
    let programmes: Vec<FossProgramme> = each_epg_day(user, opts)
        .into_iter()
        .map(|d| FossProgramme {
            time: day_start_unix(d.date, opts.tz),
            time_to: day_start_unix(d.next, opts.tz),
            name: d.title,
            descr: d.desc,
        })
        .collect();
    json!({ "epg_data": programmes })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchChannel {
    pub key: String,
    pub tvg_id_hash: String,
    pub tvg_name_hash: String,
    pub name_hash: String,
}

#[derive(Debug, Clone)]
pub struct MatchRequest {
    pub metadata: String,
    pub tvg_urls: String,
    pub channels: Vec<MatchChannel>,
}

fn is_u32(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && s.parse::<u32>().is_ok()
}

pub fn parse_match_request(body: &str) -> Option<MatchRequest> {
    let blocks: Vec<&str> = body.split(MATCH_BLOCK_SEP).collect();
    let [metadata, tvg_urls, list] = blocks.as_slice() else { return None };
    let channels = list
        .split('\n')
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let data = line.split('~').next().unwrap_or("");
            let f: Vec<&str> = data.split('-').collect();
            match f.as_slice() {
                [k, a, b, c] if f.iter().all(|x| is_u32(x)) => Some(MatchChannel {
                    key: (*k).to_owned(),
                    tvg_id_hash: (*a).to_owned(),
                    tvg_name_hash: (*b).to_owned(),
                    name_hash: (*c).to_owned(),
                }),
                _ => None,
            }
        })
        .collect();
    Some(MatchRequest { metadata: (*metadata).to_owned(), tvg_urls: (*tvg_urls).to_owned(), channels })
}

/// A matched local channel: its id hash plus the provider URL for its owner.
#[derive(Debug, Clone)]
pub struct MatchHit {
    pub id_hash: String,
    pub provider_url: String,
}

pub fn build_match_channels_response(
    channels: &[MatchChannel],
    mut resolve: impl FnMut(&MatchChannel) -> Option<MatchHit>,
    provider_id: &str,
) -> String {
    let id = normalize_foss_provider_id(provider_id);
    let mut matched = Vec::new();
    let mut provider_url = String::new();
    for channel in channels {
        let Some(hit) = resolve(channel) else { continue };
        matched.push(format!("{}~{id}~{}", channel.key, hit.id_hash));
        if provider_url.is_empty() {
            provider_url = hit.provider_url;
        }
    }
    let providers = if provider_url.is_empty() { String::new() } else { format!("{id}~{provider_url}") };
    ["{}".to_owned(), matched.join("\n"), providers].join(MATCH_BLOCK_SEP)
}

pub fn empty_channel_match_response() -> String {
    ["{}", "", ""].join(MATCH_BLOCK_SEP)
}

/// The shipped client and upstream Go server use two blocks for match-logos.
pub fn empty_logo_match_response() -> String {
    ["{}", ""].join(MATCH_BLOCK_SEP)
}

/// Merge our local match answer into the upstream OTT-play one; local wins by
/// channel key, and only providers still referenced are kept.
pub fn merge_match_channels_responses(local: &str, upstream: &str) -> String {
    let lb: Vec<&str> = local.split(MATCH_BLOCK_SEP).collect();
    let ub: Vec<&str> = upstream.split(MATCH_BLOCK_SEP).collect();
    if lb.len() != 3 {
        return if ub.len() == 3 { upstream } else { local }.to_owned();
    }
    if ub.len() != 3 {
        return local.to_owned();
    }

    let mut channels: IndexMap<String, String> = IndexMap::new();
    let mut providers: IndexMap<String, String> = IndexMap::new();
    let mut add_channels = |block: &str, overwrite: bool| {
        for line in block.split('\n').filter(|l| !l.is_empty()) {
            let key = line.split('~').next().unwrap_or("");
            if key.is_empty() || (!overwrite && channels.contains_key(key)) {
                continue;
            }
            channels.insert(key.to_owned(), line.to_owned());
        }
    };
    add_channels(ub[1], false);
    add_channels(lb[1], true);
    let mut add_providers = |block: &str, overwrite: bool| {
        for line in block.split('\n').filter(|l| !l.is_empty()) {
            let Some(sep) = line.find('~').filter(|s| *s >= 1) else { continue };
            let id = &line[..sep];
            if !overwrite && providers.contains_key(id) {
                continue;
            }
            providers.insert(id.to_owned(), line.to_owned());
        }
    };
    add_providers(ub[2], false);
    add_providers(lb[2], true);

    let used: Vec<&str> = channels.values().filter_map(|l| l.split('~').nth(1)).filter(|s| !s.is_empty()).collect();
    let chan_block = channels.values().cloned().collect::<Vec<_>>().join("\n");
    let prov_block =
        providers.iter().filter(|(id, _)| used.contains(&id.as_str())).map(|(_, l)| l.clone()).collect::<Vec<_>>().join("\n");
    ["{}".to_owned(), chan_block, prov_block].join(MATCH_BLOCK_SEP)
}

pub fn build_foss_logo_svg(brand: &str) -> String {
    let brand = if brand.is_empty() { "IPTV" } else { brand };
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0b1224"/>
  <circle cx="256" cy="206" r="94" fill="#38bdf8"/>
  <rect x="226" y="292" width="60" height="104" rx="30" fill="#e6edf7"/>
  <text x="256" y="466" fill="#e6edf7" font-family="Arial,sans-serif" font-size="36" text-anchor="middle">{}</text>
</svg>"##,
        xml_escape(brand)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::model::Incident;
    use crate::epg::epg::tests::{ivan, now, opts, tz};

    const EPG_URL: &str = "https://iptv.example/u/abc123/epg.xml";
    const LOGO_URL: &str = "https://iptv.example/foss-epg/u/abc123/logo.svg";

    #[test]
    fn id_hash_uses_tvg_id() {
        assert_eq!(foss_id_hash("abc123"), 463_191_053);
    }

    #[test]
    fn url_hashes_reproduce_reference_providers() {
        assert_eq!(foss_url_hash("https://iptvx.one/EPG"), 2_853_413_468);
        assert_eq!(foss_url_hash("http://iptvx.one/EPG"), 2_853_413_468);
        assert_eq!(foss_url_hash("iptvx.one/EPG"), 2_853_413_468);
        assert_ne!(foss_url_hash("https://iptvx.one/epg"), 2_853_413_468);
    }

    #[test]
    fn channels_json_binds_provider() {
        let tz = tz();
        let json = build_foss_channels_json(&ivan(), &opts(&tz, &[], 2, 1), "custom-provider", &[EPG_URL.into()], LOGO_URL);
        let id = foss_id_hash("abc123").to_string();
        assert_eq!(json["meta"]["id"], "custom-provider");
        let last = json["meta"]["last-epg"].as_i64().unwrap();
        assert!(last > now().as_second());
        assert_eq!(json["meta"]["url-hashes"], json!([foss_url_hash(EPG_URL)]));
        assert_eq!(json["data"][&id][0], format!("account-abc123¦{last}¦{LOGO_URL}"));
        assert_eq!(json["data"][&id][1], "TestIPTV — ivan");
        assert_eq!(json["data"].as_object().unwrap().len(), 1);
    }

    fn current(json: &Value) -> &Value {
        let t = now().as_second();
        json["epg_data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["time"].as_i64().unwrap() <= t && p["time_to"].as_i64().unwrap() > t)
            .unwrap()
    }

    #[test]
    fn epg_json_carries_status() {
        let tz = tz();
        let json = build_foss_epg_json(&ivan(), &opts(&tz, &[], 2, 1));
        let progs = json["epg_data"].as_array().unwrap();
        assert_eq!(progs.len(), 4);
        current(&json);
        for p in progs {
            let name = p["name"].as_str().unwrap();
            let descr = p["descr"].as_str().unwrap();
            assert!(regex!(r"^✓ Подписка активна · ещё \d+ дн[а-я]+$").is_match(name), "{name}");
            assert!(descr.contains("Тариф: Базовый · 4,99 €/мес."));
            assert!(descr.contains("Статус сервиса: ✓ Все сервисы работают"));
        }
    }

    #[test]
    fn epg_json_folds_outage() {
        let tz = tz();
        let incs = [Incident {
            severity: "outage".into(),
            title: "CDN outage".into(),
            starts_on: Some("2026-06-13".into()),
            ..Incident::default()
        }];
        let json = build_foss_epg_json(&ivan(), &opts(&tz, &incs, 2, 1));
        let cur = current(&json);
        assert!(regex!(r"^✕ Сбой сервиса · Подписка активна").is_match(cur["name"].as_str().unwrap()));
        assert!(cur["descr"].as_str().unwrap().contains("Сбой (с 13 июн 2026, сейчас): CDN outage"));
    }

    #[test]
    fn match_envelope() {
        let hash = foss_id_hash("abc123").to_string();
        let body = ["{}".to_owned(), "https://example.test/epg.xml".to_owned(), format!("42-{hash}-0-0~99-100")]
            .join(MATCH_BLOCK_SEP);
        let parsed = parse_match_request(&body).unwrap();
        assert_eq!(
            parsed.channels,
            [MatchChannel { key: "42".into(), tvg_id_hash: hash.clone(), tvg_name_hash: "0".into(), name_hash: "0".into() }]
        );
        let resp = build_match_channels_response(
            &parsed.channels,
            |c| {
                (c.tvg_id_hash == hash).then(|| MatchHit {
                    id_hash: hash.clone(),
                    provider_url: "https://example.test/foss-epg/u/abc123/".into(),
                })
            },
            "custom-provider",
        );
        assert_eq!(
            resp.split(MATCH_BLOCK_SEP).collect::<Vec<_>>(),
            ["{}", &format!("42~custom-provider~{hash}"), "custom-provider~https://example.test/foss-epg/u/abc123/"]
        );
        assert!(parse_match_request("garbage").is_none());
        let req = parse_match_request(&["{}", "", "42-123-0-0"].join(MATCH_BLOCK_SEP)).unwrap();
        assert_eq!(build_match_channels_response(&req.channels, |_| None, "infochannel"), empty_channel_match_response());
        assert_eq!(empty_logo_match_response().split(MATCH_BLOCK_SEP).count(), 2);
    }

    #[test]
    fn merge_local_wins() {
        let local = ["{}", "42~infochannel~2554912436", "infochannel~https://iptv.example/foss-epg/u/abc123/"].join(MATCH_BLOCK_SEP);
        let upstream = ["{}", "7~edem~100\n42~wrong~999", "edem~https://epg.ottp.eu.org/edem/\nwrong~https://example.test/"]
            .join(MATCH_BLOCK_SEP);
        assert_eq!(
            merge_match_channels_responses(&local, &upstream).split(MATCH_BLOCK_SEP).collect::<Vec<_>>(),
            [
                "{}",
                "7~edem~100\n42~infochannel~2554912436",
                "edem~https://epg.ottp.eu.org/edem/\ninfochannel~https://iptv.example/foss-epg/u/abc123/"
            ]
        );
    }
}
