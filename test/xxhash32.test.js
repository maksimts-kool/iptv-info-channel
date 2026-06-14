import test from 'node:test';
import assert from 'node:assert/strict';
import { xxhash32 } from '../src/xxhash32.js';

// OneOfOne/xxhash ChecksumString32 vectors, including 16-byte boundaries.
const VECTORS = {
  '': 46947589,
  a: 1426945110,
  abc: 852579327,
  'Hello World!': 198612872,
  'account-abc123': 463191053,
  '123456789012345': 3665500136,
  '1234567890123456': 62869842,
  '12345678901234567': 3334241532,
};

test('xxhash32 matches the Go implementation used by OTT-play', () => {
  for (const [input, expected] of Object.entries(VECTORS)) {
    assert.equal(xxhash32(input), expected, input);
  }
});

test('xxhash32 returns an unsigned 32-bit integer', () => {
  for (const input of Object.keys(VECTORS)) {
    const hash = xxhash32(input);
    assert.ok(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff);
  }
});
