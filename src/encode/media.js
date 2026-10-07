// ffmpeg argument builders for the media channel (Информация -> «Медиа»).
//
// The channel is built in two steps, and the split is what keeps it cheap:
//
//   1. Every slide becomes its own CLIP (an .mp4): a text page, an image or a
//      720p copy of an uploaded video. Clips are cached by content hash
//      (media/build.js), so editing one slide re-encodes only that one.
//   2. The LOOP is the clips joined with the concat demuxer — the video by
//      stream copy, no re-encode; only the audio is re-encoded (see loopArgs) —
//      and cut into HLS segments that liveloop.js serves as one shared live
//      channel, exactly like the account channel.
//
// Step 2 is only correct because of two invariants every clip builder keeps:
//   - IDENTICAL encode parameters on every clip (size, fps, codec profile,
//     audio rate/layout — see clipEncodeArgs), so the copied stream is one
//     continuous stream to the player; no discontinuity is needed between
//     slides, and liveloop.js's single-discontinuity-per-wrap model holds.
//   - Every clip lasts a WHOLE NUMBER of HLS segments, with keyframes forced on
//     every segment boundary, so the HLS muxer cuts the joined stream into
//     equal segments and never leaves a runt mid-loop.
//
// These builders are pinned by a byte-identity golden snapshot
// (test/encode/media-args.test.js against test/fixtures/media-args.golden.json),
// for the same reason as the account channel's (see the comment atop the
// builders in encode/channel.js). Regenerate only for an intended change:
//   UPDATE_GOLDEN=1 node --test test/encode/media-args.test.js
import { config } from '../config.js';
import { LIVE_WINDOW_SEGMENTS } from './liveloop.js';
import { FFPROBE, capture } from './ffmpeg.js';

// The background colour a letterboxed video is padded with: the darkest stop
// of the channel background gradient (render/overlay.js).
const PAD_COLOR = '0x0b1224';
// Text pages hold still this long before they start scrolling, and at least
// this long once the end is on screen.
export const SCROLL_HOLD_SECONDS = 3;

// Round a slide's on-screen time UP to whole segments (never below one), so
// clips concatenate onto segment boundaries. Up, not nearest: a text page or a
// video must never be cut short.
export function tileUp(seconds, segment = config.channel.hlsTime) {
  return Math.max(segment, Math.ceil(seconds / segment - 1e-9) * segment);
}

// How long a text page is on screen. A page that fits one screen holds for its
// configured seconds; a taller one holds, scrolls to the bottom at `speed`
// logical px/s, and holds again — the bottom hold absorbs the rounding.
export function textSlideSeconds({ seconds, layerHeight, screenHeight, scale = 1, speed }) {
  const travel = Math.max(0, layerHeight - screenHeight);
  if (travel <= 2) return tileUp(seconds);
  return tileUp(2 * SCROLL_HOLD_SECONDS + travel / (speed * scale));
}

// Encode settings shared by EVERY clip — see the invariants at the top.
function clipEncodeArgs(seconds) {
  const { fps, preset, crf, maxrate } = config.media;
  const seg = config.channel.hlsTime;
  return [
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-maxrate', maxrate, '-bufsize', maxrate.replace(/(\d+)/, (n) => String(Number(n) * 2)),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-force_key_frames', `expr:gte(t,n_forced*${seg})`,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
    '-t', seconds.toFixed(3),
    '-video_track_timescale', '90000',
    '-movflags', '+faststart',
  ];
}

// Background music for a slide that has no sound of its own, faded at both
// ends so the cut to the next slide doesn't click.
function musicFilter(input, seconds) {
  const out = Math.max(0, seconds - 0.8).toFixed(2);
  return `[${input}:a]aresample=44100,aformat=channel_layouts=stereo,afade=t=in:d=0.5,afade=t=out:st=${out}:d=0.8[a]`;
}

// A still frame (an image slide, or a text page that fits one screen).
export function stillClipArgs({ frame, seconds, music, out }) {
  const { fps } = config.media;
  const { width: W, height: H } = config.channel;
  return [
    '-y',
    '-loop', '1', '-framerate', String(fps), '-t', seconds.toFixed(3), '-i', frame,
    '-stream_loop', '-1', '-i', music,
    '-filter_complex',
    `[0:v]scale=${W}:${H},setsar=1,format=yuv420p[v];${musicFilter(1, seconds)}`,
    '-map', '[v]', '-map', '[a]',
    ...clipEncodeArgs(seconds),
    out,
  ];
}

// A text page taller than one screen, scrolling over the static background:
// hold at the top, glide down at `speed` (logical px/s), hold at the bottom.
// `edges` (the background's faded top/bottom bands) is laid over the text so
// lines fade in and out at the frame edge. `scale` converts logical px to
// output px.
export function scrollClipArgs({
  background, layer, edges, seconds, speed, scale = 1, music, out,
}) {
  const { fps } = config.media;
  const { width: W, height: H } = config.channel;
  const pxPerSecond = (speed * scale).toFixed(3);
  const y = `'min(max(0,(t-${SCROLL_HOLD_SECONDS})*${pxPerSecond}),ih-${H})'`;
  return [
    '-y',
    '-loop', '1', '-framerate', String(fps), '-t', seconds.toFixed(3), '-i', background,
    '-loop', '1', '-framerate', String(fps), '-t', seconds.toFixed(3), '-i', layer,
    '-loop', '1', '-framerate', String(fps), '-t', seconds.toFixed(3), '-i', edges,
    '-stream_loop', '-1', '-i', music,
    '-filter_complex',
    `[1:v]crop=${W}:${H}:0:${y}[t];`
    + `[0:v]scale=${W}:${H}[bg];`
    + '[bg][t]overlay=0:0:format=auto[x];'
    + `[x][2:v]overlay=0:0:format=auto,setsar=1,format=yuv420p[v];${musicFilter(3, seconds)}`,
    '-map', '[v]', '-map', '[a]',
    ...clipEncodeArgs(seconds),
    out,
  ];
}

// An uploaded video -> its clip: fitted into the frame (letterboxed on the
// channel background colour), its own sound kept — or the background music
// when it has none — and the last frame held until the clip ends on a segment
// boundary. Run once at upload; the result replaces the original on disk.
export function videoClipArgs({
  input, duration, hasAudio, music, out,
}) {
  const { fps } = config.media;
  const { width: W, height: H } = config.channel;
  const seconds = tileUp(duration);
  const pad = Math.max(0, seconds - duration + 1).toFixed(3);
  const video = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,`
    + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${PAD_COLOR},setsar=1,fps=${fps},format=yuv420p,`
    + `tpad=stop_mode=clone:stop_duration=${pad}[v]`;
  const audio = hasAudio
    ? '[0:a:0]aresample=44100,aformat=channel_layouts=stereo,apad[a]'
    : musicFilter(1, seconds);
  return [
    '-y',
    '-i', input,
    ...(hasAudio ? [] : ['-stream_loop', '-1', '-i', music]),
    '-filter_complex', `${video};${audio}`,
    '-map', '[v]', '-map', '[a]',
    ...clipEncodeArgs(seconds),
    out,
  ];
}

// A still for the admin list, a second into the video (or its first frame).
export function videoThumbArgs({ input, duration, out }) {
  return [
    '-y',
    '-ss', Math.min(1, Math.max(0, duration / 2)).toFixed(2),
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '5',
    out,
  ];
}

// How many times the clip list must repeat to fill one live window: below that
// liveloop.js would list the same segments twice in one playlist (see
// tileToSegments in encode/channel.js).
export function loopRepeats(totalSeconds) {
  if (!config.channel.liveLoop || totalSeconds <= 0) return 1;
  return Math.max(1, Math.ceil((LIVE_WINDOW_SEGMENTS * config.channel.hlsTime) / totalSeconds - 1e-9));
}

// The concat demuxer's list file. Paths are ours (hash-named clips under
// DATA_DIR), but quote-escaped anyway as the format requires.
export function concatList(files) {
  return `${files.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n')}\n`;
}

// The loop: every clip joined, cut into the same HLS layout the account
// channel uses so liveloop.js can serve it unchanged.
//
// Video is a stream copy. Audio is re-encoded (cheap: seconds of CPU for the
// whole loop) because AAC works in 1024-sample frames: a clip's last frame
// overhangs its video by a few ms, which an .mp4 hides with an edit list that a
// stream copy does not honour — so copied audio would overlap at every join,
// and strict players stumble on non-monotonic timestamps. `aresample=async`
// re-times the audio against the timestamps, dropping the overlap.
export function loopArgs({ list, outDir }) {
  return [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-map', '0:v', '-map', '0:a',
    '-c:v', 'copy',
    '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
    '-f', 'hls',
    '-hls_time', String(config.channel.hlsTime),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', `${outDir}/seg_%03d.ts`,
    `${outDir}/index.m3u8`,
  ];
}

// What ffprobe knows about an upload: { duration, hasVideo, hasAudio, width, height }.
export async function probeMedia(file) {
  const json = JSON.parse(await capture(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], 'ffprobe'));
  const streams = json.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const duration = Number(json.format?.duration) || Number(video?.duration) || 0;
  return {
    duration,
    hasVideo: !!video,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    width: video?.width || 0,
    height: video?.height || 0,
  };
}
