// OTT-play FOSS JSON guide and match-protocol helpers. Pure logic, no I/O.
import {
  epgChannelId, eachEpgDay, dayStartUnix, xmlEscape,
} from './epg.js';
import { xxhash32 } from './xxhash32.js';

const DEFAULT_PROVIDER_ID = 'infochannel';
export const MATCH_BLOCK_SEP = '\n\t\n';
const FIELD_SEP = '¦';
const UINT32_MAX = 0xffffffff;

export function normalizeFossProviderId(value) {
  const id = String(value || DEFAULT_PROVIDER_ID).trim().replace(/^=+/, '');
  return /^[A-Za-z0-9._-]+$/.test(id) ? id : DEFAULT_PROVIDER_ID;
}

// The channel-id hash OTT-play looks a programme file up by: xxhash32 of the
// tvg-id. The converter uses its `HashSting32i` helper, i.e. the id is lowered
// first — our ids are already lowercase (`account-` + a lowercase-alphabet
// token), but fold explicitly so a future id shape can't silently break lookup.
export function fossIdHash(user) {
  return xxhash32(epgChannelId(user).toLowerCase());
}

// OTT-play binds a FOSS provider to a playlist through `meta.url-hashes`: the
// hash of every `url-tvg` this provider can serve, taken over the URL with the
// scheme cut off (the converter's `CutHTTP`) and — unlike the channel id —
// WITHOUT case folding. A provider that publishes an empty list claims to serve
// no playlist at all, which is why the guide never bound to the channel.
//
// Verified against the live providers: xxhash32('iptvx.one/EPG') === 2853413468
// is exactly what https://epg.ottp.eu.org/iptvx.one/channels.json publishes.
export function fossUrlHash(url) {
  return xxhash32(String(url).replace(/^https?:\/\//, ''));
}

export function buildFossChannelsJson(user, opts = {}) {
  const { settings = {}, epgUrls = [], logoUrl = '' } = opts;
  const providerId = normalizeFossProviderId(opts.providerId);
  const brand = settings.brand_name || 'Мой IPTV-сервис';
  const name = `${brand} — ${user.username}`;
  const { days, tz } = eachEpgDay(user, opts);
  const nowUnix = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);
  const lastDate = days.at(-1)?.date;
  // channels.json only needs the latest programme start (the top of the guide).
  const topProgrammeStart = lastDate ? dayStartUnix(lastDate, tz) : nowUnix;
  const idHash = String(fossIdHash(user));

  return {
    meta: {
      id: providerId,
      'url-hashes': epgUrls.filter(Boolean).map(fossUrlHash),
      'last-upd': nowUnix,
      'last-epg': topProgrammeStart,
    },
    data: {
      // "<tvg-id>¦<newest programme start>¦<icon url>", then the name aliases —
      // the exact row shape the reference converter emits.
      [idHash]: [
        `${epgChannelId(user)}${FIELD_SEP}${topProgrammeStart}${FIELD_SEP}${logoUrl}`,
        name,
      ],
    },
  };
}

// OTT-play FOSS shows `name` in the channel list and `descr` in the programme
// details — the same two roles XMLTV gives title/desc, so both guides render the
// identical day records. `descr` used to be empty here, which left FOSS users
// with no subscription status at all.
export function buildFossEpgJson(user, opts = {}) {
  const { days, tz } = eachEpgDay(user, opts);
  return {
    epg_data: days.map((day) => ({
      name: day.title,
      descr: day.desc,
      time: dayStartUnix(day.date, tz),
      time_to: dayStartUnix(day.next, tz),
    })),
  };
}

function isUint32String(value) {
  if (!/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= UINT32_MAX;
}

export function parseMatchRequest(body) {
  const blocks = String(body).split(MATCH_BLOCK_SEP);
  if (blocks.length !== 3) return null;

  const channels = [];
  for (const line of blocks[2].split('\n')) {
    if (!line) continue;
    const channelData = line.split('~', 1)[0];
    const fields = channelData.split('-');
    if (fields.length !== 4 || !fields.every(isUint32String)) continue;
    const [key, tvgIdHash, tvgNameHash, nameHash] = fields;
    channels.push({
      key,
      tvgIdHash,
      tvgNameHash,
      nameHash,
    });
  }
  return { metadata: blocks[0], tvgUrls: blocks[1], channels };
}

export function buildMatchChannelsResponse(
  channels,
  resolve,
  providerUrlFor,
  providerId = DEFAULT_PROVIDER_ID,
) {
  const id = normalizeFossProviderId(providerId);
  const matched = [];
  let providerUrl = '';

  for (const channel of channels) {
    const hit = resolve(channel);
    if (!hit) continue;
    matched.push(`${channel.key}~${id}~${hit.idHash}`);
    providerUrl ||= providerUrlFor(hit.user);
  }

  return [
    '{}',
    matched.join('\n'),
    providerUrl ? `${id}~${providerUrl}` : '',
  ].join(MATCH_BLOCK_SEP);
}

export const EMPTY_CHANNEL_MATCH_RESPONSE = ['{}', '', ''].join(MATCH_BLOCK_SEP);

// The shipped client and upstream Go server use two blocks for match-logos.
export const EMPTY_LOGO_MATCH_RESPONSE = ['{}', ''].join(MATCH_BLOCK_SEP);

export function mergeMatchChannelsResponses(localBody, upstreamBody) {
  const localBlocks = String(localBody).split(MATCH_BLOCK_SEP);
  const upstreamBlocks = String(upstreamBody).split(MATCH_BLOCK_SEP);
  if (localBlocks.length !== 3) return upstreamBlocks.length === 3 ? upstreamBody : localBody;
  if (upstreamBlocks.length !== 3) return localBody;

  const channels = new Map();
  const providers = new Map();

  function addChannels(block, overwrite) {
    for (const line of block.split('\n')) {
      if (!line) continue;
      const [key] = line.split('~');
      if (!key || (!overwrite && channels.has(key))) continue;
      channels.set(key, line);
    }
  }

  function addProviders(block, overwrite) {
    for (const line of block.split('\n')) {
      if (!line) continue;
      const separator = line.indexOf('~');
      if (separator < 1) continue;
      const id = line.slice(0, separator);
      if (!overwrite && providers.has(id)) continue;
      providers.set(id, line);
    }
  }

  addChannels(upstreamBlocks[1], false);
  addChannels(localBlocks[1], true);
  addProviders(upstreamBlocks[2], false);
  addProviders(localBlocks[2], true);

  const usedProviderIds = new Set(
    [...channels.values()].map((line) => line.split('~')[1]).filter(Boolean),
  );
  return [
    '{}',
    [...channels.values()].join('\n'),
    [...providers]
      .filter(([id]) => usedProviderIds.has(id))
      .map(([, line]) => line)
      .join('\n'),
  ].join(MATCH_BLOCK_SEP);
}

export function buildFossLogoSvg(settings = {}) {
  const brand = settings.brand_name || 'IPTV';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0b1224"/>
  <circle cx="256" cy="206" r="94" fill="#38bdf8"/>
  <rect x="226" y="292" width="60" height="104" rx="30" fill="#e6edf7"/>
  <text x="256" y="466" fill="#e6edf7" font-family="Arial,sans-serif" font-size="36" text-anchor="middle">${xmlEscape(brand)}</text>
</svg>`;
}
