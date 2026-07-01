// xxHash32 compatible with github.com/OneOfOne/xxhash ChecksumString32.

const PRIME32_1 = 0x9e3779b1 | 0;
const PRIME32_2 = 0x85ebca77 | 0;
const PRIME32_3 = 0xc2b2ae3d | 0;
const PRIME32_4 = 0x27d4eb2f | 0;
const PRIME32_5 = 0x165667b1 | 0;

function rotl(value, bits) {
  return (value << bits) | (value >>> (32 - bits));
}

function round(accumulator, input) {
  let acc = (accumulator + Math.imul(input, PRIME32_2)) | 0;
  acc = rotl(acc, 13);
  return Math.imul(acc, PRIME32_1);
}

function read32(buffer, offset) {
  return (
    buffer[offset]
    | (buffer[offset + 1] << 8)
    | (buffer[offset + 2] << 16)
    | (buffer[offset + 3] << 24)
  ) | 0;
}

export function xxhash32Bytes(buffer, seed = 0) {
  const length = buffer.length;
  let hash;
  let offset = 0;

  if (length >= 16) {
    let v1 = (seed + PRIME32_1 + PRIME32_2) | 0;
    let v2 = (seed + PRIME32_2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - PRIME32_1) | 0;
    const limit = length - 16;

    while (offset <= limit) {
      v1 = round(v1, read32(buffer, offset)); offset += 4;
      v2 = round(v2, read32(buffer, offset)); offset += 4;
      v3 = round(v3, read32(buffer, offset)); offset += 4;
      v4 = round(v4, read32(buffer, offset)); offset += 4;
    }
    hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    hash = (seed + PRIME32_5) | 0;
  }

  hash = (hash + length) | 0;

  while (offset + 4 <= length) {
    hash = (hash + Math.imul(read32(buffer, offset), PRIME32_3)) | 0;
    hash = Math.imul(rotl(hash, 17), PRIME32_4);
    offset += 4;
  }
  while (offset < length) {
    hash = (hash + Math.imul(buffer[offset], PRIME32_5)) | 0;
    hash = Math.imul(rotl(hash, 11), PRIME32_1);
    offset += 1;
  }

  hash ^= hash >>> 15;
  hash = Math.imul(hash, PRIME32_2);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, PRIME32_3);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function xxhash32(value, seed = 0) {
  return xxhash32Bytes(Buffer.from(String(value), 'utf8'), seed);
}
