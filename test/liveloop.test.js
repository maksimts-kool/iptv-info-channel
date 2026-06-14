import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLivePlaylist, currentLoopPosition, writeLoopState,
} from '../src/liveloop.js';

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
