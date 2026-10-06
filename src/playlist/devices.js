// Simultaneous-device limit for the stream gateway.
//
// A plan (or a customer's personal override) caps how many devices may watch at
// once. The gateway is the only place this server sees playback at all — and
// only for gated HLS channels, whose media playlist the player re-fetches every
// few seconds through /c/ — so "a device is watching" means "it fetched a gated
// manifest within the last `idleMs`". There is no session to log out of: a
// device that stops polling simply ages out and frees its slot.
//
// WHAT A DEVICE IS. Players do not identify themselves, so a device is the pair
// (client IP, device tag). The tag is baked into the gate URLs when the playlist
// is downloaded (see deviceTag below) rather than taken from each manifest
// request's User-Agent, because one app often fetches through two HTTP stacks —
// an okhttp probe first, then ExoPlayer — and keying on the per-request UA would
// count one TV as two devices and refuse it its own channel. Old playlists
// without a tag fall back to the request's User-Agent. The consequences, which
// the admin UI states:
//   - two identical apps behind one home router count as one device;
//   - a phone whose IP changes mid-view holds two slots until the old one ages out.
//
// WHO WINS when there are more devices than slots: the ones that started first.
// A device already watching is never pushed out by a newcomer; the newcomer is
// refused. Lowering the limit refuses the most recent arrivals until they idle
// out. Refused requests do not refresh a device, so a refused device never
// holds a slot.
//
// Pure apart from its own in-memory map (no I/O, clock injected) — unit-tested
// in test/playlist/devices.test.js.
import crypto from 'node:crypto';

// Short stable tag for "the client that downloaded this playlist", embedded in
// every gate URL of that playlist. Derived from the downloader's User-Agent, so
// re-downloading on the same device yields the same tag and never looks like a
// second device. Not a secret and not an identity — the IP does the separating.
export function deviceTag(userAgent) {
  return crypto.createHash('sha1').update(String(userAgent || '')).digest('base64url').slice(0, 10);
}

// The key the tracker counts. The tag wins over the live User-Agent (see above).
export function deviceKey({ ip = '', tag = '', userAgent = '' } = {}) {
  const who = tag ? `t:${tag}` : `ua:${userAgent}`;
  return crypto.createHash('sha1').update(`${ip}|${who}`).digest('hex').slice(0, 20);
}

export class DeviceTracker {
  constructor({ idleMs = 60_000 } = {}) {
    this.idleMs = idleMs;
    this.users = new Map(); // userId -> Map(key -> device)
  }

  prune(userId, now) {
    const devices = this.users.get(userId);
    if (!devices) return null;
    for (const [key, device] of devices) {
      if (now - device.lastSeen > this.idleMs) devices.delete(key);
    }
    if (!devices.size) {
      this.users.delete(userId);
      return null;
    }
    return devices;
  }

  // Ask for a slot. `limit` 0 = unlimited. `info` ({ ip, ua, channel }) is kept
  // for the admin's "who is watching" list. Returns { allowed, active, limit }.
  admit(userId, key, limit, info = {}, now = Date.now()) {
    let devices = this.prune(userId, now);
    const existing = devices?.get(key);

    if (existing) {
      // Oldest first: a device keeps its slot only while it is among the first
      // `limit` arrivals still watching (matters after the limit is lowered).
      const rank = [...devices.values()].filter((d) => d.firstSeen < existing.firstSeen).length;
      if (limit > 0 && rank >= limit) return { allowed: false, active: devices.size, limit };
      Object.assign(existing, info, { lastSeen: now });
      return { allowed: true, active: devices.size, limit };
    }

    if (limit > 0 && (devices?.size || 0) >= limit) {
      return { allowed: false, active: devices.size, limit };
    }
    if (!devices) {
      devices = new Map();
      this.users.set(userId, devices);
    }
    devices.set(key, { ...info, firstSeen: now, lastSeen: now });
    return { allowed: true, active: devices.size, limit };
  }

  // Devices watching right now, oldest first, each flagged with whether it is
  // inside the limit.
  list(userId, limit = 0, now = Date.now()) {
    const devices = this.prune(userId, now);
    if (!devices) return [];
    return [...devices.values()]
      .sort((a, b) => a.firstSeen - b.firstSeen)
      .map((d, index) => ({ ...d, allowed: !(limit > 0 && index >= limit) }));
  }

  count(userId, now = Date.now()) {
    return this.prune(userId, now)?.size || 0;
  }

  // Drop every device of one customer (deleted account, rotated token).
  forget(userId) {
    this.users.delete(userId);
  }
}
