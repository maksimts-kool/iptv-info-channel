// ffmpeg argument builders for the media channel (Информация -> «Медиа»).
//
// The channel is built in two steps, and the split is what keeps it cheap:
//
//   1. Every ARTICLE becomes its own clip (an .mp4): its tall page scrolling
//      over the channel background, each video playing in its place on the page
//      while the scroll waits, and the «1/3 · title» chip in the corner. Clips
//      are cached by content hash (media/build.js), so editing one article
//      re-encodes only that one.
//   2. The LOOP is the clips joined with the concat demuxer — the video by
//      stream copy, no re-encode; only the audio is re-encoded (see loopArgs) —
//      and cut into HLS segments that liveloop.js serves as one shared live
//      channel, exactly like the account channel.
//
// Step 2 is only correct because of two invariants every clip keeps:
//   - IDENTICAL encode parameters on every clip (clipEncodeArgs), so the joined
//     video is one continuous stream to the player; no discontinuity is needed
//     between articles, and liveloop.js's one-discontinuity-per-wrap holds.
//   - Every clip lasts a WHOLE NUMBER of HLS segments (tileUp), with keyframes
//     forced on every segment boundary, so the HLS muxer cuts the joined stream
//     into equal segments and never leaves a runt mid-loop.
//
// These builders are pinned by a byte-identity golden snapshot
// (test/encode/media-args.test.js against test/fixtures/media-args.golden.json),
// for the same reason as the account channel's (see the comment atop the
// builders in encode/channel.js). Regenerate only for an intended change:
//   UPDATE_GOLDEN=1 node --test test/encode/media-args.test.js
import { config } from '../config.js';
import { LIVE_WINDOW_SEGMENTS } from './liveloop.js';
import { FFPROBE, capture } from './ffmpeg.js';

// An article holds still this long before it starts scrolling, and at least
// this long once its end is on screen.
export const SCROLL_HOLD_SECONDS = 3;

// Round an on-screen time UP to whole segments (never below one), so clips
// concatenate onto segment boundaries. Up, not nearest: nothing is cut short.
export function tileUp(seconds, segment = config.channel.hlsTime) {
  return Math.max(segment, Math.ceil(seconds / segment - 1e-9) * segment);
}

const n3 = (value) => Number(value).toFixed(3);

// ---------------------------------------------------------------------------
// The article timeline (pure)
// ---------------------------------------------------------------------------

// What happens on screen, in order: hold at the top, scroll until the first
// video is centred, stop while it plays, scroll on to the next, … scroll to the
// end, hold. `phases` are [{ start, end, from, to, video? }] in seconds and
// layer pixels (`from`/`to` = how far the page is scrolled); a video is
// { y, height, focus?, duration }, focus being the height to centre (box +
// caption); `starts[k]` is
// when video k begins. A page that never scrolls lasts at least `minSeconds`;
// the final hold absorbs the rounding up to whole segments.
export function articleTimeline({
  layerHeight, screenHeight, videos = [], speed, minSeconds = 0, hold = SCROLL_HOLD_SECONDS,
}) {
  const maxScroll = Math.max(0, Math.round(layerHeight - screenHeight));
  const phases = [];
  const starts = [];
  let t = 0;
  let pos = 0;
  const add = (duration, to, extra = {}) => {
    if (!(duration > 0)) return;
    phases.push({ start: t, end: t + duration, from: pos, to, ...extra });
    t += duration;
    pos = to;
  };

  add(hold, 0);
  videos
    .map((video, index) => ({ ...video, index }))
    .sort((a, b) => a.y - b.y)
    .forEach((video) => {
      // Centre the video with its caption (`focus`), not the bare box.
      const centred = Math.round(video.y + (video.focus || video.height) / 2 - screenHeight / 2);
      const target = Math.min(maxScroll, Math.max(0, centred));
      if (target > pos) add((target - pos) / speed, target);
      starts[video.index] = t;
      add(video.duration, pos, { video: video.index });
    });
  if (maxScroll > pos) add((maxScroll - pos) / speed, maxScroll);

  const needed = maxScroll > 0 ? t + hold : Math.max(t + hold, minSeconds);
  const total = tileUp(needed);
  add(total - t, pos);
  return { phases, starts, total, maxScroll };
}

// How far the page is scrolled at time t, as one ffmpeg expression: a chain of
// if(lt(t,end), value, …) over the phases, linear within each.
export function scrollExpression(phases) {
  if (!phases.length) return '0';
  let expr = n3(phases.at(-1).to);
  for (let i = phases.length - 1; i >= 0; i -= 1) {
    const p = phases[i];
    const value = p.from === p.to
      ? n3(p.from)
      : `${n3(p.from)}+${n3((p.to - p.from) / (p.end - p.start))}*(t-${n3(p.start)})`;
    expr = `if(lt(t,${n3(p.end)}),${value},${expr})`;
  }
  return expr;
}

// ---------------------------------------------------------------------------
// Encode builders
// ---------------------------------------------------------------------------

function x264Args() {
  const { preset, crf, maxrate } = config.media;
  return [
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-maxrate', maxrate, '-bufsize', maxrate.replace(/(\d+)/, (n) => String(Number(n) * 2)),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  ];
}

const AAC_ARGS = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100'];

// Encode settings shared by EVERY clip — see the invariants at the top.
function clipEncodeArgs(seconds) {
  return [
    ...x264Args(),
    '-r', String(config.media.fps),
    '-force_key_frames', `expr:gte(t,n_forced*${config.channel.hlsTime})`,
    ...AAC_ARGS,
    '-t', n3(seconds),
    '-video_track_timescale', '90000',
    '-movflags', '+faststart',
  ];
}

// One article -> its clip.
//   background  the channel background (one frame)
//   layer       the article page (transparent, as tall as the article)
//   edges       the background's faded top/bottom bands, laid over the page so
//               lines (and videos) glide in and out under the accent bar
//   indicator   the corner chip frame, or null
//   videos      [{ file, x, y, width, height, start, duration, hasAudio }] —
//               x/y are the video's place ON THE PAGE; it is overlaid at
//               y - scroll(t), so it moves with the page: first frame while
//               approaching, playing from `start` while the page waits, last
//               frame as the page scrolls on
//   phases      articleTimeline().phases; seconds = its total
// Music plays throughout, silenced while a video with its own sound plays.
export function articleClipArgs({
  background, layer, edges, indicator = null, videos = [], phases, seconds, music, out,
}) {
  const { fps } = config.media;
  const { width: W, height: H } = config.channel;
  const T = n3(seconds);
  const still = (file) => ['-loop', '1', '-framerate', String(fps), '-t', T, '-i', file];
  const scroll = scrollExpression(phases);

  const inputs = [...still(background), ...still(layer), ...still(edges)];
  let next = 3;
  const indicatorIndex = indicator ? next++ : null;
  if (indicator) inputs.push(...still(indicator));
  const videoIndex = videos.map(() => next++);
  videos.forEach((v) => inputs.push('-i', v.file));
  const musicIndex = next;
  inputs.push('-stream_loop', '-1', '-i', music);

  const graph = [
    `[1:v]crop=${W}:${H}:0:'${scroll}'[page]`,
    `[0:v]scale=${W}:${H},setsar=1[bg]`,
    '[bg][page]overlay=0:0:format=auto[p0]',
  ];
  videos.forEach((v, k) => {
    graph.push(
      `[${videoIndex[k]}:v]scale=${v.width}:${v.height},setsar=1,fps=${fps},`
      + `tpad=start_mode=clone:start_duration=${n3(v.start)}:stop_mode=clone:stop_duration=${T}[v${k}]`,
      `[p${k}][v${k}]overlay=x=${v.x}:y='${v.y}-(${scroll})':eval=frame:format=auto[p${k + 1}]`,
    );
  });
  let top = `p${videos.length}`;
  graph.push(`[${top}][2:v]overlay=0:0:format=auto[edged]`);
  top = 'edged';
  if (indicator) {
    graph.push(`[${top}][${indicatorIndex}:v]overlay=0:0:format=auto[chip]`);
    top = 'chip';
  }
  graph.push(`[${top}]setsar=1,format=yuv420p[v]`);

  const voiced = videos.map((v, k) => ({ ...v, k })).filter((v) => v.hasAudio);
  const silence = voiced.map((v) => `between(t,${n3(v.start)},${n3(v.start + v.duration)})`).join('+');
  const fadeOut = n3(Math.max(0, seconds - 0.8));
  graph.push(
    `[${musicIndex}:a]aresample=44100,aformat=channel_layouts=stereo,`
    + (silence ? `volume='1-min(1,${silence})':eval=frame,` : '')
    + `afade=t=in:d=0.5,afade=t=out:st=${fadeOut}:d=0.8[${voiced.length ? 'music' : 'a'}]`,
  );
  if (voiced.length) {
    voiced.forEach((v) => {
      const delay = Math.round(v.start * 1000);
      graph.push(`[${videoIndex[v.k]}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${delay}:all=1,apad[va${v.k}]`);
    });
    graph.push(`[music]${voiced.map((v) => `[va${v.k}]`).join('')}amix=inputs=${voiced.length + 1}:duration=first:normalize=0[a]`);
  }

  return [
    '-y',
    ...inputs,
    '-filter_complex', graph.join(';'),
    '-map', '[v]', '-map', '[a]',
    ...clipEncodeArgs(seconds),
    out,
  ];
}

// An uploaded video -> the copy that is kept: fitted within the channel
// resolution (never upscaled past it), constant frame rate, AAC sound. Run
// once at upload; the original is deleted afterwards. Articles overlay this
// copy onto their page, so it is the only full-size version on disk.
export function videoNormalizeArgs({ input, hasAudio, out }) {
  const { fps } = config.media;
  const { width: W, height: H } = config.channel;
  return [
    '-y',
    '-i', input,
    '-map', '0:v:0',
    ...(hasAudio ? ['-map', '0:a:0'] : []),
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=${fps},format=yuv420p`,
    ...x264Args(),
    ...(hasAudio ? AAC_ARGS : ['-an']),
    '-movflags', '+faststart',
    out,
  ];
}

// A poster for the editor and the page layout: the video's first frame, which
// is also what the page shows until the video starts playing.
export function videoPosterArgs({ input, out }) {
  return [
    '-y',
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=960:-2',
    '-q:v', '4',
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
    ...AAC_ARGS,
    '-f', 'hls',
    '-hls_time', String(config.channel.hlsTime),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', `${outDir}/seg_%03d.ts`,
    `${outDir}/index.m3u8`,
  ];
}

// What ffprobe knows about a file: { duration, hasVideo, hasAudio, width, height }.
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
