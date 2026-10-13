//! ffmpeg argument builders for the media channel.
//!
//! The channel is built in two steps:
//!   1. every ARTICLE becomes its own clip — its tall page scrolling over the
//!      channel background, each video playing in place while the scroll
//!      waits, the «1/3 · title» chip in the corner. Clips are cached by
//!      content hash, so editing one article re-encodes only it;
//!   2. the LOOP is the clips joined with the concat demuxer (video stream
//!      copy, audio re-encoded), cut into HLS for `liveloop`.
//!
//! Step 2 is correct only because every clip keeps two invariants:
//! IDENTICAL encode parameters ([`clip_encode_args`]) and a WHOLE NUMBER of
//! segments ([`tile_up`]) with keyframes on the boundaries.
//!
//! Pinned by `tests/fixtures/media-args.golden.json` (the Node version's own
//! snapshot). Regenerate only for an intended change:
//! `UPDATE_GOLDEN=1 cargo test media_args`.

use serde::Serialize;
use serde_json::Value;

use super::ffmpeg::{capture, js_fixed, js_num};
use super::liveloop::LIVE_WINDOW_SEGMENTS;

/// An article holds still this long before scrolling, and at least this long
/// once its end is on screen.
pub const SCROLL_HOLD_SECONDS: f64 = 3.0;

/// Everything the builders read from the config.
#[derive(Debug, Clone)]
pub struct MediaParams {
    pub width: u32,
    pub height: u32,
    pub hls_time: u32,
    pub live_loop: bool,
    pub fps: u32,
    pub preset: String,
    pub crf: u32,
    pub maxrate: String,
}

impl MediaParams {
    pub fn from_config(c: &crate::config::Config) -> Self {
        Self {
            width: c.channel.width,
            height: c.channel.height,
            hls_time: c.channel.hls_time,
            live_loop: c.channel.live_loop,
            fps: c.media.fps,
            preset: c.media.preset.clone(),
            crf: c.media.crf,
            maxrate: c.media.maxrate.clone(),
        }
    }
}

fn n3(v: f64) -> String {
    js_fixed(v, 3)
}

fn s(v: &str) -> String {
    v.to_owned()
}

/// Round UP to whole segments (never below one), so clips concatenate onto
/// segment boundaries and nothing is cut short.
pub fn tile_up(seconds: f64, segment: f64) -> f64 {
    segment.max((seconds / segment - 1e-9).ceil() * segment)
}

/// A video on the page, as the timeline sees it.
#[derive(Debug, Clone, Copy, Default)]
pub struct TimelineVideo {
    pub y: f64,
    pub height: f64,
    /// Height to centre (box + caption); `None` = the box.
    pub focus: Option<f64>,
    pub duration: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Phase {
    pub start: f64,
    pub end: f64,
    pub from: f64,
    pub to: f64,
    /// Index of the video playing during this phase.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Timeline {
    pub phases: Vec<Phase>,
    pub starts: Vec<f64>,
    pub total: f64,
    pub max_scroll: f64,
}

/// What happens on screen: hold at the top, scroll until each video is
/// centred, stop while it plays, scroll to the end, hold. A page that never
/// scrolls lasts at least `min_seconds`; the final hold absorbs the rounding
/// up to whole segments.
/// Accumulates timeline phases.
#[derive(Default)]
struct PhaseBuilder {
    phases: Vec<Phase>,
    t: f64,
    pos: f64,
}

impl PhaseBuilder {
    fn add(&mut self, duration: f64, to: f64, video: Option<usize>) {
        if duration > 0.0 {
            self.phases.push(Phase { start: self.t, end: self.t + duration, from: self.pos, to, video });
            self.t += duration;
            self.pos = to;
        }
    }
}

pub fn article_timeline(layer_height: f64, screen_height: f64, videos: &[TimelineVideo], speed: f64, min_seconds: f64, segment: f64) -> Timeline {
    let max_scroll = (layer_height - screen_height).round().max(0.0);
    let mut b = PhaseBuilder::default();
    let mut starts = vec![0.0; videos.len()];
    b.add(SCROLL_HOLD_SECONDS, 0.0, None);
    let mut order: Vec<usize> = (0..videos.len()).collect();
    order.sort_by(|x, y| videos[*x].y.total_cmp(&videos[*y].y));
    for i in order {
        let v = videos[i];
        // Centre the video with its caption (`focus`), not the bare box.
        let centred = (v.y + v.focus.filter(|f| *f != 0.0).unwrap_or(v.height) / 2.0 - screen_height / 2.0).round();
        let target = centred.max(0.0).min(max_scroll);
        if target > b.pos {
            let d = (target - b.pos) / speed;
            b.add(d, target, None);
        }
        starts[i] = b.t;
        let here = b.pos;
        b.add(v.duration, here, Some(i));
    }
    if max_scroll > b.pos {
        let d = (max_scroll - b.pos) / speed;
        b.add(d, max_scroll, None);
    }
    let needed = if max_scroll > 0.0 { b.t + SCROLL_HOLD_SECONDS } else { (b.t + SCROLL_HOLD_SECONDS).max(min_seconds) };
    let total = tile_up(needed, segment);
    let (rest, here) = (total - b.t, b.pos);
    b.add(rest, here, None);
    Timeline { phases: b.phases, starts, total, max_scroll }
}

/// How far the page is scrolled at time t, as one ffmpeg expression.
pub fn scroll_expression(phases: &[Phase]) -> String {
    let Some(last) = phases.last() else { return s("0") };
    let mut expr = n3(last.to);
    for p in phases.iter().rev() {
        let value = if p.from == p.to {
            n3(p.from)
        } else {
            format!("{}+{}*(t-{})", n3(p.from), n3((p.to - p.from) / (p.end - p.start)), n3(p.start))
        };
        expr = format!("if(lt(t,{}),{value},{expr})", n3(p.end));
    }
    expr
}

/// `bufsize` = twice the maxrate (`2500k` -> `5000k`, `4M` -> `8M`).
fn bufsize(maxrate: &str) -> String {
    let digits_at = maxrate.find(|c: char| c.is_ascii_digit());
    let Some(start) = digits_at else { return maxrate.to_owned() };
    let end = maxrate[start..].find(|c: char| !c.is_ascii_digit()).map_or(maxrate.len(), |e| start + e);
    let doubled = maxrate[start..end].parse::<u64>().map_or_else(|_| maxrate[start..end].to_owned(), |n| (n * 2).to_string());
    format!("{}{doubled}{}", &maxrate[..start], &maxrate[end..])
}

fn x264_args(p: &MediaParams) -> Vec<String> {
    vec![
        s("-c:v"), s("libx264"), s("-preset"), p.preset.clone(), s("-crf"), p.crf.to_string(),
        s("-maxrate"), p.maxrate.clone(), s("-bufsize"), bufsize(&p.maxrate),
        s("-profile:v"), s("high"), s("-pix_fmt"), s("yuv420p"),
    ]
}

fn aac_args() -> Vec<String> {
    ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100"].map(s).to_vec()
}

/// Encode settings shared by EVERY clip.
fn clip_encode_args(p: &MediaParams, seconds: f64) -> Vec<String> {
    let mut v = x264_args(p);
    v.extend([s("-r"), p.fps.to_string(), s("-force_key_frames"), format!("expr:gte(t,n_forced*{})", p.hls_time)]);
    v.extend(aac_args());
    v.extend([s("-t"), n3(seconds), s("-video_track_timescale"), s("90000"), s("-movflags"), s("+faststart")]);
    v
}

/// A video placed on the page, for the clip.
#[derive(Debug, Clone)]
pub struct ClipVideo {
    pub file: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub start: f64,
    pub duration: f64,
    pub has_audio: bool,
}

/// The inputs of one article clip.
#[derive(Debug, Clone)]
pub struct ClipInputs<'a> {
    pub background: &'a str,
    pub layer: &'a str,
    pub edges: &'a str,
    pub indicator: Option<&'a str>,
    pub videos: &'a [ClipVideo],
    pub phases: &'a [Phase],
    pub seconds: f64,
    pub music: &'a str,
    pub out: &'a str,
}

/// One article -> its clip. Videos are overlaid at `y - scroll(t)` so they
/// move with the page; music ducks under a video with sound.
pub fn article_clip_args(p: &MediaParams, c: &ClipInputs<'_>) -> Vec<String> {
    let fps = p.fps;
    let (w, h) = (p.width, p.height);
    let total = n3(c.seconds);
    let still = |file: &str| vec![s("-loop"), s("1"), s("-framerate"), fps.to_string(), s("-t"), total.clone(), s("-i"), file.to_owned()];
    let scroll = scroll_expression(c.phases);

    let mut inputs: Vec<String> = [still(c.background), still(c.layer), still(c.edges)].concat();
    let mut next = 3;
    let indicator_index = c.indicator.map(|file| {
        inputs.extend(still(file));
        next += 1;
        next - 1
    });
    let video_index: Vec<usize> = c.videos.iter().map(|_| {
        next += 1;
        next - 1
    }).collect();
    for v in c.videos {
        inputs.extend([s("-i"), v.file.clone()]);
    }
    let music_index = next;
    inputs.extend([s("-stream_loop"), s("-1"), s("-i"), c.music.to_owned()]);

    let mut graph = vec![
        format!("[1:v]crop={w}:{h}:0:'{scroll}'[page]"),
        format!("[0:v]scale={w}:{h},setsar=1[bg]"),
        s("[bg][page]overlay=0:0:format=auto[p0]"),
    ];
    for (k, v) in c.videos.iter().enumerate() {
        graph.push(format!(
            "[{}:v]scale={}:{},setsar=1,fps={fps},tpad=start_mode=clone:start_duration={}:stop_mode=clone:stop_duration={total}[v{k}]",
            video_index[k], v.width, v.height, n3(v.start)
        ));
        graph.push(format!("[p{k}][v{k}]overlay=x={}:y='{}-({scroll})':eval=frame:format=auto[p{}]", v.x, v.y, k + 1));
    }
    let mut top = format!("p{}", c.videos.len());
    graph.push(format!("[{top}][2:v]overlay=0:0:format=auto[edged]"));
    top = s("edged");
    if let Some(i) = indicator_index {
        graph.push(format!("[{top}][{i}:v]overlay=0:0:format=auto[chip]"));
        top = s("chip");
    }
    graph.push(format!("[{top}]setsar=1,format=yuv420p[v]"));

    let voiced: Vec<(usize, &ClipVideo)> = c.videos.iter().enumerate().filter(|(_, v)| v.has_audio).collect();
    let silence = voiced.iter().map(|(_, v)| format!("between(t,{},{})", n3(v.start), n3(v.start + v.duration))).collect::<Vec<_>>().join("+");
    let fade_out = n3((c.seconds - 0.8).max(0.0));
    graph.push(format!(
        "[{music_index}:a]aresample=44100,aformat=channel_layouts=stereo,{}afade=t=in:d=0.5,afade=t=out:st={fade_out}:d=0.8[{}]",
        if silence.is_empty() { String::new() } else { format!("volume='1-min(1,{silence})':eval=frame,") },
        if voiced.is_empty() { "a" } else { "music" }
    ));
    if !voiced.is_empty() {
        for (k, v) in &voiced {
            let delay = (v.start * 1000.0).round() as i64;
            graph.push(format!("[{}:a]aresample=44100,aformat=channel_layouts=stereo,adelay={delay}:all=1,apad[va{k}]", video_index[*k]));
        }
        let labels: String = voiced.iter().map(|(k, _)| format!("[va{k}]")).collect();
        graph.push(format!("[music]{labels}amix=inputs={}:duration=first:normalize=0[a]", voiced.len() + 1));
    }

    let mut out = vec![s("-y")];
    out.extend(inputs);
    out.extend([s("-filter_complex"), graph.join(";"), s("-map"), s("[v]"), s("-map"), s("[a]")]);
    out.extend(clip_encode_args(p, c.seconds));
    out.push(c.out.to_owned());
    out
}

/// An uploaded video -> the copy that is kept: fitted within the channel
/// resolution, constant frame rate, AAC sound. Run once at upload.
pub fn video_normalize_args(p: &MediaParams, input: &str, has_audio: bool, out: &str) -> Vec<String> {
    let mut v = vec![s("-y"), s("-i"), input.to_owned(), s("-map"), s("0:v:0")];
    if has_audio {
        v.extend([s("-map"), s("0:a:0")]);
    }
    v.extend([
        s("-vf"),
        format!("scale={}:{}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps={},format=yuv420p", p.width, p.height, p.fps),
    ]);
    v.extend(x264_args(p));
    if has_audio {
        v.extend(aac_args());
    } else {
        v.push(s("-an"));
    }
    v.extend([s("-movflags"), s("+faststart"), out.to_owned()]);
    v
}

/// The video's first frame, for the editor and the page layout.
pub fn video_poster_args(input: &str, out: &str) -> Vec<String> {
    vec![s("-y"), s("-i"), input.to_owned(), s("-frames:v"), s("1"), s("-vf"), s("scale=960:-2"), s("-q:v"), s("4"), out.to_owned()]
}

/// Repeats of the clip list needed to fill one live window.
pub fn loop_repeats(p: &MediaParams, total_seconds: f64) -> usize {
    if !p.live_loop || total_seconds <= 0.0 {
        return 1;
    }
    ((LIVE_WINDOW_SEGMENTS as f64 * f64::from(p.hls_time) / total_seconds - 1e-9).ceil() as usize).max(1)
}

/// The concat demuxer's list file (quote-escaped as the format requires).
pub fn concat_list(files: &[String]) -> String {
    files.iter().map(|f| format!("file '{}'\n", f.replace('\'', "'\\''"))).collect()
}

/// The loop: every clip joined (video stream copy; audio re-encoded with
/// `aresample=async` because copied AAC overlaps by a few ms at each join).
pub fn loop_args(p: &MediaParams, list: &str, out_dir: &str) -> Vec<String> {
    let mut v = vec![s("-y"), s("-f"), s("concat"), s("-safe"), s("0"), s("-i"), list.to_owned(), s("-map"), s("0:v"), s("-map"), s("0:a"), s("-c:v"), s("copy"), s("-af"), s("aresample=async=1:first_pts=0")];
    v.extend(aac_args());
    v.extend([
        s("-f"), s("hls"), s("-hls_time"), p.hls_time.to_string(), s("-hls_list_size"), s("0"),
        s("-hls_flags"), s("independent_segments"), s("-hls_playlist_type"), s("vod"),
        s("-hls_segment_filename"), format!("{out_dir}/seg_%03d.ts"), format!("{out_dir}/index.m3u8"),
    ]);
    v
}

/// What ffprobe knows about a file.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Probe {
    pub duration: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub width: u32,
    pub height: u32,
}

pub fn parse_probe(json: &Value) -> Probe {
    let streams = json.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
    let video = streams.iter().find(|st| {
        st.get("codec_type").and_then(Value::as_str) == Some("video") && st.pointer("/disposition/attached_pic").and_then(Value::as_i64) != Some(1)
    });
    let num = |v: Option<&Value>| v.and_then(|x| x.as_str().and_then(|s| s.parse().ok()).or_else(|| x.as_f64())).filter(|f: &f64| *f > 0.0);
    Probe {
        duration: num(json.pointer("/format/duration")).or_else(|| num(video.and_then(|v| v.get("duration")))).unwrap_or(0.0),
        has_video: video.is_some(),
        has_audio: streams.iter().any(|st| st.get("codec_type").and_then(Value::as_str) == Some("audio")),
        width: video.and_then(|v| v.get("width")).and_then(Value::as_u64).unwrap_or(0) as u32,
        height: video.and_then(|v| v.get("height")).and_then(Value::as_u64).unwrap_or(0) as u32,
    }
}

pub async fn probe_media(ffprobe: &str, file: &str) -> anyhow::Result<Probe> {
    let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file].map(s).to_vec();
    let out = capture(ffprobe, &args, "ffprobe").await?;
    Ok(parse_probe(&serde_json::from_str(&out)?))
}

/// `String(x)` re-export for callers formatting durations the JS way.
pub fn num(v: f64) -> String {
    js_num(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Map, json};

    fn profile(name: &str) -> MediaParams {
        match name {
            "alt" => MediaParams { width: 1920, height: 1080, hls_time: 4, live_loop: true, fps: 30, preset: s("faster"), crf: 22, maxrate: s("4M") },
            _ => MediaParams { width: 1280, height: 720, hls_time: 6, live_loop: true, fps: 25, preset: s("veryfast"), crf: 24, maxrate: s("2500k") },
        }
    }

    fn clip(p: &MediaParams, videos: &[ClipVideo], indicator: Option<&str>, t: &Timeline) -> Vec<String> {
        article_clip_args(p, &ClipInputs { background: "/w/bg.png", layer: "/w/page.png", edges: "/w/edges.png", indicator, videos, phases: &t.phases, seconds: t.total, music: "/m/music.mp3", out: "/w/clip.mp4" })
    }

    fn text_only(p: &MediaParams) -> Vec<String> {
        let t = article_timeline(720.0, 720.0, &[], 40.0, 15.0, f64::from(p.hls_time));
        clip(p, &[], None, &t)
    }
    fn scrolling(p: &MediaParams) -> Vec<String> {
        let t = article_timeline(2000.0, f64::from(p.height), &[], 60.0, 0.0, f64::from(p.hls_time));
        clip(p, &[], Some("/w/chip.png"), &t)
    }
    fn with_videos(p: &MediaParams) -> Vec<String> {
        let tv = [
            TimelineVideo { y: 900.0, height: 612.0, focus: Some(650.0), duration: 7.5 },
            TimelineVideo { y: 1800.0, height: 640.0, focus: None, duration: 4.0 },
        ];
        let t = article_timeline(2600.0, f64::from(p.height), &tv, 40.0, 0.0, f64::from(p.hls_time));
        let videos = [
            ClipVideo { file: s("/f/a.mp4"), x: 96, y: 900, width: 1088, height: 612, start: t.starts[0], duration: 7.5, has_audio: true },
            ClipVideo { file: s("/f/b.mp4"), x: 460, y: 1800, width: 360, height: 640, start: t.starts[1], duration: 4.0, has_audio: false },
        ];
        clip(p, &videos, Some("/w/chip.png"), &t)
    }

    const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/media-args.golden.json");

    #[test]
    fn media_args_are_byte_identical_to_golden() {
        let (d, a) = (profile("default"), profile("alt"));
        let cases: Vec<(&str, Vec<String>)> = vec![
            ("article-text-default", text_only(&d)),
            ("article-scroll-default", scrolling(&d)),
            ("article-scroll-alt", scrolling(&a)),
            ("article-videos-default", with_videos(&d)),
            ("article-videos-alt", with_videos(&a)),
            ("normalize-audio-default", video_normalize_args(&d, "/in/raw.mov", true, "/f/x.tmp.mp4")),
            ("normalize-silent-alt", video_normalize_args(&a, "/in/raw.webm", false, "/f/x.tmp.mp4")),
            ("poster-default", video_poster_args("/f/x.mp4", "/t/x.jpg")),
            ("loop-default", loop_args(&d, "/h/.build/list.txt", "/h/.build")),
            ("loop-alt", loop_args(&a, "/h/.build/list.txt", "/h/.build")),
        ];
        let computed: Map<String, Value> = cases.into_iter().map(|(k, v)| (k.to_owned(), json!(v))).collect();
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::write(GOLDEN, serde_json::to_string_pretty(&computed).unwrap() + "\n").unwrap();
        }
        let golden: Map<String, Value> = serde_json::from_str(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
        for (name, expected) in &golden {
            assert_eq!(computed.get(name), Some(expected), "case {name} differs from the golden argv");
        }
        assert_eq!(computed.len(), golden.len());
    }

    #[test]
    fn every_clip_shares_stream_parameters() {
        let d = profile("default");
        let tail = |a: Vec<String>| {
            let start = a.iter().position(|x| x == "-c:v").unwrap();
            let end = start + a[start..].iter().position(|x| x == "-t").unwrap();
            a[start..end].to_vec()
        };
        assert_eq!(tail(text_only(&d)), tail(with_videos(&d)));
    }

    #[test]
    fn timeline_rules() {
        assert!((tile_up(1.0, 6.0) - 6.0).abs() < 1e-9 && (tile_up(6.0, 6.0) - 6.0).abs() < 1e-9);
        assert!((tile_up(6.01, 6.0) - 12.0).abs() < 1e-9 && (tile_up(0.0, 6.0) - 6.0).abs() < 1e-9);
        let t = article_timeline(720.0, 720.0, &[], 40.0, 15.0, 6.0);
        assert!((t.total - 18.0).abs() < 1e-9 && t.max_scroll == 0.0);
        let t = article_timeline(1920.0, 720.0, &[], 40.0, 15.0, 6.0);
        assert!((t.total - 36.0).abs() < 1e-9);
        assert_eq!(t.phases.iter().map(|p| (p.from, p.to)).collect::<Vec<_>>(), [(0.0, 0.0), (0.0, 1200.0), (1200.0, 1200.0)]);

        let vids = [TimelineVideo { y: 1000.0, height: 400.0, focus: None, duration: 10.0 }, TimelineVideo { y: 300.0, height: 200.0, focus: None, duration: 5.0 }];
        let t = article_timeline(3000.0, 720.0, &vids, 50.0, 0.0, 6.0);
        let playing: Vec<&Phase> = t.phases.iter().filter(|p| p.video.is_some()).collect();
        assert_eq!(playing.iter().map(|p| p.video.unwrap()).collect::<Vec<_>>(), [1, 0]);
        assert_eq!(playing.iter().map(|p| p.from).collect::<Vec<_>>(), [40.0, 840.0]);
        assert!((t.starts[1] - (3.0 + 40.0 / 50.0)).abs() < 1e-9);
        assert!((t.phases.last().unwrap().end - t.total).abs() < 1e-9 && (t.total % 6.0).abs() < 1e-9);

        let t = article_timeline(720.0, 720.0, &[TimelineVideo { y: 200.0, height: 300.0, focus: None, duration: 4.0 }], 40.0, 15.0, 6.0);
        assert_eq!((t.max_scroll, t.starts[0], t.total), (0.0, 3.0, 18.0));
    }

    #[test]
    fn helpers() {
        let mut d = profile("default");
        assert_eq!(loop_repeats(&d, 6.0), 8);
        assert_eq!(loop_repeats(&d, 18.0), 3);
        assert_eq!(loop_repeats(&d, 48.0), 1);
        d.live_loop = false;
        assert_eq!(loop_repeats(&d, 6.0), 1);
        assert_eq!(concat_list(&[s("/a/b.mp4"), s("/c/it's.mp4")]), "file '/a/b.mp4'\nfile '/c/it'\\''s.mp4'\n");
        assert_eq!((bufsize("2500k").as_str(), bufsize("4M").as_str()), ("5000k", "8M"));
        let probe = parse_probe(&json!({"format": {"duration": "12.5"}, "streams": [{"codec_type": "video", "width": 1920, "height": 1080}, {"codec_type": "audio"}]}));
        assert_eq!(probe, Probe { duration: 12.5, has_video: true, has_audio: true, width: 1920, height: 1080 });
    }
}
