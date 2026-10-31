//! Provider HLS manifests, as handled by the stream gateway.
//!
//! NOT the provider *channel list* (`m3u`) and NOT the info channel's own
//! media playlist (`encode::liveloop`): this only rewrites a manifest fetched
//! from a provider before handing it to a customer's player.
//!
//! Why: a 302 from this https server to an http provider is a cross-protocol
//! redirect, and Android players (ExoPlayer/media3) refuse to follow it. So
//! for HLS channels the gateway serves the manifest itself with every URI
//! rewritten to an absolute provider URL. Segments still travel provider ->
//! player, and access is re-checked on every manifest refresh.

use std::fmt::Write as _;

use url::Url;

use crate::core::util::{iso, parse_instant};
use crate::encode::liveloop::{Segment, parse_float_prefix};
use crate::regex;

/// Is this stream URL an HLS manifest we can rewrite? Query and fragment are
/// cut first. A raw MPEG-TS stream has no manifest and cannot be served so.
pub fn is_hls_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or("");
    path.len() >= 5 && path[path.len() - 5..].eq_ignore_ascii_case(".m3u8")
}

/// Resolve a URI against the manifest's own URL; a line that does not parse
/// is kept as is rather than costing the viewer the whole channel.
fn absolutize(uri: &str, base: &str) -> String {
    Url::parse(base)
        .and_then(|b| b.join(uri))
        .map_or_else(|_| uri.to_owned(), String::from)
}

/// A master (multivariant) playlist lists other playlists; one variant tag is
/// enough to tell it from a media playlist.
pub fn is_master_playlist(text: &str) -> bool {
    regex!(r"(?m)^#EXT-X-(STREAM-INF|MEDIA):").is_match(text)
}

/// Rewrite a manifest so a player can fetch everything it references directly
/// from the provider. `base` MUST be the URL the manifest was finally fetched
/// from (after redirects).
///
/// `playlist_uri`, when given, is applied to every URI in a MASTER playlist
/// that names a playlist the player keeps re-fetching — variant lines and
/// `EXT-X-MEDIA` renditions — so they come back through the gateway and a
/// revocation lands while the customer is watching. I-frame playlists and
/// keys stay direct.
pub fn rewrite_hls_manifest(text: &str, base: &str, playlist_uri: Option<&dyn Fn(&str) -> String>) -> String {
    let gate = playlist_uri.filter(|_| is_master_playlist(text));
    text.split('\n')
        .map(|raw| {
            let line = raw.strip_suffix('\r').unwrap_or(raw);
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return line.to_owned();
            }
            if trimmed.starts_with('#') {
                let gate_tag = gate.filter(|_| trimmed.starts_with("#EXT-X-MEDIA:"));
                return regex!(r#"URI="([^"]*)""#)
                    .replace_all(line, |c: &regex::Captures<'_>| {
                        let abs = absolutize(&c[1], base);
                        format!("URI=\"{}\"", gate_tag.map_or_else(|| abs.clone(), |g| g(&abs)))
                    })
                    .into_owned();
            }
            let abs = absolutize(trimmed, base);
            gate.map_or_else(|| abs.clone(), |g| g(&abs))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Mid-view cut-over ("splice")
// ---------------------------------------------------------------------------
// When a customer loses a channel WHILE watching, the gateway keeps the stream
// going: the provider's last window, an EXT-X-DISCONTINUITY, then segments of
// this server's own loop numbered as the continuation. Same invariants as
// liveloop: sequence numbers only move forward, a segment keeps the same
// discontinuity number on every refresh, and a discontinuity on the first
// segment of the window is counted by DISCONTINUITY-SEQUENCE, never tagged.

#[derive(Debug, Clone, PartialEq)]
pub struct MediaSegment {
    pub tags: Vec<String>,
    pub uri: String,
    pub duration: f64,
    pub discontinuity: bool,
    /// The `EXT-X-KEY` in force for this segment.
    pub key: Option<String>,
    /// PROGRAM-DATE-TIME in epoch ms (stated or carried forward).
    pub pdt: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MediaPlaylist {
    pub version: i64,
    pub target_duration: f64,
    pub media_sequence: i64,
    pub discontinuity_sequence: i64,
    pub independent: bool,
    pub has_map: bool,
    pub segments: Vec<MediaSegment>,
}

impl MediaPlaylist {
    /// The newest segment, named the same on every refresh. Some providers
    /// hand each segment out from a pool of edge servers with a signature
    /// that changes from one fetch to the next
    /// (`http://<edge>/iptv/…/1793465862000.ts?md5=…`), so a segment goes by
    /// its path; by its whole URI only where the paths alone do not tell the
    /// segments apart (`chunk.ts?n=41`).
    pub fn last_segment_id(&self) -> String {
        let Some(last) = self.segments.last() else {
            return String::new();
        };
        let paths: std::collections::HashSet<&str> = self.segments.iter().map(|s| uri_path(&s.uri)).collect();
        if paths.len() == self.segments.len() {
            uri_path(&last.uri).to_owned()
        } else {
            last.uri.clone()
        }
    }
}

/// A URI without its scheme, host, query and fragment.
fn uri_path(uri: &str) -> &str {
    let rest = uri.split(['?', '#']).next().unwrap_or(uri);
    match rest.find("://") {
        Some(i) => rest[i + 3..].find('/').map_or("/", |j| &rest[i + 3 + j..]),
        None => rest,
    }
}

fn is_header_tag(line: &str) -> bool {
    regex!(r"^#(EXTM3U|EXT-X-(VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|PLAYLIST-TYPE|INDEPENDENT-SEGMENTS|START|ENDLIST|SERVER-CONTROL|PART-INF|ALLOW-CACHE))\b").is_match(line)
        || regex!(r"^#EXT-X-(PART|PRELOAD-HINT|RENDITION-REPORT|SKIP)\b").is_match(line)
}

fn tag_number(text: &str, tag: &str) -> Option<f64> {
    text.lines().find_map(|l| {
        l.trim()
            .strip_prefix(tag)?
            .strip_prefix(':')
            .and_then(parse_float_prefix)
    })
}

pub fn parse_media_playlist(text: &str) -> MediaPlaylist {
    let mut segments: Vec<MediaSegment> = Vec::new();
    let mut tags: Vec<String> = Vec::new();
    let mut key: Option<String> = None;
    let mut has_map = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            if is_header_tag(line) {
                continue;
            }
            if line.starts_with("#EXT-X-KEY:") {
                key = Some(line.to_owned());
            }
            if line.starts_with("#EXT-X-MAP:") {
                has_map = true;
            }
            tags.push(line.to_owned());
            continue;
        }
        let duration = tags
            .iter()
            .find_map(|t| t.strip_prefix("#EXTINF:"))
            .and_then(parse_float_prefix)
            .unwrap_or(0.0);
        let pdt = tags
            .iter()
            .find_map(|t| t.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:"))
            .and_then(parse_instant)
            .map(jiff::Timestamp::as_millisecond);
        segments.push(MediaSegment {
            discontinuity: tags.iter().any(|t| t == "#EXT-X-DISCONTINUITY"),
            tags: std::mem::take(&mut tags),
            uri: line.to_owned(),
            duration,
            key: key.clone(),
            pdt,
        });
    }
    // Many providers stamp PROGRAM-DATE-TIME on the first segment only.
    for i in 1..segments.len() {
        if segments[i].pdt.is_none()
            && let Some(prev) = segments[i - 1].pdt
        {
            segments[i].pdt = Some(prev + (segments[i - 1].duration * 1000.0) as i64);
        }
    }
    MediaPlaylist {
        version: tag_number(text, "#EXT-X-VERSION")
            .filter(|v| *v != 0.0)
            .map_or(3, |v| v as i64),
        target_duration: tag_number(text, "#EXT-X-TARGETDURATION")
            .filter(|v| *v != 0.0)
            .unwrap_or(6.0),
        media_sequence: tag_number(text, "#EXT-X-MEDIA-SEQUENCE").map_or(0, |v| v as i64),
        discontinuity_sequence: tag_number(text, "#EXT-X-DISCONTINUITY-SEQUENCE").map_or(0, |v| v as i64),
        independent: regex!(r"(?m)^#EXT-X-INDEPENDENT-SEGMENTS").is_match(text),
        has_map,
        segments,
    }
}

fn is_plain_key(key: Option<&str>) -> bool {
    key.is_none_or(|k| k.contains("METHOD=NONE"))
}

/// Filler segments listed at once, so the player has buffer the moment it
/// sees the change; after that they appear in real time.
const FILLER_LEAD: usize = 3;

fn filler_available(duration_at: impl Fn(usize) -> f64, elapsed: f64) -> usize {
    let mut count = FILLER_LEAD;
    let mut next_start = duration_at(0);
    let mut k = 1;
    while next_start <= elapsed && k < 1_000_000 {
        count += 1;
        next_start += duration_at(k);
        k += 1;
    }
    count
}

/// Inputs to [`build_spliced_playlist`].
pub struct Splice<'a> {
    /// The last manifest served to this player (URIs already absolute).
    pub provider: &'a MediaPlaylist,
    /// The loop to cut over to.
    pub filler: &'a [Segment],
    /// `(segment, sequence)` -> URL the player fetches it from.
    pub filler_uri: &'a dyn Fn(&Segment, i64) -> String,
    /// Which filler segment comes first.
    pub start_index: usize,
    /// Time since the cut, so the filler advances in real time.
    pub elapsed_seconds: f64,
    /// Minimum number of segments to keep listed.
    pub window: usize,
}

impl std::fmt::Debug for Splice<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Splice")
            .field("start_index", &self.start_index)
            .finish_non_exhaustive()
    }
}

/// The provider's last window followed by the filler loop. An fMP4 provider
/// (`EXT-X-MAP`) cannot be followed by our MPEG-TS segments, so that case
/// ends the stream instead.
pub fn build_spliced_playlist(sp: &Splice<'_>) -> String {
    let segs = &sp.provider.segments;
    if sp.provider.has_map || sp.filler.is_empty() {
        return ended_playlist(sp.provider);
    }
    let loop_len = sp.filler.len();
    let filler_at = |k: usize| &sp.filler[(sp.start_index + k) % loop_len];
    let available = filler_available(|k| filler_at(k).duration, sp.elapsed_seconds.max(0.0));
    let n = segs.len();
    let total = n + available;
    let cap = sp.window.max(n);
    let first = total.saturating_sub(cap);

    // Discontinuity number of every provider segment, ExoPlayer-style.
    let mut disc = sp.provider.discontinuity_sequence;
    let provider_disc: Vec<i64> = segs
        .iter()
        .map(|seg| {
            if seg.discontinuity {
                disc += 1;
            }
            disc
        })
        .collect();
    let last_provider_disc = provider_disc
        .last()
        .copied()
        .unwrap_or(sp.provider.discontinuity_sequence);
    let filler_disc = |k: usize| last_provider_disc + 1 + ((sp.start_index + k) / loop_len) as i64;
    let filler_tagged = |k: usize| k == 0 || (sp.start_index + k).is_multiple_of(loop_len);
    let disc_at = |i: usize| {
        if i < n { provider_disc[i] } else { filler_disc(i - n) }
    };

    // Continue the provider's wall clock across the cut.
    let last_pdt = segs
        .last()
        .and_then(|seg| seg.pdt.map(|t| t + (seg.duration * 1000.0) as i64));
    let filler_max = sp.filler.iter().map(|x| x.duration).fold(0.0, f64::max);

    let mut out = String::from("#EXTM3U\n");
    let _ = writeln!(out, "#EXT-X-VERSION:{}", sp.provider.version.max(3));
    if sp.provider.independent {
        out.push_str("#EXT-X-INDEPENDENT-SEGMENTS\n");
    }
    let _ = writeln!(
        out,
        "#EXT-X-TARGETDURATION:{}",
        sp.provider.target_duration.max(filler_max).ceil() as i64
    );
    let _ = writeln!(
        out,
        "#EXT-X-MEDIA-SEQUENCE:{}",
        sp.provider.media_sequence + first as i64
    );
    let _ = writeln!(out, "#EXT-X-DISCONTINUITY-SEQUENCE:{}", disc_at(first));

    let mut clock = last_pdt;
    for k in 0..first.saturating_sub(n) {
        clock = clock.map(|c| c + (filler_at(k).duration * 1000.0) as i64);
    }

    for i in first..total {
        let listed_first = i == first;
        if i < n {
            let seg = &segs[i];
            // Restate the key in force if the tag that set it scrolled off.
            if listed_first
                && !is_plain_key(seg.key.as_deref())
                && !seg.tags.iter().any(|t| t.starts_with("#EXT-X-KEY:"))
                && let Some(k) = &seg.key
            {
                out.push_str(k);
                out.push('\n');
            }
            for tag in &seg.tags {
                if tag == "#EXT-X-DISCONTINUITY" && listed_first {
                    continue; // counted by the header
                }
                out.push_str(tag);
                out.push('\n');
            }
            out.push_str(&seg.uri);
            out.push('\n');
            continue;
        }
        let k = i - n;
        let seg = filler_at(k);
        if filler_tagged(k) && !listed_first {
            out.push_str("#EXT-X-DISCONTINUITY\n");
        }
        if k == 0 && n > 0 && !is_plain_key(segs[n - 1].key.as_deref()) && !listed_first {
            out.push_str("#EXT-X-KEY:METHOD=NONE\n");
        }
        if let Some(c) = clock {
            if let Ok(t) = jiff::Timestamp::from_millisecond(c) {
                let _ = writeln!(out, "#EXT-X-PROGRAM-DATE-TIME:{}", iso(t));
            }
            clock = Some(c + (seg.duration * 1000.0) as i64);
        }
        let _ = writeln!(out, "#EXTINF:{:.6},", seg.duration);
        out.push_str(&(sp.filler_uri)(seg, sp.provider.media_sequence + i as i64));
        out.push('\n');
    }
    out
}

/// The provider's last window, closed. Used where a cut-over cannot be built.
pub fn ended_playlist(provider: &MediaPlaylist) -> String {
    let mut out = String::from("#EXTM3U\n");
    let _ = writeln!(out, "#EXT-X-VERSION:{}", provider.version.max(3));
    let _ = writeln!(out, "#EXT-X-TARGETDURATION:{}", provider.target_duration.ceil() as i64);
    let _ = writeln!(out, "#EXT-X-MEDIA-SEQUENCE:{}", provider.media_sequence);
    let _ = writeln!(out, "#EXT-X-DISCONTINUITY-SEQUENCE:{}", provider.discontinuity_sequence);
    for (i, seg) in provider.segments.iter().enumerate() {
        for tag in &seg.tags {
            if tag == "#EXT-X-DISCONTINUITY" && i == 0 {
                continue;
            }
            out.push_str(tag);
            out.push('\n');
        }
        out.push_str(&seg.uri);
        out.push('\n');
    }
    out.push_str("#EXT-X-ENDLIST\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const BASE: &str = "http://provider.example/live/user/pass/123/index.m3u8";

    #[test]
    fn hls_url_detection() {
        assert!(is_hls_url("http://p/live/1.m3u8"));
        assert!(is_hls_url("http://p/live/1.m3u8?token=abc&x=1"));
        assert!(is_hls_url("http://p/live/1.M3U8#frag"));
        assert!(!is_hls_url("http://p/live/user/pass/1.ts"));
        assert!(!is_hls_url("http://p/live/user/pass/1"));
        assert!(!is_hls_url(""));
    }

    #[test]
    fn relative_segments_become_absolute() {
        let m = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nseg_001.ts\n#EXTINF:6.000,\n../shared/seg_002.ts\n#EXTINF:6.000,\n/abs/seg_003.ts?token=xyz";
        let out = rewrite_hls_manifest(m, BASE, None);
        let lines: Vec<_> = out.split('\n').collect();
        assert_eq!(lines[4], "http://provider.example/live/user/pass/123/seg_001.ts");
        assert_eq!(lines[6], "http://provider.example/live/user/pass/shared/seg_002.ts");
        assert_eq!(lines[8], "http://provider.example/abs/seg_003.ts?token=xyz");
    }

    #[test]
    fn tag_uris_rewritten() {
        let m = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x0\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.000,\nseg_001.ts";
        let out = rewrite_hls_manifest(m, BASE, None);
        assert!(out.contains("METHOD=AES-128,URI=\"http://provider.example/live/user/pass/123/key.bin\",IV=0x0"));
        assert!(out.contains("URI=\"http://provider.example/live/user/pass/123/init.mp4\""));
    }

    #[test]
    fn absolute_and_blank_lines_survive() {
        let m = "#EXTM3U\r\n\r\n#EXTINF:6.000,\r\nhttps://cdn.example/edge/seg_001.ts?sig=abc\r\n";
        assert_eq!(
            rewrite_hls_manifest(m, BASE, None),
            "#EXTM3U\n\n#EXTINF:6.000,\nhttps://cdn.example/edge/seg_001.ts?sig=abc\n"
        );
        assert_eq!(
            rewrite_hls_manifest("#EXTM3U\n:::not a uri:::", "not-a-base", None),
            "#EXTM3U\n:::not a uri:::"
        );
    }

    #[test]
    fn master_variants_go_through_gate() {
        let m = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"ru\",URI=\"audio/ru.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"a\"\nlow/index.m3u8\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI=\"iframes.m3u8\"";
        let gate = |u: &str| format!("GATE({u})");
        let out = rewrite_hls_manifest(m, BASE, Some(&gate));
        let lines: Vec<_> = out.split('\n').collect();
        assert_eq!(
            lines[1],
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"ru\",URI=\"GATE(http://provider.example/live/user/pass/123/audio/ru.m3u8)\""
        );
        assert_eq!(
            lines[3],
            "GATE(http://provider.example/live/user/pass/123/low/index.m3u8)"
        );
        assert_eq!(
            lines[4],
            "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI=\"http://provider.example/live/user/pass/123/iframes.m3u8\""
        );
        let media = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts";
        assert!(!is_master_playlist(media));
        let no = |_: &str| "NO".to_owned();
        assert!(rewrite_hls_manifest(media, BASE, Some(&no)).ends_with("/123/seg.ts"));
    }

    fn provider() -> MediaPlaylist {
        parse_media_playlist(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:500\n#EXT-X-DISCONTINUITY-SEQUENCE:7\n\
             #EXT-X-KEY:METHOD=AES-128,URI=\"http://p/k\"\n#EXT-X-PROGRAM-DATE-TIME:2026-10-06T10:00:00.000Z\n\
             #EXTINF:4.000,\nhttp://p/a.ts\n#EXTINF:4.000,\nhttp://p/b.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4.000,\nhttp://p/c.ts",
        )
    }

    fn filler() -> Vec<Segment> {
        (0..3)
            .map(|i| Segment {
                file: format!("seg_{i:03}.ts"),
                duration: 6.0,
            })
            .collect()
    }

    fn filler_uri(seg: &Segment, seq: i64) -> String {
        format!("https://me/hls/t/{}?s={seq}", seg.file)
    }

    fn splice(p: &MediaPlaylist, f: &[Segment], elapsed: f64, window: usize) -> String {
        build_spliced_playlist(&Splice {
            provider: p,
            filler: f,
            filler_uri: &filler_uri,
            start_index: 0,
            elapsed_seconds: elapsed,
            window,
        })
    }

    fn timeline(text: &str) -> Vec<(i64, i64, String)> {
        let num = |tag: &str| -> i64 { text.lines().find_map(|l| l.strip_prefix(tag)).unwrap().parse().unwrap() };
        let mut seq = num("#EXT-X-MEDIA-SEQUENCE:");
        let mut disc = num("#EXT-X-DISCONTINUITY-SEQUENCE:");
        let mut out = Vec::new();
        for line in text.lines() {
            if line == "#EXT-X-DISCONTINUITY" {
                disc += 1;
            } else if !line.is_empty() && !line.starts_with('#') {
                out.push((seq, disc, line.to_owned()));
                seq += 1;
            }
        }
        out
    }

    #[test]
    fn parses_media_playlist() {
        let p = provider();
        assert_eq!(
            (p.media_sequence, p.discontinuity_sequence, p.segments.len()),
            (500, 7, 3)
        );
        assert!(p.segments[2].discontinuity);
        assert!(p.segments[2].key.as_deref().unwrap().contains("AES-128"));
        assert_eq!(
            p.segments[0].pdt,
            Some(
                "2026-10-06T10:00:00Z"
                    .parse::<jiff::Timestamp>()
                    .unwrap()
                    .as_millisecond()
            )
        );
    }

    #[test]
    fn segments_keep_their_id_across_edges_and_signatures() {
        let fetch = |edge: &str, md5: &str| {
            parse_media_playlist(&format!(
                "#EXTM3U\n#EXT-X-TARGETDURATION:11\n#EXT-X-MEDIA-SEQUENCE:7\n\
                 #EXTINF:10,\nhttp://10.0.0.1/iptv/K/271/100.ts?md5=x\n\
                 #EXTINF:10,\nhttp://{edge}/iptv/K/271/110.ts?md5={md5}\n"
            ))
        };
        let a = fetch("10.0.0.2", "a");
        assert_eq!(a.last_segment_id(), "/iptv/K/271/110.ts");
        assert_eq!(a.last_segment_id(), fetch("10.0.0.3", "b").last_segment_id());
        // Paths that do not tell the segments apart: the whole URI.
        let p = parse_media_playlist(
            "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttp://p/chunk.ts?n=1\n#EXTINF:6,\nhttp://p/chunk.ts?n=2\n",
        );
        assert_eq!(p.last_segment_id(), "http://p/chunk.ts?n=2");
        assert_eq!(parse_media_playlist("#EXTM3U\n").last_segment_id(), "");
    }

    #[test]
    fn splice_never_renumbers() {
        let p = provider();
        let f = filler();
        let mut previous: Option<HashMap<i64, (i64, String)>> = None;
        let mut previous_first = i64::MIN;
        for t in (0..=120).step_by(2) {
            let text = splice(&p, &f, f64::from(t), 6);
            let now: HashMap<i64, (i64, String)> = timeline(&text).into_iter().map(|(s, d, u)| (s, (d, u))).collect();
            let first = *now.keys().min().unwrap();
            assert!(first >= previous_first, "moved backwards at t={t}");
            assert!(first > p.media_sequence || now.len() > p.segments.len());
            if let Some(prev) = &previous {
                for (seq, seg) in &now {
                    if let Some(old) = prev.get(seq) {
                        assert_eq!(seg, old, "seq {seq} changed at t={t}");
                    }
                }
            }
            assert!(
                !crate::regex!(r"DISCONTINUITY-SEQUENCE:\d+\n(#EXT-X-KEY[^\n]*\n)?#EXT-X-DISCONTINUITY\n")
                    .is_match(&text)
            );
            previous = Some(now);
            previous_first = first;
        }
        let end = timeline(&splice(&p, &f, 0.0, 20));
        assert_eq!(end.iter().map(|x| x.1).collect::<Vec<_>>(), [7, 7, 8, 9, 9, 9]);
        assert_eq!(
            end.iter().find(|x| x.0 == 503).unwrap().2,
            "https://me/hls/t/seg_000.ts?s=503"
        );
    }

    #[test]
    fn cut_switches_encryption_off_and_keeps_clock() {
        let p = provider();
        let f = filler();
        let text = splice(&p, &f, 0.0, 8);
        let lines: Vec<_> = text.lines().collect();
        let cut = lines
            .iter()
            .position(|l| *l == "https://me/hls/t/seg_000.ts?s=503")
            .unwrap();
        assert_eq!(
            lines[cut - 4..cut],
            [
                "#EXT-X-DISCONTINUITY",
                "#EXT-X-KEY:METHOD=NONE",
                "#EXT-X-PROGRAM-DATE-TIME:2026-10-06T10:00:12.000Z",
                "#EXTINF:6.000000,"
            ]
        );
        assert!(!splice(&p, &f, 300.0, 4).contains("EXT-X-KEY"));
        let text = splice(&p, &f, 0.0, 5);
        let lines: Vec<_> = text.lines().collect();
        let b = lines.iter().position(|l| *l == "http://p/b.ts").unwrap();
        assert_eq!(lines[b - 2], "#EXT-X-KEY:METHOD=AES-128,URI=\"http://p/k\"");
    }

    #[test]
    fn fmp4_closed_instead() {
        let p = parse_media_playlist(
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"http://p/init.mp4\"\n#EXTINF:4,\nhttp://p/a.m4s",
        );
        let text = splice(&p, &filler(), 0.0, 8);
        assert!(text.ends_with("#EXT-X-ENDLIST\n"));
        assert!(!text.contains("seg_000"));
    }
}
