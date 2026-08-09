// Pure M3U/M3U8 *playlist* parsing and serialization (no I/O, no state).
//
// This is the extended-M3U format IPTV providers publish, NOT the HLS media
// playlists in encode/liveloop.js — don't confuse the two. A provider playlist
// looks like:
//
//   #EXTM3U url-tvg="https://host/epg.xml"
//   #EXTINF:-1 tvg-id="tv1" tvg-logo="a.png" group-title="Спорт",Sport 1
//   #EXTVLCOPT:http-user-agent=Mozilla
//   http://host/live/user/pass/1.ts
//
// Provider quirks this handles, because real playlists are messy:
//   - attribute values may contain commas, so the channel title is split off at
//     the last comma OUTSIDE quotes (a naive lastIndexOf(',') mangles names);
//   - the group can arrive either as a `group-title` attribute or a separate
//     `#EXTGRP:` line, and the two disagree often enough to need a precedence
//     rule (attribute wins, EXTGRP fills in);
//   - per-channel directives (#EXTVLCOPT / #KODIPROP / #EXTHTTP) sit between the
//     #EXTINF and the URL and are load-bearing for playback, so they are kept
//     verbatim and re-emitted in order;
//   - BOM, CRLF and blank/comment lines appear everywhere.

const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"|([A-Za-z0-9_-]+)=([^\s,"]+)/g;

// Directives that belong to the channel that follows and must survive a
// round-trip (user agents, referers, DRM properties, …).
const PASSTHROUGH_PREFIXES = ['#EXTVLCOPT:', '#KODIPROP:', '#EXTHTTP:', '#EXTM3A:'];

// Parse `key="value"` / `key=value` pairs out of an attribute region.
export function parseAttrs(text) {
  const attrs = {};
  if (!text) return attrs;
  ATTR_RE.lastIndex = 0;
  let m = ATTR_RE.exec(text);
  while (m) {
    const key = (m[1] ?? m[3]).toLowerCase();
    attrs[key] = m[2] ?? m[4] ?? '';
    m = ATTR_RE.exec(text);
  }
  return attrs;
}

// Index of the last comma that is not inside a double-quoted attribute value.
// Everything after it is the display title; everything before, the attributes.
function lastTopLevelComma(text) {
  let inQuotes = false;
  let index = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) index = i;
  }
  return index;
}

// Split an "#EXTINF:" payload into { duration, attrs, title }.
export function parseExtinf(payload) {
  // payload looks like: -1 tvg-id="x" group-title="y",Channel name
  const comma = lastTopLevelComma(payload);
  const head = comma === -1 ? payload : payload.slice(0, comma);
  const title = comma === -1 ? '' : payload.slice(comma + 1).trim();
  const durMatch = /^\s*(-?\d+(?:\.\d+)?)/.exec(head);
  return {
    duration: durMatch ? durMatch[1] : '-1',
    attrs: parseAttrs(durMatch ? head.slice(durMatch[0].length) : head),
    title,
  };
}

// Parse a whole playlist. Returns { headerAttrs, items, malformed } where each
// item is { name, url, duration, attrs, group, extras }. `malformed` counts
// #EXTINF entries that never got a URL line (truncated downloads, junk files) —
// the caller can surface it instead of silently importing a broken playlist.
export function parseM3u(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const headerAttrs = {};
  const items = [];
  let pending = null;
  let malformed = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      Object.assign(headerAttrs, parseAttrs(line.slice('#EXTM3U'.length)));
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      // A second #EXTINF before a URL means the previous entry had none.
      if (pending) malformed += 1;
      const info = parseExtinf(line.slice('#EXTINF:'.length));
      pending = {
        name: info.title,
        duration: info.duration,
        attrs: info.attrs,
        group: info.attrs['group-title'] || '',
        extras: [],
        url: '',
      };
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      // Only fills in when the attribute form is absent (attribute wins).
      const group = line.slice('#EXTGRP:'.length).trim();
      if (pending && !pending.group) pending.group = group;
      continue;
    }
    if (PASSTHROUGH_PREFIXES.some((p) => line.startsWith(p))) {
      if (pending) pending.extras.push(line);
      continue;
    }
    if (line.startsWith('#')) continue; // any other directive/comment

    // A bare URL line closes the pending entry. Playlists occasionally carry a
    // URL with no #EXTINF at all; keep it with the URL as its name.
    if (pending) {
      pending.url = line;
      items.push(pending);
      pending = null;
    } else {
      items.push({
        name: line, duration: '-1', attrs: {}, group: '', extras: [], url: line,
      });
    }
  }
  if (pending) malformed += 1;

  return { headerAttrs, items, malformed };
}

function attrString(attrs) {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    // Values are quoted, so an embedded quote would break the entry — the
    // straight quote becomes a typographic one rather than being dropped.
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '”').replace(/\r?\n/g, ' ')}"`)
    .join(' ');
}

// Serialize back to extended-M3U text. `items` are
// { name, url, duration?, attrs?, extras? }; `headerAttrs` go on the #EXTM3U line.
export function buildM3u(items, headerAttrs = {}) {
  const header = attrString(headerAttrs);
  const out = [header ? `#EXTM3U ${header}` : '#EXTM3U'];
  for (const item of items) {
    const attrs = attrString(item.attrs || {});
    const name = String(item.name ?? '').replace(/\r?\n/g, ' ');
    out.push(`#EXTINF:${item.duration ?? '-1'}${attrs ? ` ${attrs}` : ''},${name}`);
    for (const extra of item.extras || []) out.push(extra);
    out.push(item.url);
  }
  out.push('');
  return out.join('\n');
}
