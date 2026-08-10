// Public HTTP surface for a customer's subscription:
//   - the .m3u playlist text (buildUserPlaylist) — the full curated channel
//     list from the catalog, led by this server's own info channel
//   - the HLS stream (.m3u8 / .ts) of that info channel, with Range support
//   - the OTT-play FOSS endpoints (channels.json / epg/<hash>.json / logo.svg +
//     the /m3u/match-* protocol)
// Merged from the former routes/stream.js, playlist.js and routes/foss-epg.js so
// the whole public playlist/stream concern lives in one file. The pure playlist
// builders stay exported (unit-tested in test/http/playlist.test.js).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { Users, Settings, Incidents } from '../data/store.js';
import { userHlsDir, ensureUserStream } from '../encode/channel.js';
import { buildLivePlaylist } from '../encode/liveloop.js';
import { buildEpgXml, epgChannelId } from '../epg/epg.js';
import { buildM3u } from '../playlist/m3u.js';
import { isHlsUrl, rewriteHlsManifest } from '../playlist/hls.js';
import {
  channelsForUser, channelAccessForUser, planCategorySet, Sources, INFO_CHANNEL_ID,
} from '../playlist/catalog.js';
import { accountStatus } from '../core/util.js';
import {
  fossIdHash,
  buildFossChannelsJson,
  buildFossEpgJson,
  parseMatchRequest,
  buildMatchChannelsResponse,
  mergeMatchChannelsResponses,
  EMPTY_LOGO_MATCH_RESPONSE,
  buildFossLogoSvg,
  normalizeFossProviderId,
} from '../epg/epgfoss.js';
import { log } from '../core/logger.js';

// ---------------------------------------------------------------------------
// Per-user .m3u playlist text (pure; unit-tested)
// ---------------------------------------------------------------------------

export function fossProviderBaseUrl(user, cfg) {
  return `${cfg.publicBaseUrl}/foss-epg/u/${encodeURIComponent(user.token)}/`;
}

// The two per-user URLs the guide needs. They live here, shared, because the
// .m3u we generate and the FOSS `channels.json` we serve must agree on them
// CHARACTER FOR CHARACTER: OTT-play binds the provider to the playlist by
// hashing the playlist's `url-tvg`, so a URL built twice, slightly differently,
// silently costs the customer their EPG.
export function userEpgUrl(user, cfg) {
  return `${cfg.publicBaseUrl}/u/${encodeURIComponent(user.token)}/epg.xml`;
}

export function fossLogoUrl(user, cfg) {
  return `${fossProviderBaseUrl(user, cfg)}logo.svg`;
}

// The URL the `=`-prefixed `foss-tvg` entry must carry. In that static mode
// OTT-play appends "<xxhash32(tvg-id)>.json" to this string VERBATIM, so it has
// to name the directory the programme files actually live in — the documented
// example is `=iptvx::http://epg.ottp.eu.org/iptvx.one/epg/`, and
// http://epg.ottp.eu.org/iptvx.one/epg/890122.json is a real file. Publishing
// the provider root instead (what this server did) sends the player to
// /foss-epg/u/<token>/<hash>.json, which is a 404 and therefore no guide.
//
// The match protocol's provider block is the level ABOVE this one: the
// reference server answers `<base_url><provider id>/` and the player appends
// the `epg/` itself there, so that path keeps using fossProviderBaseUrl.
export function fossEpgDirUrl(user, cfg) {
  return `${fossProviderBaseUrl(user, cfg)}epg/`;
}

// ---------------------------------------------------------------------------
// Stream gateway
// ---------------------------------------------------------------------------
// This server's own HLS loop for one customer — the account/info channel. Also
// the gateway's fallback: a customer who opens a channel they may not watch is
// sent here, so they land on their own card (plan, expiry, what is on offer)
// instead of a playback error that reads like a broken server.
export function userStreamUrl(user, cfg) {
  return `${cfg.publicBaseUrl}/hls/${encodeURIComponent(user.token)}/index.m3u8`;
}

// Where the .m3u points for one imported channel.
//
// OFF (the default): the provider's own URL. The player then talks straight to
// the provider, this server never learns that a channel was opened, and a
// customer who lost access keeps watching until their player re-downloads the
// playlist — which many players only do when the user asks them to.
//
// ON: /c/:token/:id below, which re-resolves entitlement before anything plays.
// No video is proxied — the bytes still go provider -> player — so the gain
// (taking a category away stops playback at once) costs no bandwidth.
//
// ONLY HLS CHANNELS ARE GATED, and that restriction is load-bearing. The gate's
// first implementation answered with a 302 to the provider, which breaks on
// Android whenever this server is https and the provider http: ExoPlayer/media3
// refuse cross-protocol redirects by default, so the channel buffers forever
// while a desktop player follows the same redirect happily. An HLS channel does
// not need a redirect — the gate serves the provider's manifest itself, with
// the URIs inside rewritten to absolute provider URLs (playlist/hls.js). A raw
// MPEG-TS stream has no manifest, so gating it would mean either that broken
// redirect or relaying the video through this server; it is published as a
// direct provider URL instead and simply keeps the un-gated behaviour, where
// access changes reach it only on the next playlist download.
//
// The account channel keeps its own /hls/ URL: it is already served from here
// and must survive an expired subscription, so routing it through the gate
// would only add a hop.
export function channelStreamUrl(user, channel, cfg) {
  if (!cfg.gateway?.enabled || channel.builtin || !channel.url) return channel.url;
  if (!isHlsUrl(channel.url)) return channel.url;
  return `${cfg.publicBaseUrl}/c/${encodeURIComponent(user.token)}/${encodeURIComponent(channel.id)}`;
}

// The admin's on/off switch (Settings `gateway_enabled`) overlaid on the env
// default, exactly like syncNotifySettings does for notifications. Called at
// startup and after the admin toggles it.
export function syncGatewaySettings() {
  const s = Settings.all();
  if (typeof s.gateway_enabled === 'boolean') config.gateway.enabled = s.gateway_enabled;
}

// The customer's whole subscription as one .m3u.
//
// `entries` is the already-resolved [{ channel, category }] list from the
// catalog (resolveUserChannels applied the global settings, this customer's
// personal overrides and the expiry gate) — this function only turns it into
// playlist text, so it stays pure and testable. `epgUrls` are extra upstream
// guides advertised alongside ours.
//
// The built-in info channel is the one entry whose URL is per-customer: it
// points at this server's HLS loop and carries the tvg-id our own EPG uses.
export function buildUserPlaylist(user, settings, cfg, entries = [], epgUrls = []) {
  const brand = settings.brand_name || 'Мой IPTV-сервис';
  const infoName = `${brand} — ${user.username}`;
  // NOTE: PUBLIC_BASE_URL is baked into these URLs. On a LAN it must be the host
  // IP the IPTV box can reach — never localhost — or the generated links 404.
  const streamUrl = userStreamUrl(user, cfg);
  const tvgId = epgChannelId(user);
  const fossEnabled = cfg.epg.enabled && cfg.epg.foss.enabled;
  const providerId = normalizeFossProviderId(cfg.epg.foss.providerId);
  const epgDirUrl = fossEpgDirUrl(user, cfg);
  const logoUrl = fossLogoUrl(user, cfg);

  const headerAttrs = {};
  if (cfg.epg.enabled) {
    // Ours first; a provider's own guide is appended comma-separated, which is
    // how players accept several XMLTV sources on one url-tvg.
    headerAttrs['url-tvg'] = [userEpgUrl(user, cfg), ...epgUrls].join(',');
  }
  if (fossEnabled) {
    // The leading "=" on the source definition is required by OTT-play's
    // parser: it takes the channel out of the central auto-match and loads
    // <xxhash32(tvg-id)>.json straight from the URL that follows.
    headerAttrs['foss-tvg'] = `=${providerId}::${epgDirUrl}`;
  }

  const items = entries.map(({ channel, category }) => {
    if (channel.id === INFO_CHANNEL_ID) {
      const name = channel.name || infoName;
      return {
        name,
        url: streamUrl,
        // Attribute order is deliberate and matched by test/http/playlist.test.js.
        // A real logo URL prevents a separate central match-logos request.
        attrs: {
          'tvg-id': tvgId,
          ...(fossEnabled ? { 'tvg-source': `=${providerId}` } : {}),
          'tvg-name': name,
          ...(fossEnabled ? { 'tvg-logo': logoUrl } : {}),
          'group-title': category.name,
        },
      };
    }
    return {
      name: channel.name,
      url: channelStreamUrl(user, channel, cfg),
      extras: channel.extras,
      attrs: { ...channel.attrs, 'group-title': category.name },
    };
  });

  return buildM3u(items, headerAttrs);
}

// Resolve everything the playlist builder needs for one customer: which
// channels they may see (expired/disabled accounts collapse to Информация) and
// which upstream guides to advertise. Also used by the admin's playlist preview.
export function renderUserPlaylist(user, settings = Settings.all()) {
  const status = accountStatus(user, config.expiringThresholdDays);
  const locked = status === 'expired' || status === 'disabled';
  // The plan is the base entitlement: a customer sees the categories their plan
  // grants (an empty plan grants none), then their personal exceptions.
  const entries = channelsForUser(user.id, { locked, planCategories: planCategorySet(user) });
  const usedSources = new Set(entries.map((e) => e.channel.source_id).filter(Boolean));
  const epgUrls = Sources.all()
    .filter((s) => s.epg_url && usedSources.has(s.id))
    .map((s) => s.epg_url);
  return buildUserPlaylist(user, settings, config, entries, epgUrls);
}

// ---------------------------------------------------------------------------
// Stream router: playlist + EPG + HLS (.m3u8 / .ts)
// ---------------------------------------------------------------------------
const router = express.Router();

// Only allow the playlist file and numbered segments.
const SAFE_FILE = /^(index\.m3u8|seg_\d{3,}\.ts)$/;

// Build the per-user XMLTV programme guide (service + account status).
function epgFor(user) {
  return buildEpgXml(user, {
    settings: Settings.all(),
    incidents: Incidents.all(),
    tz: config.timezone,
    daysAhead: config.epg.daysAhead,
    daysBehind: config.epg.daysBehind,
    expiringThresholdDays: config.expiringThresholdDays,
  });
}

function sendEpg(req, res, token) {
  if (!config.epg.enabled) return res.status(404).type('text/plain').send('EPG disabled');
  const user = Users.getByToken(token);
  if (!user) {
    log.warn('stream', 'EPG requested with unknown token');
    return res.status(404).type('text/plain').send('Unknown token');
  }
  return res
    .status(200)
    .set('Cache-Control', 'no-store, no-cache, must-revalidate')
    .type('application/xml; charset=utf-8')
    .send(epgFor(user));
}

function sendPlaylist(req, res, token) {
  const user = Users.getByToken(token);
  if (!user) {
    log.warn('stream', 'playlist requested with unknown token');
    return res.status(404).type('text/plain').send('Unknown token');
  }
  res
    .status(200)
    .type('application/x-mpegurl')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate')
    .set('Content-Disposition', `inline; filename="${user.username}.m3u"`)
    .send(renderUserPlaylist(user));
}

// GET /playlist.m3u?token=XXXX
router.get('/playlist.m3u', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).type('text/plain').send('Missing ?token=');
  sendPlaylist(req, res, token);
});

// GET /u/:token/playlist.m3u  (clean per-user URL — preferred; the query-string
// form leaks the token via access logs / Referer, so it needs TLS off-LAN)
router.get('/u/:token/playlist.m3u', (req, res) => sendPlaylist(req, res, req.params.token));

// GET /epg.xml?token=XXXX  -> XMLTV guide (advertised via url-tvg in the .m3u)
router.get('/epg.xml', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).type('text/plain').send('Missing ?token=');
  return sendEpg(req, res, token);
});

// GET /u/:token/epg.xml  (clean per-user URL)
router.get('/u/:token/epg.xml', (req, res) => sendEpg(req, res, req.params.token));

// GET /c/:token/:id -> the stream gateway (see channelStreamUrl above).
//
// Re-resolves this customer's entitlement to this one channel, then serves the
// provider's rewritten HLS manifest. Because the check happens per request
// rather than per playlist download, revoking a category, switching a channel
// off or letting a subscription lapse stops playback without the player ever
// re-downloading the .m3u — and since a player re-fetches a live media
// playlist every few seconds, it stops mid-view, not just at the next zap.
//
// Deliberately NOT gated on config.gateway.enabled: playlists handed out while
// the gateway was on stay in players long after an admin switches it off, and
// they must keep working. The flag only decides what NEW playlists point at.
router.get('/c/:token/:id', async (req, res) => {
  const { token, id } = req.params;
  const user = Users.getByToken(token);
  if (!user) {
    log.warn('gateway', 'channel requested with unknown token', { channel_id: id });
    return res.status(404).type('text/plain').send('Unknown token');
  }

  const status = accountStatus(user, config.expiringThresholdDays);
  const locked = status === 'expired' || status === 'disabled';
  const access = channelAccessForUser(user.id, id, {
    locked, planCategories: planCategorySet(user),
  });

  // Refused (or the channel is gone from the catalog entirely) -> their own
  // info channel, which is the card that explains the subscription. A 403 would
  // surface in the player as a generic "cannot play", i.e. as a support ticket.
  if (!access.allowed) {
    log.info('gateway', 'channel denied', {
      user_id: user.id, username: user.username, channel_id: id, reason: access.reason,
    });
    return redirectStream(res, userStreamUrl(user, config));
  }
  if (access.channel.id === INFO_CHANNEL_ID) return redirectStream(res, userStreamUrl(user, config));

  if (config.gateway.logRequests) {
    // One line per manifest fetch, opt-in (STREAM_GATEWAY_LOG). The User-Agent
    // is the point: it identifies which player component is asking, which is
    // what separates "the device never got here" from "it got here and then
    // could not use the answer".
    log.info('gateway', 'channel opened', {
      user_id: user.id,
      username: user.username,
      channel: access.channel.name || access.channel.id,
      mode: isHlsUrl(access.channel.url) ? 'manifest' : 'redirect',
      ua: req.get('user-agent') || '',
    });
  }

  // Non-HLS: nothing to rewrite, so the redirect is all there is. New playlists
  // no longer point here for those channels (see channelStreamUrl), but links
  // already sitting in players must keep doing what they always did.
  if (!isHlsUrl(access.channel.url)) return redirectStream(res, access.channel.url);

  try {
    const { text, finalUrl } = await fetchManifest(access.channel.url, req.get('user-agent'));
    return res
      .status(200)
      .set('Cache-Control', 'no-store, no-cache, must-revalidate')
      .set('Pragma', 'no-cache')
      .type('application/vnd.apple.mpegurl')
      .send(rewriteHlsManifest(text, finalUrl));
  } catch (e) {
    log.error('gateway', 'upstream manifest fetch failed', {
      user_id: user.id, channel_id: id, error: e.message,
    });
    return res.status(502).type('text/plain').send('Upstream unavailable');
  }
});

// Fetch one provider manifest, bounded the way catalog downloads are: a hostile
// or dead provider must not hang the request or exhaust memory while a viewer
// waits for a channel to open.
//
// The client's User-Agent is forwarded because providers routinely gate on it
// and answer a bare Node fetch with a 403; a caller that sends none gets the
// same VLC string the catalog fetcher uses. `finalUrl` is the URL after
// redirects — relative URIs in the manifest resolve against that, not against
// what we asked for.
async function fetchManifest(url, userAgent) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': userAgent || 'VLC/3.0.20 LibVLC/3.0.20' },
    signal: AbortSignal.timeout(config.gateway.manifestTimeoutMs),
  });
  if (!res.ok) throw new Error(`upstream responded ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > config.gateway.manifestMaxBytes) {
    throw new Error(`manifest is larger than the ${config.gateway.manifestMaxBytes} byte limit`);
  }
  return { text: buffer.toString('utf8'), finalUrl: res.url || url };
}

// 302 + no-store. Players cache aggressively, and a cached redirect would keep
// a revoked channel playable until the app is restarted — which is exactly the
// failure the gateway exists to fix.
//
// The provider's URL is passed through byte for byte whenever it is safe to put
// in a header (printable ASCII, no spaces, no CR/LF). res.redirect() would run
// it through encodeurl, which percent-encodes characters that are illegal in a
// URI but load-bearing in IPTV playlists — above all the `<url>|User-Agent=…`
// suffix convention — turning a working stream into a 404. Anything outside
// that set (a space, a non-ASCII path) does go through express, which encodes
// it correctly and keeps the header valid.
const HEADER_SAFE_URL = /^[\x21-\x7e]+$/;

function redirectStream(res, url) {
  res
    .set('Cache-Control', 'no-store, no-cache, must-revalidate')
    .set('Pragma', 'no-cache');
  if (!HEADER_SAFE_URL.test(url)) return res.redirect(302, url);
  return res.status(302).set('Location', url).type('text/plain').send(`Redirecting to ${url}`);
}

// GET /hls/:token/:file  -> serve (and lazily generate) the HLS stream.
router.get('/hls/:token/:file', async (req, res) => {
  const { token, file } = req.params;
  if (!SAFE_FILE.test(file)) return res.status(400).type('text/plain').send('Bad file');

  const user = Users.getByToken(token);
  if (!user) {
    log.warn('stream', 'HLS file requested with unknown token', { file });
    return res.status(404).type('text/plain').send('Unknown token');
  }

  try {
    await ensureUserStream(user); // generate on first request if needed
  } catch (e) {
    log.error('stream', 'generation failed', {
      user_id: user.id,
      username: user.username,
      error: e.message,
    });
    return res.status(500).type('text/plain').send('Stream generation failed');
  }

  const dir = userHlsDir(user.id);

  // Serve the master playlist as an endless live loop so players show a
  // continuous channel (no seek bar, no end) instead of a finite VOD clip.
  // Every viewer shares one live timeline; tuning in joins the stream wherever
  // it currently is, it does not restart at the intro.
  if (file === 'index.m3u8' && config.channel.liveLoop) {
    const playlist = buildLivePlaylist(dir, Date.now());
    if (playlist) {
      return res
        .status(200)
        .set('Cache-Control', 'no-store, no-cache, must-revalidate')
        .set('Pragma', 'no-cache')
        .type('application/vnd.apple.mpegurl')
        .send(playlist);
    }
    // Fall through to the on-disk VOD playlist if the loop can't be built.
  }

  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    log.warn('stream', 'requested HLS file is missing', {
      user_id: user.id,
      file,
    });
    return res.status(404).type('text/plain').send('Not found');
  }

  const contentType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
  return sendFileWithRange(req, res, filePath, contentType);
});

// Serve a static file honoring HTTP Range. ExoPlayer/IJK (Televizo) probe
// segments with `Range:` and can stall on a plain 200 that ignores it; we reply
// 206 with Content-Range so they get the bytes they asked for.
function sendFileWithRange(req, res, filePath, contentType) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return res.status(404).type('text/plain').send('Not found');
  }
  const total = stat.size;
  res
    .set('Cache-Control', 'no-store, no-cache, must-revalidate')
    .set('Accept-Ranges', 'bytes')
    .type(contentType);

  const match = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range || '').trim());
  if (match && (match[1] !== '' || match[2] !== '')) {
    let start;
    let end;
    if (match[1] === '') {
      // Suffix range: the final N bytes.
      start = Math.max(0, total - Number(match[2]));
      end = total - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
    }
    if (start > end || start >= total) {
      return res.status(416).set('Content-Range', `bytes */${total}`).end();
    }
    res
      .status(206)
      .set('Content-Range', `bytes ${start}-${end}/${total}`)
      .set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.status(200).set('Content-Length', String(total));
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// OTT-play FOSS endpoints. The generated playlist uses static/direct JSON, while
// the match endpoints remain available for clients configured with this server.
// ---------------------------------------------------------------------------
const rawBody = express.raw({ type: () => true, limit: '1mb' });

function setPublicHeaders(res) {
  return res
    .set('Access-Control-Allow-Origin', '*')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate')
    .set('Pragma', 'no-cache')
    .set('Expires', '0');
}

export function createFossEpgRouter({
  config: cfg = config,
  Users: UsersImpl = Users,
  Settings: SettingsImpl = Settings,
  Incidents: IncidentsImpl = Incidents,
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const fossRouter = express.Router();
  const providerId = normalizeFossProviderId(cfg.epg.foss.providerId);

  // `user` is optional: only channels.json needs the per-user URLs, and it is
  // the one caller that has to declare which playlist this provider serves.
  function epgOpts(user = null) {
    return {
      settings: SettingsImpl.all(),
      incidents: IncidentsImpl.all(),
      now: now(),
      tz: cfg.timezone,
      // channels.json matching requires the latest programme start in the future.
      daysAhead: Math.max(1, cfg.epg.daysAhead),
      daysBehind: cfg.epg.daysBehind,
      expiringThresholdDays: cfg.expiringThresholdDays,
      providerId,
      // Exactly the `url-tvg` this customer's .m3u advertises — OTT-play hashes
      // it to decide whether this provider applies to their playlist at all.
      epgUrls: user && cfg.epg.enabled ? [userEpgUrl(user, cfg)] : [],
      logoUrl: user ? fossLogoUrl(user, cfg) : '',
    };
  }

  const providerBaseUrl = (user) => fossProviderBaseUrl(user, cfg);

  fossRouter.options('*', (req, res) => setPublicHeaders(res)
    .set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .set('Access-Control-Allow-Headers', 'Content-Type')
    .status(204)
    .end());

  fossRouter.post('/m3u/match-channels', rawBody, async (req, res) => {
    const requestBody = req.body?.toString('utf8') || '';
    const parsed = parseMatchRequest(requestBody);
    if (!parsed) {
      return setPublicHeaders(res).status(400).type('text/plain').send('Bad Request');
    }

    // Index users by their FOSS id hash once, so resolving N request channels is
    // O(N) lookups instead of O(channels × users) hashes.
    const usersByHash = new Map();
    for (const user of UsersImpl.all()) {
      const hash = fossIdHash(user);
      usersByHash.set(hash, { user, idHash: String(hash) });
    }
    const resolve = (channel) => usersByHash.get(Number(channel.tvgIdHash)) || null;
    const localBody = buildMatchChannelsResponse(
      parsed.channels,
      resolve,
      providerBaseUrl,
      providerId,
    );

    let body = localBody;
    const upstreamBase = cfg.epg.foss.upstreamMatchUrl;
    if (upstreamBase && typeof fetchImpl === 'function') {
      try {
        const upstream = await fetchImpl(`${upstreamBase}/m3u/match-channels`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: requestBody,
          signal: AbortSignal.timeout(10_000),
        });
        if (upstream.ok) {
          body = mergeMatchChannelsResponses(localBody, await upstream.text());
        } else {
          log.warn('foss-epg', 'upstream match server returned an error', {
            status: upstream.status,
          });
        }
      } catch (error) {
        log.warn('foss-epg', 'upstream match server unavailable', { error: error.message });
      }
    }

    return setPublicHeaders(res).status(200).type('text/plain; charset=utf-8').send(body);
  });

  fossRouter.post('/m3u/match-logos', rawBody, (req, res) => setPublicHeaders(res)
    .status(200)
    .type('text/plain; charset=utf-8')
    .send(EMPTY_LOGO_MATCH_RESPONSE));

  fossRouter.get('/foss-epg/u/:token/channels.json', (req, res) => {
    const user = UsersImpl.getByToken(req.params.token);
    if (!user) {
      return setPublicHeaders(res).status(404).type('text/plain').send('Unknown token');
    }
    return setPublicHeaders(res).status(200).json(buildFossChannelsJson(user, epgOpts(user)));
  });

  fossRouter.get('/foss-epg/u/:token/epg/:file', (req, res) => {
    const match = /^(\d+)\.json$/.exec(req.params.file);
    if (!match) return setPublicHeaders(res).status(400).type('text/plain').send('Bad file');

    const user = UsersImpl.getByToken(req.params.token);
    if (!user) {
      return setPublicHeaders(res).status(404).type('text/plain').send('Unknown token');
    }
    if (Number(match[1]) !== fossIdHash(user)) {
      log.warn('foss-epg', 'EPG requested with mismatched hash', { token: req.params.token });
      return setPublicHeaders(res).status(404).type('text/plain').send('Not found');
    }
    return setPublicHeaders(res).status(200).json(buildFossEpgJson(user, epgOpts()));
  });

  fossRouter.get('/foss-epg/u/:token/logo.svg', (req, res) => {
    const user = UsersImpl.getByToken(req.params.token);
    if (!user) {
      return setPublicHeaders(res).status(404).type('text/plain').send('Unknown token');
    }
    return setPublicHeaders(res)
      .status(200)
      .type('image/svg+xml; charset=utf-8')
      .send(buildFossLogoSvg(SettingsImpl.all()));
  });

  return fossRouter;
}

// Default FOSS router instance (mounted by server.js when FOSS EPG is enabled).
export const fossEpgRouter = createFossEpgRouter();

export default router;
