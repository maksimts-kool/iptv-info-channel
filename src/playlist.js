import { epgChannelId } from './epg.js';
import { normalizeFossProviderId } from './epgfoss.js';

function attr(value) {
  return String(value ?? '')
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ');
}

export function fossProviderBaseUrl(user, cfg) {
  return `${cfg.publicBaseUrl}/foss-epg/u/${encodeURIComponent(user.token)}/`;
}

export function buildUserPlaylist(user, settings, cfg) {
  const brand = settings.brand_name || 'Мой IPTV-сервис';
  const name = `${brand} — ${user.username}`;
  const streamUrl = `${cfg.publicBaseUrl}/hls/${encodeURIComponent(user.token)}/index.m3u8`;
  const tvgId = epgChannelId(user);
  const fossEnabled = cfg.epg.enabled && cfg.epg.foss.enabled;
  const providerId = normalizeFossProviderId(cfg.epg.foss.providerId);
  const providerBase = fossProviderBaseUrl(user, cfg);
  const logoUrl = `${providerBase}logo.svg`;

  const headerAttrs = [];
  if (cfg.epg.enabled) {
    headerAttrs.push(`url-tvg="${attr(`${cfg.publicBaseUrl}/u/${user.token}/epg.xml`)}"`);
  }
  if (fossEnabled) {
    // The leading "=" on the source definition is required by OTT-play's
    // parser. It makes the player fetch epg/<xxhash(tvg-id)>.json directly.
    headerAttrs.push(`foss-tvg="=${providerId}::${attr(providerBase)}"`);
  }

  const channelAttrs = [
    `tvg-id="${attr(tvgId)}"`,
    `tvg-name="${attr(name)}"`,
    `group-title="Аккаунт"`,
  ];
  if (fossEnabled) {
    channelAttrs.splice(1, 0, `tvg-source="=${providerId}"`);
    // A real logo URL prevents a separate central match-logos request.
    channelAttrs.splice(3, 0, `tvg-logo="${attr(logoUrl)}"`);
  }

  return [
    headerAttrs.length ? `#EXTM3U ${headerAttrs.join(' ')}` : '#EXTM3U',
    `#EXTINF:-1 ${channelAttrs.join(' ')},${name}`,
    streamUrl,
    '',
  ].join('\n');
}
