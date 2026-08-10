import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLivePlaylist, currentLoopPosition, writeLoopState,
} from '../../src/encode/liveloop.js';

function fixture(segmentCount = 5) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-live-loop-'));
  const lines = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    ...Array.from({ length: segmentCount }, (_, index) => [
      '#EXTINF:6.000000,',
      `seg_${String(index).padStart(3, '0')}.ts`,
    ]).flat(),
    '#EXT-X-ENDLIST',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'index.m3u8'), lines.join('\n'));
  return dir;
}

test('serves a trailing live window without an end marker', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLoopState(dir, { version: 'one' }, 100_000);

  const playlist = buildLivePlaylist(dir, 106_000);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:0/);
  assert.match(playlist, /seg_001\.ts\?v=one&s=1/);
  assert.match(playlist, /seg_004\.ts\?v=one&s=4/);
  assert.doesNotMatch(playlist, /#EXT-X-ENDLIST/);
});

test('advances through a loop with a discontinuity and monotonic sequence', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLoopState(dir, { version: 'one' }, 100_000);

  const playlist = buildLivePlaylist(dir, 118_000);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:0/);
  assert.match(
    playlist,
    /seg_004\.ts\?v=one&s=4\n#EXT-X-DISCONTINUITY\n#EXTINF:6\.000000,\nseg_000\.ts\?v=one&s=5/,
  );
  assert.deepEqual(currentLoopPosition(dir, 118_000), {
    mediaSequence: 7,
    discontinuitySequence: 1,
  });
});

// The absolute discontinuity number a playlist claims for one media segment:
// the playlist-wide EXT-X-DISCONTINUITY-SEQUENCE plus every tag ahead of it.
function discontinuityIndexes(playlist) {
  const indexes = new Map();
  let counter = null;
  for (const line of playlist.split('\n')) {
    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      counter = Number(line.split(':')[1]);
    } else if (line === '#EXT-X-DISCONTINUITY') {
      counter += 1;
    } else if (line.includes('.ts?')) {
      indexes.set(Number(/&s=(\d+)/.exec(line)[1]), counter);
    }
  }
  return indexes;
}

test('a segment keeps one discontinuity number as the window slides over the wrap', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLoopState(dir, { version: 'one' }, 100_000);

  // A five-segment loop is shorter than the eight-segment window, so a wrap sits
  // inside every playlist and eventually becomes its first segment. If the same
  // sequence number is ever renumbered, a strict player stalls on the wrap.
  const seen = new Map();
  for (let now = 100_000; now <= 340_000; now += 6_000) {
    for (const [sequence, index] of discontinuityIndexes(buildLivePlaylist(dir, now))) {
      const previous = seen.get(sequence);
      if (previous !== undefined) {
        assert.equal(index, previous, `segment ${sequence} was renumbered at ${now}`);
      }
      seen.set(sequence, index);
    }
  }
  // The wrap is still announced — one boundary per loop, never zero.
  assert.equal(seen.get(4), 0);
  assert.equal(seen.get(5), 1);
  assert.equal(seen.get(10), 2);
});

test('a rebuilt generation can continue counters with a new segment version', (t) => {
  const oldDir = fixture();
  const newDir = fixture();
  t.after(() => fs.rmSync(oldDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(newDir, { recursive: true, force: true }));

  writeLoopState(oldDir, { version: 'old' }, 100_000);
  const oldPosition = currentLoopPosition(oldDir, 112_000);
  writeLoopState(newDir, {
    baseSeq: oldPosition.mediaSequence + 4,
    baseDiscontinuity: oldPosition.discontinuitySequence + 1,
    version: 'new',
  }, 112_000);

  const playlist = buildLivePlaylist(newDir, 112_000);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:10/);
  assert.match(playlist, /#EXT-X-DISCONTINUITY-SEQUENCE:2/);
  assert.match(playlist, /seg_000\.ts\?v=new&s=10/);
  assert.doesNotMatch(playlist, /\?v=old/);
});

test('every viewer shares one live timeline regardless of tune-in time', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLoopState(dir, { version: 'live' }, 100_000);

  // Two independent tune-ins at the same instant see the identical window:
  // there is no per-open session re-anchoring the stream to the intro.
  const a = buildLivePlaylist(dir, 118_000);
  const b = buildLivePlaylist(dir, 118_000);
  assert.equal(a, b);
  assert.doesNotMatch(a, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  assert.match(a, /#EXT-X-START:TIME-OFFSET=-/);
});
