// OTT-play FOSS endpoints. The generated playlist uses static/direct JSON, while
// the match endpoints remain available for clients configured with this server.
import express from 'express';
import { config as appConfig } from '../config.js';
import { Users as AppUsers, Settings as AppSettings, Incidents as AppIncidents } from '../db.js';
import {
  fossIdHash,
  findUserByIdHash,
  buildFossChannelsJson,
  buildFossEpgJson,
  parseMatchRequest,
  buildMatchChannelsResponse,
  mergeMatchChannelsResponses,
  EMPTY_LOGO_MATCH_RESPONSE,
  buildFossLogoSvg,
  normalizeFossProviderId,
} from '../epgfoss.js';
import { log } from '../logger.js';

const rawBody = express.raw({ type: () => true, limit: '1mb' });

function setPublicHeaders(res) {
  return res
    .set('Access-Control-Allow-Origin', '*')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate')
    .set('Pragma', 'no-cache')
    .set('Expires', '0');
}

export function createFossEpgRouter({
  config = appConfig,
  Users = AppUsers,
  Settings = AppSettings,
  Incidents = AppIncidents,
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const router = express.Router();
  const providerId = normalizeFossProviderId(config.epg.foss.providerId);

  function epgOpts() {
    return {
      settings: Settings.all(),
      incidents: Incidents.all(),
      now: now(),
      tz: config.timezone,
      // channels.json matching requires the latest programme start in the future.
      daysAhead: Math.max(1, config.epg.daysAhead),
      daysBehind: config.epg.daysBehind,
      expiringThresholdDays: config.expiringThresholdDays,
      providerId,
    };
  }

  function providerBaseUrl(user) {
    return `${config.publicBaseUrl}/foss-epg/u/${encodeURIComponent(user.token)}/`;
  }

  router.options('*', (req, res) => setPublicHeaders(res)
    .set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .set('Access-Control-Allow-Headers', 'Content-Type')
    .status(204)
    .end());

  router.post('/m3u/match-channels', rawBody, async (req, res) => {
    const requestBody = req.body?.toString('utf8') || '';
    const parsed = parseMatchRequest(requestBody);
    if (!parsed) {
      return setPublicHeaders(res).status(400).type('text/plain').send('Bad Request');
    }

    const users = Users.all();
    const resolve = (channel) => {
      const user = findUserByIdHash(users, channel.tvgIdHash);
      return user ? { user, idHash: String(fossIdHash(user)) } : null;
    };
    const localBody = buildMatchChannelsResponse(
      parsed.channels,
      resolve,
      providerBaseUrl,
      providerId,
    );

    let body = localBody;
    const upstreamBase = config.epg.foss.upstreamMatchUrl;
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

  router.post('/m3u/match-logos', rawBody, (req, res) => setPublicHeaders(res)
    .status(200)
    .type('text/plain; charset=utf-8')
    .send(EMPTY_LOGO_MATCH_RESPONSE));

  router.get('/foss-epg/u/:token/channels.json', (req, res) => {
    const user = Users.getByToken(req.params.token);
    if (!user) {
      return setPublicHeaders(res).status(404).type('text/plain').send('Unknown token');
    }
    return setPublicHeaders(res).status(200).json(buildFossChannelsJson(user, epgOpts()));
  });

  router.get('/foss-epg/u/:token/epg/:file', (req, res) => {
    const match = /^(\d+)\.json$/.exec(req.params.file);
    if (!match) return setPublicHeaders(res).status(400).type('text/plain').send('Bad file');

    const user = Users.getByToken(req.params.token);
    if (!user) {
      return setPublicHeaders(res).status(404).type('text/plain').send('Unknown token');
    }
    if (Number(match[1]) !== fossIdHash(user)) {
      log.warn('foss-epg', 'EPG requested with mismatched hash', { token: req.params.token });
      return setPublicHeaders(res).status(404).type('text/plain').send('Not found');
    }
    return setPublicHeaders(res).status(200).json(buildFossEpgJson(user, epgOpts()));
  });

  router.get('/foss-epg/u/:token/logo.svg', (req, res) => {
    const user = Users.getByToken(req.params.token);
    if (!user) {
      return setPublicHeaders(res).status(404).type('text/plain').send('Unknown token');
    }
    return setPublicHeaders(res)
      .status(200)
      .type('image/svg+xml; charset=utf-8')
      .send(buildFossLogoSvg(Settings.all()));
  });

  return router;
}

export default createFossEpgRouter();
