//! The customer's `.m3u`: the curated channel list, led by this server's own
//! info channel. Pure — the resolution (plan, pins, expiry gate) happens
//! before, in `playlist::model`.

use super::enc;
use crate::epg::epg::epg_channel_id;
use crate::epg::foss::normalize_foss_provider_id;
use crate::playlist::hls::is_hls_url;
use crate::playlist::m3u::{Attrs, OutItem, build_m3u};
use crate::playlist::model::{Channel, Entry, INFO_CHANNEL_ID, INFO_MEDIA_CHANNEL_ID, INFO_MEDIA_DEFAULT_NAME};

/// Everything the builder reads from the config.
#[derive(Debug, Clone)]
pub struct PlaylistCfg<'a> {
    pub base_url: &'a str,
    pub epg_enabled: bool,
    pub foss_enabled: bool,
    pub foss_provider_id: &'a str,
    pub gateway_enabled: bool,
}

pub fn foss_provider_base_url(token: &str, base: &str) -> String {
    format!("{base}/foss-epg/u/{}/", enc(token))
}

/// The `url-tvg` — built once here because the `.m3u` and the FOSS
/// `channels.json` must agree on it character for character (OTT-play binds
/// the guide by hashing it).
pub fn user_epg_url(token: &str, base: &str) -> String {
    format!("{base}/u/{}/epg.xml", enc(token))
}

pub fn foss_logo_url(token: &str, base: &str) -> String {
    format!("{}logo.svg", foss_provider_base_url(token, base))
}

/// The `=`-prefixed `foss-tvg` target. OTT-play appends `<hash>.json` to it
/// verbatim, so it must name the `epg/` directory itself.
pub fn foss_epg_dir_url(token: &str, base: &str) -> String {
    format!("{}epg/", foss_provider_base_url(token, base))
}

/// The customer's own info loop — also the gateway's fallback.
pub fn user_stream_url(token: &str, base: &str) -> String {
    format!("{base}/hls/{}/index.m3u8", enc(token))
}

pub fn media_stream_url(token: &str, base: &str) -> String {
    format!("{base}/m/{}/index.m3u8", enc(token))
}

pub fn notice_stream_url(base: &str) -> String {
    format!("{base}/notice/devices/index.m3u8")
}

/// Where the `.m3u` points for one imported channel: the provider URL, or —
/// with the gateway on and an HLS channel — the per-customer gate link. Only
/// HLS is gated (a raw TS stream would need a cross-protocol redirect Android
/// players refuse). The `.m3u8` ending is load-bearing: ExoPlayer picks its
/// media source from the URL extension.
pub fn channel_stream_url(token: &str, channel: &Channel, cfg: &PlaylistCfg<'_>, device_tag: &str) -> String {
    if !cfg.gateway_enabled || channel.builtin || channel.url.is_empty() || !is_hls_url(&channel.url) {
        return channel.url.clone();
    }
    let tag = if device_tag.is_empty() { String::new() } else { format!("{}/", enc(device_tag)) };
    format!("{}/c/{}/{tag}{}.m3u8", cfg.base_url, enc(token), enc(&channel.id))
}

/// Render the resolved entries as the customer's playlist.
pub fn build_user_playlist(
    token: &str,
    username: &str,
    brand: &str,
    cfg: &PlaylistCfg<'_>,
    entries: &[Entry<'_>],
    epg_urls: &[String],
    device_tag: &str,
) -> String {
    let base = cfg.base_url;
    let foss = cfg.epg_enabled && cfg.foss_enabled;
    let provider = normalize_foss_provider_id(cfg.foss_provider_id);

    let mut header = Attrs::new();
    if cfg.epg_enabled {
        // Ours first; a provider's own guide follows comma-separated.
        let urls: Vec<String> = std::iter::once(user_epg_url(token, base)).chain(epg_urls.iter().cloned()).collect();
        header.insert("url-tvg".into(), urls.join(","));
    }
    if foss {
        // The leading "=" takes the channel out of OTT-play's central match.
        header.insert("foss-tvg".into(), format!("={provider}::{}", foss_epg_dir_url(token, base)));
    }

    let info_url = user_stream_url(token, base);
    let media_url = media_stream_url(token, base);
    let urls: Vec<String> = entries
        .iter()
        .map(|e| match e.channel.id.as_str() {
            INFO_CHANNEL_ID => info_url.clone(),
            INFO_MEDIA_CHANNEL_ID => media_url.clone(),
            _ => channel_stream_url(token, e.channel, cfg, device_tag),
        })
        .collect();
    let names: Vec<String> = entries
        .iter()
        .map(|e| match e.channel.id.as_str() {
            INFO_CHANNEL_ID if e.channel.name.is_empty() => format!("{brand} — {username}"),
            INFO_MEDIA_CHANNEL_ID if e.channel.name.is_empty() => INFO_MEDIA_DEFAULT_NAME.to_owned(),
            _ => e.channel.name.clone(),
        })
        .collect();

    let items: Vec<OutItem<'_>> = entries
        .iter()
        .zip(urls.iter().zip(&names))
        .map(|(e, (url, name))| {
            let mut attrs = Attrs::new();
            let group = e.category.name.clone();
            match e.channel.id.as_str() {
                INFO_CHANNEL_ID => {
                    // Attribute order is deliberate (pinned by a test).
                    attrs.insert("tvg-id".into(), epg_channel_id(token));
                    if foss {
                        attrs.insert("tvg-source".into(), format!("={provider}"));
                    }
                    attrs.insert("tvg-name".into(), name.clone());
                    if foss {
                        attrs.insert("tvg-logo".into(), foss_logo_url(token, base));
                    }
                    attrs.insert("group-title".into(), group);
                    OutItem { name, url, duration: None, attrs, extras: &[] }
                }
                INFO_MEDIA_CHANNEL_ID => {
                    attrs.insert("tvg-name".into(), name.clone());
                    attrs.insert("group-title".into(), group);
                    OutItem { name, url, duration: None, attrs, extras: &[] }
                }
                _ => {
                    attrs.clone_from(&e.channel.attrs);
                    attrs.insert("group-title".into(), group);
                    OutItem { name, url, duration: None, attrs, extras: &e.channel.extras }
                }
            }
        })
        .collect();
    build_m3u(&items, &header)
}

/// `Content-Disposition` for the download: an ASCII fallback plus the RFC
/// 5987 UTF-8 form (customer names are usually Cyrillic).
pub fn playlist_disposition(username: &str) -> String {
    let name = format!("{}.m3u", if username.is_empty() { "playlist" } else { username });
    let ascii: String =
        name.chars().map(|c| if (' '..='~').contains(&c) && c != '"' && c != '\\' { c } else { '_' }).collect();
    format!("inline; filename=\"{ascii}\"; filename*=UTF-8''{}", enc(&name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::foss::foss_id_hash;
    use crate::playlist::model::{Category, INFO_CATEGORY_ID};

    fn cfg(foss: bool, gateway: bool) -> PlaylistCfg<'static> {
        PlaylistCfg { base_url: "https://iptv.example", epg_enabled: true, foss_enabled: foss, foss_provider_id: "infochannel", gateway_enabled: gateway }
    }

    fn cat(id: &str, name: &str) -> Category {
        Category { id: id.into(), key: id.into(), name: name.into(), source_name: None, enabled: true, builtin: false, custom: false, sort: 0 }
    }

    fn channel(id: &str, name: &str, url: &str) -> Channel {
        Channel {
            id: id.into(),
            key: id.into(),
            source_id: None,
            category_id: String::new(),
            name: name.into(),
            original_name: String::new(),
            upstream_group: None,
            url: url.into(),
            attrs: Attrs::new(),
            extras: vec![],
            enabled: true,
            builtin: false,
            custom: false,
            missing: false,
            sort: 0,
            added_at: None,
        }
    }

    fn build(c: &PlaylistCfg<'_>, extra: &[(Channel, Category)], epg: &[String], brand: &str) -> String {
        let info_cat = cat(INFO_CATEGORY_ID, "Информация");
        let info = Channel { builtin: true, ..channel(INFO_CHANNEL_ID, "", "") };
        let mut entries = vec![Entry { channel: &info, category: &info_cat }];
        entries.extend(extra.iter().map(|(ch, ca)| Entry { channel: ch, category: ca }));
        build_user_playlist("abc123", "ivan", brand, c, &entries, epg, "")
    }

    #[test]
    fn foss_static_mode() {
        let p = build(&cfg(true, false), &[], &[], "TestIPTV");
        assert!(p.contains(r#"foss-tvg="=infochannel::https://iptv.example/foss-epg/u/abc123/epg/""#));
        assert!(p.contains(r#"tvg-source="=infochannel""#));
        assert!(p.contains(r#"tvg-logo="https://iptv.example/foss-epg/u/abc123/logo.svg""#));
        let src = crate::regex!(r#"foss-tvg="=infochannel::([^"]+)""#).captures(&p).unwrap()[1].to_owned();
        assert_eq!(format!("{src}{}.json", foss_id_hash("abc123")), "https://iptv.example/foss-epg/u/abc123/epg/463191053.json");
        let off = build(&cfg(false, false), &[], &[], "x");
        assert!(!off.contains("foss-tvg") && !off.contains("tvg-source") && !off.contains("tvg-logo"));
        assert!(off.contains("url-tvg="));
    }

    #[test]
    fn info_and_catalog_entries() {
        let mut ch = channel("ch1", "Спорт 1 HD", "http://provider/live/1.ts");
        ch.original_name = "SPORT 1 [RAW]".into();
        ch.attrs.insert("tvg-id".into(), "sport1".into());
        ch.attrs.insert("tvg-logo".into(), "http://provider/1.png".into());
        ch.extras = vec!["#EXTVLCOPT:http-user-agent=Mozilla".into()];
        let p = build(&cfg(true, false), &[(ch, cat("c1", "Спорт"))], &["http://provider/epg.xml.gz".into()], "TestIPTV");
        assert!(p.contains(",TestIPTV — ivan\n"));
        assert!(p.contains("\nhttps://iptv.example/hls/abc123/index.m3u8\n"));
        assert!(p.contains(r#"#EXTINF:-1 tvg-id="sport1" tvg-logo="http://provider/1.png" group-title="Спорт",Спорт 1 HD"#));
        assert!(!p.contains("SPORT 1 [RAW]"));
        assert!(p.contains("#EXTVLCOPT:http-user-agent=Mozilla\nhttp://provider/live/1.ts"));
        assert!(p.contains(r#"url-tvg="https://iptv.example/u/abc123/epg.xml,http://provider/epg.xml.gz""#));
    }

    #[test]
    fn media_channel_and_gateway() {
        let media = Channel { builtin: true, ..channel(INFO_MEDIA_CHANNEL_ID, "", "") };
        let info_cat = cat(INFO_CATEGORY_ID, "Информация");
        let p = build(&cfg(true, true), &[(media.clone(), info_cat.clone())], &[], "x");
        assert!(p.contains("#EXTINF:-1 tvg-name=\"Медиа\" group-title=\"Информация\",Медиа\nhttps://iptv.example/m/abc123/index.m3u8"));
        let renamed = Channel { name: "Инструкции".into(), ..media };
        assert!(build(&cfg(true, false), &[(renamed, info_cat)], &[], "x").contains(",Инструкции\n"));

        let mut hls = channel("ch1", "Спорт 1 HD", "http://provider/live/1.m3u8");
        hls.attrs.insert("tvg-id".into(), "sport1".into());
        let ts = channel("ch2", "Спорт 2", "http://provider/live/2.ts");
        let sport = cat("c1", "Спорт");
        let p = build(&cfg(true, true), &[(hls.clone(), sport.clone()), (ts, sport.clone())], &[], "x");
        let urls: Vec<&str> = p.lines().filter(|l| !l.is_empty() && !l.starts_with('#')).collect();
        assert_eq!(urls, ["https://iptv.example/hls/abc123/index.m3u8", "https://iptv.example/c/abc123/ch1.m3u8", "http://provider/live/2.ts"]);
        assert!(build(&cfg(true, false), &[(hls, sport)], &[], "x").contains("\nhttp://provider/live/1.m3u8\n"));
    }

    #[test]
    fn cyrillic_disposition() {
        let v = playlist_disposition("Тестер \"1\"");
        assert!(v.bytes().all(|b| (0x20..=0x7e).contains(&b)));
        assert!(v.contains("filename=\"______ _1_.m3u\""));
        assert!(v.ends_with("filename*=UTF-8''%D0%A2%D0%B5%D1%81%D1%82%D0%B5%D1%80%20%221%22.m3u"));
    }
}
