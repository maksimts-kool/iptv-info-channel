//! Presents a pre-generated VOD HLS asset as an endless live channel.
//!
//! HLS player compatibility here is fragile. Strict players (Televizo's
//! ExoPlayer/IJK) buffer forever unless this playlist keeps a >=8-segment
//! window ([`LIVE_WINDOW_SEGMENTS`]), drops the sub-second "runt" trailing
//! segment, emits `#EXT-X-VERSION:6`, and the server honors `Range`. Don't
//! "simplify" the window / sequence-number construction without testing on a
//! strict player.
//!
//! The other invariant, easy to break silently: a media sequence number must
//! always report the SAME discontinuity number, refresh after refresh.
//! ExoPlayer keys its timestamp adjusters off that number, so renumbering a
//! segment as the window slides stalls playback at the loop wrap. A
//! regression test walks the window across several wraps and asserts it.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

use anyhow::{Context, bail};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};

/// A wider window gives strict live players buffer headroom behind the
/// synthetic live edge. Too thin (e.g. 4) and they rebuffer forever.
pub const LIVE_WINDOW_SEGMENTS: i64 = 8;

const STATE_FILE: &str = "loop.json";
const PLAYLIST_FILE: &str = "index.m3u8";

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub file: String,
    pub duration: f64,
}

#[derive(Debug)]
struct LoopMeta {
    segments: Vec<Segment>,
    total_duration: f64,
    target_duration: i64,
}

type MetaCache = Mutex<HashMap<PathBuf, (SystemTime, u64, Arc<LoopMeta>)>>;
static META_CACHE: LazyLock<MetaCache> = LazyLock::new(Mutex::default);

fn parse_meta(text: &str) -> Option<LoopMeta> {
    let mut segments = Vec::new();
    let mut pending: Option<f64> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(d) = line.strip_prefix("#EXTINF:") {
            pending = parse_float_prefix(d);
        } else if !line.starts_with('#') {
            segments.push(Segment {
                file: line.to_owned(),
                duration: pending.take().unwrap_or(6.0),
            });
        }
    }
    if segments.is_empty() {
        return None;
    }
    // Drop sub-second runt segments (the sliver left when the loop isn't an
    // exact multiple of the segment time). Listing one stalls strict decoders.
    let longest = segments.iter().map(|s| s.duration).fold(0.0, f64::max);
    let runt = (longest * 0.5).min(1.0);
    let usable: Vec<Segment> = segments.iter().filter(|s| s.duration >= runt).cloned().collect();
    let segments = if usable.is_empty() { segments } else { usable };
    let total_duration = segments.iter().map(|s| s.duration).sum();
    let target_duration = (segments.iter().map(|s| s.duration).fold(0.0, f64::max).ceil() as i64).max(1);
    Some(LoopMeta {
        segments,
        total_duration,
        target_duration,
    })
}

/// `parseFloat`: the longest numeric prefix.
pub fn parse_float_prefix(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let end = s
        .char_indices()
        .take_while(|(i, c)| c.is_ascii_digit() || *c == '.' || (*i == 0 && (*c == '-' || *c == '+')))
        .last()
        .map_or(0, |(i, c)| i + c.len_utf8());
    s[..end].parse().ok().filter(|f: &f64| f.is_finite())
}

fn read_loop_meta(dir: &Path) -> Option<Arc<LoopMeta>> {
    let path = dir.join(PLAYLIST_FILE);
    let stat = fs::metadata(&path).ok()?;
    let mtime = stat.modified().ok()?;
    let mut cache = META_CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((m, size, meta)) = cache.get(&path)
        && *m == mtime
        && *size == stat.len()
    {
        return Some(Arc::clone(meta));
    }
    let meta = Arc::new(parse_meta(&fs::read_to_string(&path).ok()?)?);
    cache.insert(path, (mtime, stat.len(), Arc::clone(&meta)));
    Some(meta)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopState {
    pub epoch: i64,
    pub base_seq: i64,
    pub base_discontinuity: i64,
    pub version: String,
}

fn read_state(dir: &Path) -> Option<LoopState> {
    serde_json::from_slice(&fs::read(dir.join(STATE_FILE)).ok()?).ok()
}

fn preroll_ms(meta: &LoopMeta) -> i64 {
    let count = (LIVE_WINDOW_SEGMENTS - 1).min(meta.segments.len() as i64 - 1).max(0) as usize;
    meta.segments[..count]
        .iter()
        .map(|s| (s.duration * 1000.0) as i64)
        .sum()
}

fn segment_offset(meta: &LoopMeta, elapsed: f64) -> i64 {
    let cycle = (elapsed / meta.total_duration).floor();
    let position = elapsed - cycle * meta.total_duration;
    let mut index = 0;
    let mut boundary = meta.segments[0].duration;
    while index + 1 < meta.segments.len() && position >= boundary {
        index += 1;
        boundary += meta.segments[index].duration;
    }
    cycle as i64 * meta.segments.len() as i64 + index as i64
}

/// Live counters of a loop at an instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub media_sequence: i64,
    pub discontinuity_sequence: i64,
}

fn position(meta: &LoopMeta, state: &LoopState, now_ms: i64) -> Position {
    let elapsed = ((now_ms - state.epoch) as f64 / 1000.0).max(0.0);
    let offset = segment_offset(meta, elapsed);
    Position {
        media_sequence: state.base_seq + offset,
        discontinuity_sequence: state.base_discontinuity + offset.div_euclid(meta.segments.len() as i64),
    }
}

/// The loop's playable segments (runt dropped) — what the stream gateway
/// splices in when it cuts a viewer over to this loop mid-view.
pub fn loop_segments(dir: &Path) -> Option<Vec<Segment>> {
    read_loop_meta(dir).map(|m| m.segments.clone())
}

/// Current live counters. Regeneration uses these so sequence numbers never
/// move backwards when the rendered content changes.
pub fn current_loop_position(dir: &Path, now_ms: i64) -> Option<Position> {
    let meta = read_loop_meta(dir)?;
    let state = read_state(dir)?;
    Some(position(&meta, &state, now_ms))
}

fn random_version(now_ms: i64) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut n = now_ms.unsigned_abs();
    let mut stamp = Vec::new();
    loop {
        stamp.push(ALPHABET[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    stamp.reverse();
    let suffix: String = (0..6).map(|_| ALPHABET[rand::random_range(0..36)] as char).collect();
    format!("{}-{suffix}", String::from_utf8_lossy(&stamp))
}

/// Starting counters for a newly rendered generation.
#[derive(Debug, Clone, Default)]
pub struct LoopStart {
    pub base_seq: i64,
    pub base_discontinuity: i64,
    pub version: Option<String>,
}

/// Initialize a newly rendered generation. A short preroll means the first
/// playlist already has a healthy live window instead of one segment.
pub fn write_loop_state(dir: &Path, start: LoopStart, now_ms: i64) -> anyhow::Result<LoopState> {
    let Some(meta) = read_loop_meta(dir) else {
        bail!("cannot initialize live loop without an HLS playlist")
    };
    let state = LoopState {
        epoch: now_ms - preroll_ms(&meta),
        base_seq: start.base_seq.max(0),
        base_discontinuity: start.base_discontinuity.max(0),
        version: start.version.unwrap_or_else(|| random_version(now_ms)),
    };
    fs::write(dir.join(STATE_FILE), serde_json::to_vec(&state)?).context("writing loop state")?;
    Ok(state)
}

/// A single shared live timeline: a sliding window over the looped segments,
/// the same for every viewer regardless of when they tune in.
pub fn build_live_playlist(dir: &Path, now_ms: i64) -> Option<String> {
    let meta = read_loop_meta(dir)?;
    let state = read_state(dir).unwrap_or_else(|| {
        write_loop_state(dir, LoopStart::default(), now_ms).unwrap_or_else(|_| LoopState {
            epoch: now_ms - preroll_ms(&meta),
            base_seq: 0,
            base_discontinuity: 0,
            version: "legacy".to_owned(),
        })
    });
    let n = meta.segments.len() as i64;

    let current = position(&meta, &state, now_ms);
    let first = state.base_seq.max(current.media_sequence - LIVE_WINDOW_SEGMENTS + 1);
    let playback_offset = first - state.base_seq;
    let discontinuity = state.base_discontinuity + playback_offset.div_euclid(n);
    let count = current.media_sequence - first + 1;
    let advertised: f64 = (0..count)
        .map(|i| meta.segments[((playback_offset + i) % n) as usize].duration)
        .sum();
    let version = utf8_percent_encode(&state.version, NON_ALPHANUMERIC_KEEP_SAFE).to_string();

    let mut out = String::new();
    // Version 6 matches the tags we emit; strict players reject a mismatch.
    out.push_str("#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n");
    let _ = writeln!(out, "#EXT-X-TARGETDURATION:{}", meta.target_duration);
    let _ = writeln!(out, "#EXT-X-MEDIA-SEQUENCE:{first}");
    let _ = writeln!(out, "#EXT-X-DISCONTINUITY-SEQUENCE:{discontinuity}");
    // Start at the live edge so players join the running stream.
    let _ = writeln!(out, "#EXT-X-START:TIME-OFFSET=-{advertised:.3},PRECISE=NO");

    for index in 0..count {
        let sequence = first + index;
        let local = ((sequence - state.base_seq) % n) as usize;
        let segment = &meta.segments[local];
        // A loop boundary on the FIRST segment of the window must not be
        // tagged: DISCONTINUITY-SEQUENCE already counts it. Emitting both
        // renumbers that segment between refreshes and freezes ExoPlayer at
        // the wrap — hence `index > 0`, not `offset > 0`.
        if index > 0 && local == 0 {
            out.push_str("#EXT-X-DISCONTINUITY\n");
        }
        let _ = writeln!(out, "#EXTINF:{:.6},", segment.duration);
        let _ = writeln!(out, "{}?v={version}&s={sequence}", segment.file);
    }
    Some(out)
}

/// `encodeURIComponent`'s unreserved set: alphanumerics plus `-_.!~*'()`.
pub const NON_ALPHANUMERIC_KEEP_SAFE: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn fixture(count: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let mut text = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:6\n");
        for i in 0..count {
            let _ = write!(text, "#EXTINF:6.000000,\nseg_{i:03}.ts\n");
        }
        text.push_str("#EXT-X-ENDLIST\n");
        fs::write(dir.path().join(PLAYLIST_FILE), text).unwrap();
        dir
    }

    fn start(v: &str) -> LoopStart {
        LoopStart {
            version: Some(v.into()),
            ..LoopStart::default()
        }
    }

    #[test]
    fn trailing_window_without_end() {
        let d = fixture(5);
        write_loop_state(d.path(), start("one"), 100_000).unwrap();
        let p = build_live_playlist(d.path(), 106_000).unwrap();
        assert!(p.contains("#EXT-X-MEDIA-SEQUENCE:0"));
        assert!(p.contains("seg_001.ts?v=one&s=1"));
        assert!(p.contains("seg_004.ts?v=one&s=4"));
        assert!(!p.contains("#EXT-X-ENDLIST"));
    }

    #[test]
    fn advances_with_discontinuity() {
        let d = fixture(5);
        write_loop_state(d.path(), start("one"), 100_000).unwrap();
        let p = build_live_playlist(d.path(), 118_000).unwrap();
        assert!(p.contains("#EXT-X-MEDIA-SEQUENCE:0"));
        assert!(p.contains("seg_004.ts?v=one&s=4\n#EXT-X-DISCONTINUITY\n#EXTINF:6.000000,\nseg_000.ts?v=one&s=5"));
        assert_eq!(
            current_loop_position(d.path(), 118_000),
            Some(Position {
                media_sequence: 7,
                discontinuity_sequence: 1
            })
        );
    }

    fn discontinuity_indexes(p: &str) -> HashMap<i64, i64> {
        let mut out = HashMap::new();
        let mut counter = 0;
        for line in p.lines() {
            if let Some(v) = line.strip_prefix("#EXT-X-DISCONTINUITY-SEQUENCE:") {
                counter = v.parse().unwrap();
            } else if line == "#EXT-X-DISCONTINUITY" {
                counter += 1;
            } else if let Some(i) = line.find("&s=") {
                out.insert(line[i + 3..].parse().unwrap(), counter);
            }
        }
        out
    }

    #[test]
    fn segment_keeps_one_discontinuity_number_across_wraps() {
        let d = fixture(5);
        write_loop_state(d.path(), start("one"), 100_000).unwrap();
        let mut seen: HashMap<i64, i64> = HashMap::new();
        for now in (100_000..=340_000).step_by(6_000) {
            for (seq, idx) in discontinuity_indexes(&build_live_playlist(d.path(), now).unwrap()) {
                if let Some(prev) = seen.get(&seq) {
                    assert_eq!(idx, *prev, "segment {seq} renumbered at {now}");
                }
                seen.insert(seq, idx);
            }
        }
        assert_eq!(seen[&4], 0);
        assert_eq!(seen[&5], 1);
        assert_eq!(seen[&10], 2);
    }

    #[test]
    fn rebuilt_generation_continues_counters() {
        let old = fixture(5);
        let new = fixture(5);
        write_loop_state(old.path(), start("old"), 100_000).unwrap();
        let pos = current_loop_position(old.path(), 112_000).unwrap();
        write_loop_state(
            new.path(),
            LoopStart {
                base_seq: pos.media_sequence + 4,
                base_discontinuity: pos.discontinuity_sequence + 1,
                version: Some("new".into()),
            },
            112_000,
        )
        .unwrap();
        let p = build_live_playlist(new.path(), 112_000).unwrap();
        assert!(p.contains("#EXT-X-MEDIA-SEQUENCE:10"));
        assert!(p.contains("#EXT-X-DISCONTINUITY-SEQUENCE:2"));
        assert!(p.contains("seg_000.ts?v=new&s=10"));
        assert!(!p.contains("?v=old"));
    }

    #[test]
    fn shared_timeline() {
        let d = fixture(5);
        write_loop_state(d.path(), start("live"), 100_000).unwrap();
        let a = build_live_playlist(d.path(), 118_000).unwrap();
        assert_eq!(a, build_live_playlist(d.path(), 118_000).unwrap());
        assert!(a.contains("#EXT-X-START:TIME-OFFSET=-"));
    }

    #[test]
    fn runt_segment_dropped() {
        let meta = parse_meta("#EXTINF:6.0,\na.ts\n#EXTINF:6.0,\nb.ts\n#EXTINF:0.04,\nc.ts\n").unwrap();
        assert_eq!(meta.segments.len(), 2);
        assert_eq!(meta.target_duration, 6);
    }
}
