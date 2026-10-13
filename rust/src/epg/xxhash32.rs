//! xxHash32 compatible with `github.com/OneOfOne/xxhash` `ChecksumString32`,
//! which OTT-play uses to name its per-channel guide files. Pinned by vector
//! tests — don't swap it for a generic hash crate without re-checking them.

const P1: u32 = 0x9e37_79b1;
const P2: u32 = 0x85eb_ca77;
const P3: u32 = 0xc2b2_ae3d;
const P4: u32 = 0x27d4_eb2f;
const P5: u32 = 0x1656_67b1;

fn round(acc: u32, input: u32) -> u32 {
    acc.wrapping_add(input.wrapping_mul(P2)).rotate_left(13).wrapping_mul(P1)
}

fn read32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

pub fn xxhash32_bytes(input: &[u8], seed: u32) -> u32 {
    let len = input.len();
    let mut rest = input;
    let mut hash = if len >= 16 {
        let mut v = [
            seed.wrapping_add(P1).wrapping_add(P2),
            seed.wrapping_add(P2),
            seed,
            seed.wrapping_sub(P1),
        ];
        while rest.len() >= 16 {
            for (i, lane) in v.iter_mut().enumerate() {
                *lane = round(*lane, read32(&rest[i * 4..]));
            }
            rest = &rest[16..];
        }
        v[0].rotate_left(1)
            .wrapping_add(v[1].rotate_left(7))
            .wrapping_add(v[2].rotate_left(12))
            .wrapping_add(v[3].rotate_left(18))
    } else {
        seed.wrapping_add(P5)
    };

    hash = hash.wrapping_add(len as u32);
    while rest.len() >= 4 {
        hash = hash.wrapping_add(read32(rest).wrapping_mul(P3)).rotate_left(17).wrapping_mul(P4);
        rest = &rest[4..];
    }
    for &byte in rest {
        hash = hash.wrapping_add(u32::from(byte).wrapping_mul(P5)).rotate_left(11).wrapping_mul(P1);
    }

    hash ^= hash >> 15;
    hash = hash.wrapping_mul(P2);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(P3);
    hash ^ (hash >> 16)
}

pub fn xxhash32(value: &str) -> u32 {
    xxhash32_bytes(value.as_bytes(), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_go_implementation_used_by_ottplay() {
        let vectors = [
            ("", 46_947_589),
            ("a", 1_426_945_110),
            ("abc", 852_579_327),
            ("Hello World!", 198_612_872),
            ("account-abc123", 463_191_053),
            ("123456789012345", 3_665_500_136),
            ("1234567890123456", 62_869_842),
            ("12345678901234567", 3_334_241_532),
        ];
        for (input, expected) in vectors {
            assert_eq!(xxhash32(input), expected, "{input}");
        }
    }
}
