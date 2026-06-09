import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLivePlaylist, createIntroSession, currentLoopPosition, writeLoopState,
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
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:1/);
  assert.match(playlist, /seg_001\.ts\?v=one/);
  assert.match(playlist, /seg_004\.ts\?v=one/);
  assert.doesNotMatch(playlist, /#EXT-X-ENDLIST/);
});

test('advances through a loop with a discontinuity and monotonic sequence', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLoopState(dir, { version: 'one' }, 100_000);

  const playlist = buildLivePlaylist(dir, 118_000);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:3/);
  assert.match(
    playlist,
    /seg_004\.ts\?v=one\n#EXT-X-DISCONTINUITY\n#EXTINF:6\.000000,\nseg_000\.ts\?v=one/,
  );
  assert.deepEqual(currentLoopPosition(dir, 118_000), {
    mediaSequence: 6,
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
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:9/);
  assert.match(playlist, /#EXT-X-DISCONTINUITY-SEQUENCE:2/);
  assert.match(playlist, /seg_000\.ts\?v=new/);
  assert.doesNotMatch(playlist, /\?v=old/);
});

test('a new channel entry starts at the intro and then advances', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeLoopState(dir, { version: 'intro' }, 100_000);

  const session = createIntroSession(dir, 112_000);
  const first = buildLivePlaylist(dir, 112_000, session);
  assert.match(first, /#EXT-X-START:TIME-OFFSET=0\.000,PRECISE=YES/);
  assert.match(first, /seg_000\.ts\?v=intro/);
  assert.doesNotMatch(first, /seg_001\.ts\?v=intro/);

  const later = buildLivePlaylist(dir, 118_000, session);
  assert.match(later, /seg_000\.ts\?v=intro/);
  assert.match(later, /seg_001\.ts\?v=intro/);
  assert.doesNotMatch(later, /seg_002\.ts\?v=intro/);
});
