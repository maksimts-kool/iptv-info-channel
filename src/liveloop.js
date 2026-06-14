// Presents a pre-generated VOD HLS asset as an endless live channel.
import fs from 'node:fs';
import path from 'node:path';

// A wider window gives strict live players (ExoPlayer/IJK in Televizo) buffer
// headroom behind the synthetic live edge. Too thin (e.g. 4) and they rebuffer
// at the edge forever even though lenient players (OTT Play) cope.
export const LIVE_WINDOW_SEGMENTS = 8;

const STATE_FILE = 'loop.json';
const metaCache = new Map();

function readLoopMeta(dir) {
  const playlistPath = path.join(dir, 'index.m3u8');
  if (!fs.existsSync(playlistPath)) return null;

  const stat = fs.statSync(playlistPath);
  const cached = metaCache.get(playlistPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.meta;
  }

  const segments = [];
  let pendingDuration = null;
  for (const raw of fs.readFileSync(playlistPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length));
    } else if (!line.startsWith('#')) {
      segments.push({
        file: line,
        duration: Number.isFinite(pendingDuration) ? pendingDuration : 6,
      });
      pendingDuration = null;
    }
  }
  if (segments.length === 0) return null;

  // Drop sub-second runt segments (the trailing sliver left when the loop length
  // isn't an exact multiple of the segment time, e.g. a 0.04s seg_020). Listing
  // one stalls strict decoders and forces a needless discontinuity on every
  // loop. The file stays on disk; we just never reference it.
  const longest = Math.max(...segments.map((segment) => segment.duration));
  const runtThreshold = Math.min(1, longest * 0.5);
  const usable = segments.filter((segment) => segment.duration >= runtThreshold);
  const finalSegments = usable.length > 0 ? usable : segments;

  const totalDuration = finalSegments.reduce((sum, segment) => sum + segment.duration, 0);
  const targetDuration = Math.max(
    1,
    Math.ceil(Math.max(...finalSegments.map((segment) => segment.duration))),
  );
  const meta = { segments: finalSegments, totalDuration, targetDuration };
  metaCache.set(playlistPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

function readState(dir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    if (
      Number.isFinite(state.epoch)
      && Number.isFinite(state.baseSeq)
      && Number.isFinite(state.baseDiscontinuity)
      && typeof state.version === 'string'
    ) {
      return state;
    }
  } catch {
    // Missing state is initialized on first live playlist request.
  }
  return null;
}

function prerollMs(meta) {
  const count = Math.min(LIVE_WINDOW_SEGMENTS - 1, meta.segments.length - 1);
  return meta.segments
    .slice(0, count)
    .reduce((sum, segment) => sum + segment.duration * 1000, 0);
}

function segmentOffset(meta, elapsedSeconds) {
  const cycle = Math.floor(elapsedSeconds / meta.totalDuration);
  const position = elapsedSeconds - cycle * meta.totalDuration;
  let index = 0;
  let boundary = meta.segments[0].duration;

  while (index + 1 < meta.segments.length && position >= boundary) {
    index += 1;
    boundary += meta.segments[index].duration;
  }
  return cycle * meta.segments.length + index;
}

function position(meta, state, now) {
  const elapsedSeconds = Math.max(0, (now - state.epoch) / 1000);
  const offset = segmentOffset(meta, elapsedSeconds);
  return {
    mediaSequence: state.baseSeq + offset,
    discontinuitySequence:
      state.baseDiscontinuity + Math.floor(offset / meta.segments.length),
  };
}

// Returns the current live counters. Regeneration uses these to ensure that
// sequence numbers never move backwards when the rendered content changes.
export function currentLoopPosition(dir, now = Date.now()) {
  const meta = readLoopMeta(dir);
  const state = readState(dir);
  if (!meta || !state) return null;
  return position(meta, state, now);
}

// Initialize a newly rendered generation. A short preroll means the first
// playlist already has a healthy live window instead of only one segment.
export function writeLoopState(
  dir,
  {
    baseSeq = 0,
    baseDiscontinuity = 0,
    version = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  } = {},
  now = Date.now(),
) {
  const meta = readLoopMeta(dir);
  if (!meta) throw new Error('cannot initialize live loop without an HLS playlist');

  const state = {
    epoch: now - prerollMs(meta),
    baseSeq: Math.max(0, Math.floor(baseSeq)),
    baseDiscontinuity: Math.max(0, Math.floor(baseDiscontinuity)),
    version,
  };
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state));
  return state;
}

// A single shared live timeline: a sliding window over the looped segments,
// the same for every viewer regardless of when they tune in. No per-open
// session, so the channel is just "already live" — it never restarts at the
// intro on channel open.
export function buildLivePlaylist(dir, now = Date.now()) {
  const meta = readLoopMeta(dir);
  if (!meta) return null;

  let state = readState(dir);
  if (!state) {
    try {
      state = writeLoopState(dir, {}, now);
    } catch {
      state = {
        epoch: now - prerollMs(meta),
        baseSeq: 0,
        baseDiscontinuity: 0,
        version: 'legacy',
      };
    }
  }

  const current = position(meta, state, now);
  const firstSequence = Math.max(
    state.baseSeq,
    current.mediaSequence - LIVE_WINDOW_SEGMENTS + 1,
  );
  const playbackOffset = firstSequence - state.baseSeq;
  const discontinuitySequence =
    state.baseDiscontinuity + Math.floor(playbackOffset / meta.segments.length);
  const segmentCount = current.mediaSequence - firstSequence + 1;
  const advertisedDuration = Array.from({ length: segmentCount }, (_, index) => {
    const offset = playbackOffset + index;
    return meta.segments[offset % meta.segments.length].duration;
  }).reduce((sum, duration) => sum + duration, 0);

  const lines = [
    '#EXTM3U',
    // Version 6: matches the tags we emit (EXT-X-DISCONTINUITY-SEQUENCE,
    // EXT-X-START) and the on-disk VOD playlist. Strict players reject the
    // version/tag mismatch a lower number implies.
    '#EXT-X-VERSION:6',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-TARGETDURATION:${meta.targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence}`,
    // Start at the live edge (a window's worth back), so players join the
    // running stream rather than seeking to the beginning.
    `#EXT-X-START:TIME-OFFSET=-${advertisedDuration.toFixed(3)},PRECISE=NO`,
  ];

  for (let index = 0; index < segmentCount; index += 1) {
    const sequence = firstSequence + index;
    const offset = sequence - state.baseSeq;
    const localIndex = offset % meta.segments.length;
    const segment = meta.segments[localIndex];

    if (offset > 0 && localIndex === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
    lines.push(`${segment.file}?v=${encodeURIComponent(state.version)}&s=${sequence}`);
  }
  lines.push('');
  return lines.join('\n');
}
