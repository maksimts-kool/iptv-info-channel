// Provider HLS manifests, as handled by the stream gateway.
//
// NOT to be confused with the two other playlist formats in this project:
// m3u.js parses the provider's *channel list* (extended M3U), and
// encode/liveloop.js *builds* the info channel's own media playlist. This file
// only rewrites a manifest we fetched from a provider before handing it to a
// customer's player.
//
// Why it exists: the gateway used to answer a channel request with a 302 to the
// provider. When this server runs on https and the provider on http, that is a
// cross-protocol redirect, and Android players (ExoPlayer/media3) refuse to
// follow one by default — the channel just buffers forever, while a desktop
// player follows it happily. So for HLS channels the gateway serves the
// manifest itself over its own https connection instead, with every URI inside
// rewritten to an absolute provider URL. No redirect is involved, the segments
// still travel provider -> player (we never carry the video), and access is
// re-checked on every manifest refresh rather than only at channel switch.
//
// Pure: no I/O, no module state (test/playlist/hls.test.js).

// Is this stream URL an HLS manifest we can rewrite? Query strings and
// fragments are common on provider links, so they are cut before the test.
// Anything else (a raw MPEG-TS stream, which has no manifest at all) has
// nothing to rewrite and cannot be served this way.
export function isHlsUrl(url) {
  const path = String(url || '').split(/[?#]/)[0];
  return /\.m3u8$/i.test(path);
}

// Resolve one URI against the manifest's own URL. `new URL` throws on garbage
// and on relative input with no usable base, and a single unparseable line must
// not cost the viewer the whole channel — so a failure keeps the line as it is.
function absolutize(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

// Every tag that carries a URI does it as URI="…" (EXT-X-KEY, EXT-X-MAP,
// EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-SESSION-KEY, the low-latency
// tags…), so one rule covers them all — including tags added after this was
// written.
const TAG_URI = /URI="([^"]*)"/g;

// Rewrite a manifest so a player can fetch everything it references directly
// from the provider, with no further help from this server.
//
// `baseUrl` MUST be the URL the manifest was finally fetched from (after
// redirects), because relative URIs resolve against it — using the pre-redirect
// URL silently points the player at paths that do not exist.
//
// Works for both a media playlist (segment lines) and a master playlist
// (variant lines): in HLS both are bare URI lines, so the same pass handles
// them. Comments, tags and blank lines are otherwise preserved verbatim —
// nothing about the stream's structure is our business.
export function rewriteHlsManifest(text, baseUrl) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(TAG_URI, (_, uri) => `URI="${absolutize(uri, baseUrl)}"`);
      }
      return absolutize(trimmed, baseUrl);
    })
    .join('\n');
}
