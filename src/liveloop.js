// Presents a pre-generated VOD HLS asset as an endless, wall-clock-paced live
// channel. The playlist is a trailing window, so clients cannot race through
// already-generated segments and then stall waiting for time to catch up.
import fs from 'node:fs';
import path from 'node:path';

export const LIVE_WINDOW_SEGMENTS = 4;

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

  const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const targetDuration = Math.max(
    1,
    Math.ceil(Math.max(...segments.map((segment) => segment.duration))),
  );
  const meta = { segments, totalDuration, targetDuration };
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

// Give a newly opened player its own timeline beginning at segment 0. Sequence
// numbers start beyond the shared live window so clients accept the tune-in as
// fresh content even if they recently watched the same channel.
export function createIntroSession(dir, now = Date.now()) {
  const meta = readLoopMeta(dir);
  const state = readState(dir);
  if (!meta || !state) return null;

  const current = position(meta, state, now);
  return {
    epoch: now,
    baseSeq: current.mediaSequence + LIVE_WINDOW_SEGMENTS,
    baseDiscontinuity: current.discontinuitySequence + 1,
    version: state.version,
  };
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

export function buildLivePlaylist(dir, now = Date.now(), introSession = null) {
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

  const playbackState = introSession || state;
  const current = position(meta, playbackState, now);
  const firstSequence = introSession
    ? Math.max(
      playbackState.baseSeq,
      current.mediaSequence - LIVE_WINDOW_SEGMENTS + 1,
    )
    : Math.max(state.baseSeq, current.mediaSequence - LIVE_WINDOW_SEGMENTS + 1);
  const playbackOffset = firstSequence - playbackState.baseSeq;
  const discontinuitySequence =
    playbackState.baseDiscontinuity + Math.floor(playbackOffset / meta.segments.length);
  const segmentCount = current.mediaSequence - firstSequence + 1;
  const advertisedDuration = Array.from({ length: segmentCount }, (_, index) => {
    const offset = playbackOffset + index;
    return meta.segments[offset % meta.segments.length].duration;
  }).reduce((sum, duration) => sum + duration, 0);

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${meta.targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence}`,
    introSession
      ? '#EXT-X-START:TIME-OFFSET=0.000,PRECISE=YES'
      : `#EXT-X-START:TIME-OFFSET=-${advertisedDuration.toFixed(3)},PRECISE=NO`,
  ];

  for (let index = 0; index < segmentCount; index += 1) {
    const sequence = firstSequence + index;
    const offset = sequence - playbackState.baseSeq;
    const localIndex = offset % meta.segments.length;
    const segment = meta.segments[localIndex];

    if (offset > 0 && localIndex === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
    lines.push(`${segment.file}?v=${encodeURIComponent(playbackState.version)}`);
  }
  lines.push('');
  return lines.join('\n');
}
