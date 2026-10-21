//! ffmpeg argument builders for the info channel ([`intro_ffmpeg_args`] /
//! [`still_ffmpeg_args`]).
//!
//! These are PINNED by a byte-identity golden snapshot
//! (`tests/fixtures/ffmpeg-args.golden.json`, the same file the Node version
//! was pinned by). Real strict-player playback can't be exercised in CI, so
//! byte-identical argv is the proof that a refactor changed nothing. Only when
//! you *intend* to change the encode do you regenerate it, from known-good
//! code, with `UPDATE_GOLDEN=1 cargo test channel_args`. Never rewrite the
//! snapshot silently just to make a red test go green.

use std::fmt::Write as _;
use std::path::Path;

use super::ffmpeg::{js_fixed, js_num};
use super::liveloop::LIVE_WINDOW_SEGMENTS;

/// Everything the builders read from the config.
#[derive(Debug, Clone)]
pub struct EncodeParams {
    pub account_slide_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub still_fps: u32,
    pub preset: String,
    pub hls_time: u32,
    pub live_loop: bool,
    pub timer_enabled: bool,
    pub timer_font_file: String,
    pub intro_slide_seconds: f64,
    pub transition: String,
    pub status_seconds: f64,
}

impl EncodeParams {
    pub fn from_config(c: &crate::config::Config) -> Self {
        Self {
            account_slide_seconds: c.channel.account_slide_seconds,
            width: c.channel.width,
            height: c.channel.height,
            fps: c.channel.fps,
            still_fps: c.channel.still_fps,
            preset: c.channel.preset.clone(),
            hls_time: c.channel.hls_time,
            live_loop: c.channel.live_loop,
            timer_enabled: c.channel.slide_timer.enabled,
            timer_font_file: c.channel.slide_timer.font_file.clone(),
            intro_slide_seconds: c.intro.slide_seconds,
            transition: c.intro.transition.clone(),
            status_seconds: c.status_slide.seconds,
        }
    }
}

/// The rendered frames of an intro-path encode.
#[derive(Debug, Clone)]
pub struct Slides<'a> {
    pub slide1: &'a Path,
    pub card: &'a Path,
    pub status: Option<&'a Path>,
}

/// A global slide appended after the card.
#[derive(Debug, Clone)]
pub struct Extra<'a> {
    pub file: &'a Path,
    pub seconds: f64,
}

fn s(v: &str) -> String {
    v.to_owned()
}

fn path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Common HLS output args. ffmpeg writes a finite VOD asset; `liveloop`
/// serves it as one shared, always-running live channel.
fn hls_out_args(p: &EncodeParams, tmp: &Path) -> Vec<String> {
    vec![
        s("-f"),
        s("hls"),
        s("-hls_time"),
        p.hls_time.to_string(),
        s("-hls_list_size"),
        s("0"),
        s("-hls_flags"),
        s("independent_segments"),
        s("-hls_playlist_type"),
        s("vod"),
        s("-hls_segment_filename"),
        path(&tmp.join("seg_%03d.ts")),
        path(&tmp.join("index.m3u8")),
    ]
}

/// Keyframes forced exactly on the HLS segment boundaries (not a fixed GOP),
/// so segments stay clean even at very low frame rates.
fn video_encode_args(p: &EncodeParams, fps: u32) -> Vec<String> {
    vec![
        s("-c:v"),
        s("libx264"),
        s("-preset"),
        p.preset.clone(),
        s("-tune"),
        s("stillimage"),
        s("-pix_fmt"),
        s("yuv420p"),
        s("-r"),
        fps.to_string(),
        s("-force_key_frames"),
        format!("expr:gte(t,n_forced*{})", p.hls_time),
        s("-sc_threshold"),
        s("0"),
    ]
}

fn audio_encode_args() -> Vec<String> {
    ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100"]
        .map(s)
        .to_vec()
}

fn intro_output_args(p: &EncodeParams, audio_index: usize, a_out: &str, tmp: &Path) -> Vec<String> {
    let mut v = vec![
        s("-map"),
        s("[v]"),
        s("-map"),
        format!("{audio_index}:a"),
        s("-af"),
        format!("afade=t=in:d=1,afade=t=out:st={a_out}:d=2"),
    ];
    v.extend(video_encode_args(p, p.fps));
    v.extend(audio_encode_args());
    v.push(s("-shortest"));
    v.extend(hls_out_args(p, tmp));
    v
}

/// Bottom-right "next slide in N" countdown via drawtext. `boundaries` are
/// the times (s) at which the visible slide changes, ending with the total.
///
/// Escaping: single quotes protect spaces/commas at the filtergraph level, but
/// ffmpeg strips them before splitting options on ':', so the colons inside
/// `%{eif:…:d}` must additionally be backslash-escaped.
fn slide_timer_filters(p: &EncodeParams, boundaries: &[f64]) -> Option<String> {
    if !p.timer_enabled || boundaries.is_empty() {
        return None;
    }
    let font = if p.timer_font_file.is_empty() {
        s("font=Inter")
    } else {
        format!("fontfile='{}'", p.timer_font_file)
    };
    let mut prev = 0.0;
    let parts: Vec<String> = boundaries
        .iter()
        .map(|&b| {
            let (start, end) = (js_fixed(prev, 2), js_fixed(b, 2));
            prev = b;
            format!(
                "drawtext={font}:text='Далее через %{{eif\\:ceil({end}-t)\\:d}}':fontcolor=white:fontsize=28:box=1:boxcolor=0x0f1830@0.85:boxborderw=18:x=w-tw-40:y=h-th-34:enable='between(t,{start},{end})'"
            )
        })
        .collect();
    Some(parts.join(","))
}

fn with_slide_timer(p: &EncodeParams, filter: String, boundaries: &[f64]) -> String {
    match slide_timer_filters(p, boundaries) {
        Some(timer) => {
            let base = filter
                .strip_suffix("[v]")
                .map_or_else(|| filter.clone(), |b| format!("{b}[vbase]"));
            format!("{base};[vbase]{timer}[v]")
        }
        None => filter,
    }
}

/// Round a loop length to the NEAREST whole number of segments (the card
/// absorbs the slack), and — when served live — never below one live window,
/// or the window would wrap inside a single playlist.
pub fn tile_to_segments(p: &EncodeParams, seconds: f64) -> f64 {
    let seg = f64::from(p.hls_time);
    let tiled = seg.max((seconds / seg).round() * seg);
    if !p.live_loop {
        return tiled;
    }
    tiled.max(LIVE_WINDOW_SEGMENTS as f64 * seg)
}

const XF: f64 = 0.8;

/// Animated channel: brand slide -> (xfade) -> card -> [status], with music.
pub fn intro_ffmpeg_args(p: &EncodeParams, slides: &Slides<'_>, music: &Path, tmp: &Path) -> Vec<String> {
    let extras: Vec<Extra<'_>> = slides
        .status
        .iter()
        .map(|f| Extra {
            file: f,
            seconds: p.status_seconds,
        })
        .collect();
    if extras.is_empty() {
        intro_card_only_args(p, slides, music, tmp)
    } else {
        intro_with_extras_args(p, slides.slide1, slides.card, &extras, music, tmp)
    }
}

fn frame_filter(p: &EncodeParams, i: usize, fade: &str) -> String {
    format!(
        "[{i}:v]scale={}:{},setsar=1,fps={},format=yuv420p{fade}",
        p.width, p.height, p.fps
    )
}

fn intro_card_only_args(p: &EncodeParams, slides: &Slides<'_>, music: &Path, tmp: &Path) -> Vec<String> {
    let card_dur = p.account_slide_seconds.max(6.0);
    let slide = (XF + 0.5).max(p.intro_slide_seconds);
    let total = tile_to_segments(p, slide + card_dur - XF);
    let card_hold = total - slide + XF;
    let o1 = js_fixed(slide - XF, 2);
    let fos = js_fixed(card_hold - 0.6, 2);
    let a_out = js_fixed((total - 2.0).max(0.0), 2);

    let base = format!(
        "{}[v0];{}[v1];[v0][v1]xfade=transition={}:duration={}:offset={o1}[v]",
        frame_filter(p, 0, ",fade=t=in:st=0:d=0.6"),
        frame_filter(p, 1, &format!(",fade=t=out:st={fos}:d=0.6")),
        p.transition,
        js_num(XF),
    );
    let filter = with_slide_timer(p, base, &[slide - XF, slide + card_hold - XF]);

    let mut v = vec![
        s("-y"),
        s("-loop"),
        s("1"),
        s("-t"),
        js_num(slide),
        s("-i"),
        path(slides.slide1),
    ];
    v.extend([
        s("-loop"),
        s("1"),
        s("-t"),
        js_fixed(card_hold, 2),
        s("-i"),
        path(slides.card),
    ]);
    v.extend([
        s("-stream_loop"),
        s("-1"),
        s("-i"),
        path(music),
        s("-filter_complex"),
        filter,
    ]);
    v.extend(intro_output_args(p, 2, &a_out, tmp));
    v
}

fn intro_with_extras_args(
    p: &EncodeParams,
    slide1: &Path,
    card: &Path,
    extras: &[Extra<'_>],
    music: &Path,
    tmp: &Path,
) -> Vec<String> {
    let card_dur = p.account_slide_seconds.max(6.0);
    let slide = (XF + 0.5).max(p.intro_slide_seconds);
    let extra_lens: Vec<f64> = extras.iter().map(|e| (XF + 1.0).max(e.seconds)).collect();
    let k = extras.len() as f64;
    let sum_extras: f64 = extra_lens.iter().sum();
    let total = tile_to_segments(p, slide + card_dur + sum_extras - (k + 1.0) * XF);
    let card_hold = total - slide - sum_extras + (k + 1.0) * XF;

    let lens: Vec<f64> = [slide, card_hold]
        .into_iter()
        .chain(extra_lens.iter().copied())
        .collect();
    let n = lens.len();
    let frames: String = lens
        .iter()
        .enumerate()
        .map(|(i, len)| {
            let fade = if i == 0 {
                s(",fade=t=in:st=0:d=0.6")
            } else if i == n - 1 {
                format!(",fade=t=out:st={}:d=0.6", js_fixed(len - 0.6, 2))
            } else {
                String::new()
            };
            format!("{}[v{i}];", frame_filter(p, i, &fade))
        })
        .collect();

    // Chained xfades; the one bringing in frame f starts at (sum of lengths
    // before f) - f*XF. Labels: vx, vx2, vx3… so the 3-frame argv is stable.
    let mut boundaries = Vec::new();
    let mut xfades = String::new();
    let mut prev = s("v0");
    let mut cumulative = 0.0;
    for f in 1..n {
        cumulative += lens[f - 1];
        let offset = cumulative - f as f64 * XF;
        boundaries.push(offset);
        let out = if f == n - 1 {
            s("v")
        } else if f == 1 {
            s("vx")
        } else {
            format!("vx{f}")
        };
        let _ = write!(
            xfades,
            "[{prev}][v{f}]xfade=transition={}:duration={}:offset={}[{out}]{}",
            p.transition,
            js_num(XF),
            js_fixed(offset, 2),
            if f < n - 1 { ";" } else { "" }
        );
        prev = out;
    }
    boundaries.push(total);
    let a_out = js_fixed((total - 2.0).max(0.0), 2);
    let filter = with_slide_timer(p, frames + &xfades, &boundaries);

    let mut v = vec![
        s("-y"),
        s("-loop"),
        s("1"),
        s("-t"),
        js_num(slide),
        s("-i"),
        path(slide1),
    ];
    v.extend([s("-loop"), s("1"), s("-t"), js_fixed(card_hold, 2), s("-i"), path(card)]);
    for (extra, len) in extras.iter().zip(&extra_lens) {
        v.extend([
            s("-loop"),
            s("1"),
            s("-t"),
            js_fixed(*len, 2),
            s("-i"),
            path(extra.file),
        ]);
    }
    v.extend([
        s("-stream_loop"),
        s("-1"),
        s("-i"),
        path(music),
        s("-filter_complex"),
        filter,
    ]);
    v.extend(intro_output_args(p, n, &a_out, tmp));
    v
}

/// Plain still loop (intro disabled): card -> [extras] with hard cuts.
pub fn still_ffmpeg_args(p: &EncodeParams, card: &Path, extras: &[Extra<'_>], music: &Path, tmp: &Path) -> Vec<String> {
    let fps = p.still_fps;
    let card_dur = p.account_slide_seconds.max(6.0);
    if extras.is_empty() {
        let mut v = vec![
            s("-y"),
            s("-loop"),
            s("1"),
            s("-i"),
            path(card),
            s("-stream_loop"),
            s("-1"),
            s("-i"),
            path(music),
        ];
        v.extend([
            s("-t"),
            js_num(tile_to_segments(p, card_dur)),
            s("-map"),
            s("0:v"),
            s("-map"),
            s("1:a"),
        ]);
        v.extend(video_encode_args(p, fps));
        v.extend(audio_encode_args());
        v.extend(hls_out_args(p, tmp));
        return v;
    }

    let extra_lens: Vec<f64> = extras.iter().map(|e| e.seconds.max(2.0)).collect();
    let sum_extras: f64 = extra_lens.iter().sum();
    let card_hold = tile_to_segments(p, card_dur + sum_extras) - sum_extras;
    let lens: Vec<f64> = std::iter::once(card_hold).chain(extra_lens.iter().copied()).collect();
    let m = lens.len();

    let frames: String = (0..m)
        .map(|i| format!("[{i}:v]fps={fps},format=yuv420p,setsar=1[c{i}];"))
        .collect();
    let inputs: String = (0..m).map(|i| format!("[c{i}]")).collect();
    let base = format!("{frames}{inputs}concat=n={m}:v=1:a=0[v]");
    let boundaries: Vec<f64> = lens
        .iter()
        .scan(0.0, |acc, len| {
            *acc += len;
            Some(*acc)
        })
        .collect();
    let filter = with_slide_timer(p, base, &boundaries);

    let mut v = vec![
        s("-y"),
        s("-loop"),
        s("1"),
        s("-t"),
        js_fixed(card_hold, 2),
        s("-i"),
        path(card),
    ];
    for (extra, len) in extras.iter().zip(&extra_lens) {
        v.extend([
            s("-loop"),
            s("1"),
            s("-t"),
            js_fixed(*len, 2),
            s("-i"),
            path(extra.file),
        ]);
    }
    v.extend([
        s("-stream_loop"),
        s("-1"),
        s("-i"),
        path(music),
        s("-filter_complex"),
        filter,
    ]);
    v.extend([s("-map"), s("[v]"), s("-map"), format!("{m}:a")]);
    v.extend(video_encode_args(p, fps));
    v.extend(audio_encode_args());
    v.push(s("-shortest"));
    v.extend(hls_out_args(p, tmp));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Map, Value};

    fn profile(name: &str) -> EncodeParams {
        let base = EncodeParams {
            account_slide_seconds: 120.0,
            width: 1280,
            height: 720,
            fps: 12,
            still_fps: 4,
            preset: "ultrafast".into(),
            hls_time: 6,
            live_loop: true,
            timer_enabled: true,
            timer_font_file: String::new(),
            intro_slide_seconds: 4.0,
            transition: "slideleft".into(),
            status_seconds: 12.0,
        };
        match name {
            "timerOff" => EncodeParams {
                timer_enabled: false,
                ..base
            },
            "fontFile" => EncodeParams {
                timer_font_file: "/fonts/Inter.ttf".into(),
                ..base
            },
            "alt" => EncodeParams {
                account_slide_seconds: 90.0,
                width: 1920,
                height: 1080,
                fps: 10,
                still_fps: 5,
                preset: "veryfast".into(),
                hls_time: 4,
                intro_slide_seconds: 5.0,
                transition: "fade".into(),
                status_seconds: 15.0,
                ..base
            },
            _ => base,
        }
    }

    fn compute() -> Map<String, Value> {
        let (slide1, card, status) = (
            Path::new("/t/slide1.png"),
            Path::new("/t/card.png"),
            Path::new("/t/status.png"),
        );
        let (music, tmp) = (Path::new("/m/music.mp3"), Path::new("/t"));
        let plain = Slides {
            slide1,
            card,
            status: None,
        };
        let with_status = Slides {
            status: Some(status),
            ..plain.clone()
        };
        let intro = |name: &str, slides: &Slides<'_>| intro_ffmpeg_args(&profile(name), slides, music, tmp);
        let still = |name: &str, with: bool| {
            let p = profile(name);
            let extras: Vec<Extra<'_>> = if with {
                vec![Extra {
                    file: status,
                    seconds: p.status_seconds,
                }]
            } else {
                vec![]
            };
            still_ffmpeg_args(&p, card, &extras, music, tmp)
        };
        let cases: Vec<(&str, Vec<String>)> = vec![
            ("intro-card-default", intro("default", &plain)),
            ("intro-card-timerOff", intro("timerOff", &plain)),
            ("intro-card-fontFile", intro("fontFile", &plain)),
            ("intro-status-default", intro("default", &with_status)),
            ("intro-status-timerOff", intro("timerOff", &with_status)),
            ("intro-status-alt", intro("alt", &with_status)),
            ("still-nostatus-default", still("default", false)),
            ("still-status-default", still("default", true)),
            ("still-status-timerOff", still("timerOff", true)),
            ("still-status-alt", still("alt", true)),
        ];
        cases
            .into_iter()
            .map(|(k, v)| (k.to_owned(), serde_json::json!(v)))
            .collect()
    }

    const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ffmpeg-args.golden.json");

    #[test]
    fn argv_is_byte_identical_to_golden() {
        let computed = compute();
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            let text = serde_json::to_string_pretty(&computed).unwrap() + "\n";
            std::fs::write(GOLDEN, text).unwrap();
        }
        let golden: Map<String, Value> = serde_json::from_str(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
        for (name, expected) in &golden {
            assert_eq!(
                computed.get(name),
                Some(expected),
                "case {name} differs from the golden argv"
            );
        }
        assert_eq!(computed.len(), golden.len());
    }

    #[test]
    fn live_loop_never_shorter_than_window() {
        let mut p = EncodeParams {
            account_slide_seconds: 6.0,
            ..profile("default")
        };
        let floor = LIVE_WINDOW_SEGMENTS as f64 * f64::from(p.hls_time);
        assert!((floor - 48.0).abs() < f64::EPSILON);
        let (card, music, tmp) = (Path::new("/t/card.png"), Path::new("/m/music.mp3"), Path::new("/t"));
        let still = still_ffmpeg_args(&p, card, &[], music, tmp);
        let t = still.iter().position(|a| a == "-t").unwrap();
        assert_eq!(still[t + 1], "48");
        let slides = Slides {
            slide1: Path::new("/t/slide1.png"),
            card,
            status: Some(Path::new("/t/status.png")),
        };
        let intro = intro_ffmpeg_args(&p, &slides, music, tmp);
        let af = intro.iter().position(|a| a == "-af").unwrap();
        assert!(intro[af + 1].contains("afade=t=out:st=46.00"));
        p.live_loop = false;
        let vod = still_ffmpeg_args(&p, card, &[], music, tmp);
        assert_eq!(vod[vod.iter().position(|a| a == "-t").unwrap() + 1], "6");
    }
}
