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
//
// `playlistUri`, when given, is applied to every URI in a MASTER playlist that
// names another playlist the player will keep re-fetching — the variant lines
// and EXT-X-MEDIA renditions — so they come back through the gateway instead of
// going straight to the provider. That is what lets a revocation land while the
// customer is watching: with a master playlist the player fetches the master
// ONCE, at tune-in, and from then on only refreshes the variant; if the variant
// pointed at the provider, the gateway would never hear from that player again
// until the next channel switch. I-frame playlists (trick play only) and keys
// stay direct.
export function rewriteHlsManifest(text, baseUrl, { playlistUri = null } = {}) {
  const gateVariants = playlistUri && isMasterPlaylist(text);
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        const gateTag = gateVariants && trimmed.startsWith('#EXT-X-MEDIA:');
        return line.replace(TAG_URI, (_, uri) => {
          const abs = absolutize(uri, baseUrl);
          return `URI="${gateTag ? playlistUri(abs) : abs}"`;
        });
      }
      const abs = absolutize(trimmed, baseUrl);
      return gateVariants ? playlistUri(abs) : abs;
    })
    .join('\n');
}

// A master (multivariant) playlist lists other playlists; a media playlist lists
// segments. The two never mix, so one variant tag is enough to tell them apart.
export function isMasterPlaylist(text) {
  return /^#EXT-X-(STREAM-INF|MEDIA):/m.test(String(text));
}

// ---------------------------------------------------------------------------
// Mid-view cut-over ("splice")
// ---------------------------------------------------------------------------
// When a customer loses a channel WHILE watching it, answering their player's
// next media-playlist refresh with a redirect or an error does not show them
// anything useful: a redirect to a different live stream arrives with unrelated
// sequence numbers, which ExoPlayer reads as a stuck or broken playlist, and an
// error is just "cannot play". So the gateway keeps the stream going instead:
// it serves the provider's last window, then an EXT-X-DISCONTINUITY, then
// segments of this server's own loop (the customer's info card, or the
// device-limit notice), numbered as the continuation of the same stream. To
// the player that is one live channel whose picture changes — it never stops.
//
// The same invariants as encode/liveloop.js apply, because the same players
// read it: media sequence numbers only move forward, a segment keeps the same
// discontinuity number on every refresh, and a discontinuity on the first
// segment of the window is counted by EXT-X-DISCONTINUITY-SEQUENCE, never also
// tagged.

// Header tags — they describe the playlist, not one segment, and are rebuilt.
const HEADER_TAG = /^#(EXTM3U|EXT-X-(VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|PLAYLIST-TYPE|INDEPENDENT-SEGMENTS|START|ENDLIST|SERVER-CONTROL|PART-INF|ALLOW-CACHE))\b/;
// Low-latency partial-segment tags: meaningless once the window stops growing.
const LL_TAG = /^#EXT-X-(PART|PRELOAD-HINT|RENDITION-REPORT|SKIP)\b/;

function tagNumber(text, tag) {
  const m = String(text).match(new RegExp(`^#${tag}:\\s*(\\d+(?:\\.\\d+)?)`, 'm'));
  return m ? Number(m[1]) : null;
}

// A media playlist as the splice needs it: the header numbers plus, per
// segment, its own tag lines (EXTINF, PROGRAM-DATE-TIME, …) and the key in force
// for it (EXT-X-KEY carries over to later segments until replaced).
export function parseMediaPlaylist(text) {
  const segments = [];
  let tags = [];
  let key = null;
  let hasMap = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (HEADER_TAG.test(line) || LL_TAG.test(line)) continue;
      if (line.startsWith('#EXT-X-KEY:')) key = line;
      if (line.startsWith('#EXT-X-MAP:')) hasMap = true;
      tags.push(line);
      continue;
    }
    const inf = tags.find((t) => t.startsWith('#EXTINF:'));
    const pdt = tags.find((t) => t.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
    segments.push({
      tags,
      uri: line,
      duration: inf ? Number.parseFloat(inf.slice(8)) || 0 : 0,
      discontinuity: tags.includes('#EXT-X-DISCONTINUITY'),
      key,
      pdt: pdt ? Date.parse(pdt.slice(25)) : null,
    });
    tags = [];
  }
  // Many providers stamp PROGRAM-DATE-TIME on the first segment only; the rest
  // follow from the durations. (Only used to continue the clock past a cut —
  // the provider's own tags are re-emitted untouched.)
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1];
    if (!Number.isFinite(segments[i].pdt) && Number.isFinite(prev.pdt)) {
      segments[i].pdt = prev.pdt + prev.duration * 1000;
    }
  }
  return {
    version: tagNumber(text, 'EXT-X-VERSION') || 3,
    targetDuration: tagNumber(text, 'EXT-X-TARGETDURATION') || 6,
    mediaSequence: tagNumber(text, 'EXT-X-MEDIA-SEQUENCE') || 0,
    discontinuitySequence: tagNumber(text, 'EXT-X-DISCONTINUITY-SEQUENCE') || 0,
    independent: /^#EXT-X-INDEPENDENT-SEGMENTS/m.test(String(text)),
    hasMap,
    segments,
  };
}

const isPlainKey = (key) => !key || /METHOD=NONE/.test(key);

// How many filler segments to list `elapsedSeconds` after the cut. A few are
// listed at once so the player has buffer the moment it sees the change; after
// that they appear in real time, like any live stream's.
const FILLER_LEAD = 3;
function fillerAvailable(durationAt, elapsedSeconds) {
  let count = FILLER_LEAD;
  let nextStart = durationAt(0);
  for (let k = 1; nextStart <= elapsedSeconds && k < 1_000_000; k += 1) {
    count += 1;
    nextStart += durationAt(k);
  }
  return count;
}

// The provider's last window followed by the filler loop.
//
//   provider        parseMediaPlaylist() of the last manifest served to this
//                   player for this playlist (URIs already absolute)
//   filler          [{ file, duration }] — the loop to cut over to
//   fillerUri       (segment, sequence) -> URL the player fetches it from
//   startIndex      which filler segment comes first
//   elapsedSeconds  time since the cut, so the filler advances in real time
//   window          minimum number of segments to keep listed
//
// A provider using fMP4 (EXT-X-MAP) cannot be followed by our MPEG-TS
// segments — an init section stays in force for every later segment — so that
// case ends the stream instead (EXT-X-ENDLIST): the player stops, and the
// customer's next tune-in is refused at the door and sent to the card.
export function buildSplicedPlaylist({
  provider, filler, fillerUri, startIndex = 0, elapsedSeconds = 0, window = 8,
}) {
  const P = provider.segments;
  if (provider.hasMap || !filler?.length) {
    return endedPlaylist(provider);
  }
  const L = filler.length;
  const fillerAt = (k) => filler[(startIndex + k) % L];
  const available = fillerAvailable((k) => fillerAt(k).duration, Math.max(0, elapsedSeconds));
  const n = P.length;
  const total = n + available;
  const cap = Math.max(window, n);
  const first = Math.max(0, total - cap);

  // Discontinuity number of every provider segment, ExoPlayer-style: the base
  // plus every tag up to and including the segment itself.
  const providerDisc = [];
  let disc = provider.discontinuitySequence;
  for (const segment of P) {
    if (segment.discontinuity) disc += 1;
    providerDisc.push(disc);
  }
  const lastProviderDisc = n ? providerDisc[n - 1] : provider.discontinuitySequence;
  // Filler k: one discontinuity for the cut, one more per loop wrap.
  const fillerDisc = (k) => lastProviderDisc + 1 + Math.floor((startIndex + k) / L);
  const fillerTagged = (k) => k === 0 || (startIndex + k) % L === 0;
  const discAt = (i) => (i < n ? providerDisc[i] : fillerDisc(i - n));

  // Continue the provider's wall clock across the cut when it had one, so a
  // player that anchors its timeline on PROGRAM-DATE-TIME keeps a straight line.
  const lastPdt = n && Number.isFinite(P[n - 1].pdt) ? P[n - 1].pdt + P[n - 1].duration * 1000 : null;

  const fillerMax = Math.max(...filler.map((s) => s.duration));
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${Math.max(3, provider.version)}`,
    ...(provider.independent ? ['#EXT-X-INDEPENDENT-SEGMENTS'] : []),
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(provider.targetDuration, fillerMax))}`,
    `#EXT-X-MEDIA-SEQUENCE:${provider.mediaSequence + first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${discAt(first)}`,
  ];

  let fillerClock = lastPdt;
  for (let k = 0; k < Math.max(0, first - n); k += 1) {
    if (fillerClock !== null) fillerClock += fillerAt(k).duration * 1000;
  }

  for (let i = first; i < total; i += 1) {
    const listedFirst = i === first;
    if (i < n) {
      const segment = P[i];
      // The key in force for this segment, if the tag that set it scrolled off.
      if (listedFirst && !isPlainKey(segment.key) && !segment.tags.some((t) => t.startsWith('#EXT-X-KEY:'))) {
        lines.push(segment.key);
      }
      for (const tag of segment.tags) {
        if (tag === '#EXT-X-DISCONTINUITY' && listedFirst) continue; // counted by the header
        lines.push(tag);
      }
      lines.push(segment.uri);
      continue;
    }
    const k = i - n;
    const segment = fillerAt(k);
    if (fillerTagged(k) && !listedFirst) lines.push('#EXT-X-DISCONTINUITY');
    if (k === 0 && n && !isPlainKey(P[n - 1].key) && !listedFirst) lines.push('#EXT-X-KEY:METHOD=NONE');
    if (fillerClock !== null) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(fillerClock).toISOString()}`);
      fillerClock += segment.duration * 1000;
    }
    lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
    lines.push(fillerUri(segment, provider.mediaSequence + i));
  }
  lines.push('');
  return lines.join('\n');
}

// The provider's last window, closed. Used where a cut-over cannot be built.
export function endedPlaylist(provider) {
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${Math.max(3, provider.version)}`,
    `#EXT-X-TARGETDURATION:${Math.ceil(provider.targetDuration)}`,
    `#EXT-X-MEDIA-SEQUENCE:${provider.mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${provider.discontinuitySequence}`,
  ];
  provider.segments.forEach((segment, i) => {
    for (const tag of segment.tags) {
      if (tag === '#EXT-X-DISCONTINUITY' && i === 0) continue;
      lines.push(tag);
    }
    lines.push(segment.uri);
  });
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
