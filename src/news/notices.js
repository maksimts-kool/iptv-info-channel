// Pure logic for the upstream provider's news feed (tv.team `/v3/news`): turn
// the feed's HTML items into short service notices for the status slide, and
// keep the provider's session cookie jar current. No I/O, no module state —
// unit-tested directly (test/news/notices.test.js). The fetching, persistence
// and scheduling live in news/providernews.js.
//
// Only notices about the provider's SERVICE are kept — maintenance, outages,
// channels temporarily unavailable. The same feed also announces channel
// launches and removals; those are news, not status, and must never reach the
// status board (isServiceNotice decides).
import { localTimeToDate } from '../core/util.js';

// Short label per notice kind, shown on the slide and in the admin.
export const NOTICE_KIND = {
  maintenance: 'Технические работы',
  outage: 'Перебои в работе',
};

// ---- HTML -> text ----

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

// One entry per paragraph/line, tags stripped, entities decoded, blank lines dropped.
export function htmlToParagraphs(html) {
  return String(html ?? '')
    .split(/<\/p>|<br\s*\/?>|<\/div>|<\/li>/i)
    .map((chunk) => decodeEntities(chunk.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// A language section starts at a flag + two-letter code ("🇷🇺 RU", "🇬🇧 EN").
// The code must be ASCII, so a footer like "🇷🇺 Россия" is not a section marker.
const LANG_MARKER = /[\u{1F1E6}-\u{1F1FF}]{2}\s*([A-Z]{2})(?!\p{L})/gu;

// The text of one language section; the whole text when the item isn't split
// into sections, the first section when the wanted language is missing.
export function languageSection(text, lang = 'RU') {
  const marks = [...String(text ?? '').matchAll(LANG_MARKER)];
  if (!marks.length) return String(text ?? '').trim();
  const i = Math.max(0, marks.findIndex((m) => m[1] === lang));
  const start = marks[i].index + marks[i][0].length;
  const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
  return text.slice(start, end).trim();
}

// Emoji render as tofu (or not at all) in the SVG rasterizer, so they go.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;

export function stripEmoji(text) {
  return String(text ?? '')
    .replace(EMOJI, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([!?.,:;])/g, '$1')
    .trim();
}

// ---- Classification ----

// Matched against the lowercased text of every language, so an item that is
// only in English is still recognised. Cyrillic needs lookarounds: JS `\b` is
// ASCII-only even with the `u` flag.
const MAINTENANCE_PATTERNS = [
  /техническ\p{L}* работ/u,
  /техработ/u,
  /профилактическ/u,
  /планов\p{L}* (?:работ|замен|обслуживан|обновлени)/u,
  /maintenance/,
];
const OUTAGE_PATTERNS = [
  /перебо/u,
  /(?<!\p{L})сбо(?:й|я|ю|е|и|ев|ями|ях)(?!\p{L})/u,
  /авари/u,
  /неполадк/u,
  /недоступн/u,
  /не работа(?:ет|ют)/u,
  /нестабильн/u,
  /проблем\p{L}* (?:с|в) (?:вещани|работ|доступ|сервер|архив|воспроизвед)/u,
  /восстановлен\p{L}* (?:работ|вещани|доступ)/u,
  /(?:работ\p{L}*|вещани\p{L}*|доступ) (?:\p{L}+ ){0,3}восстановлен/u,
  /outage|disruption|temporarily unavailable/,
];

export function isServiceNotice(text) {
  const t = String(text ?? '').toLowerCase();
  return [...MAINTENANCE_PATTERNS, ...OUTAGE_PATTERNS].some((re) => re.test(t));
}

export function noticeKind(text) {
  const t = String(text ?? '').toLowerCase();
  return MAINTENANCE_PATTERNS.some((re) => re.test(t)) ? 'maintenance' : 'outage';
}

// Closing politeness that eats a line of the slide without saying anything.
const BOILERPLATE = /приносим (?:свои )?извинения|благодарим за (?:ваше )?понимание|спасибо за (?:ваше )?понимание|следите за новостями/u;

export function splitSentences(text) {
  return String(text ?? '').split(/(?<=[.!?…])\s+/u).map((s) => s.trim()).filter(Boolean);
}

// { headline, body }: a short exclaimed opener ("Технические работы!") becomes
// the headline, otherwise the kind label does; apology boilerplate is dropped
// from the body unless it is all there is.
export function summarizeNotice(text, kind = 'outage') {
  let sentences = splitSentences(text);
  let headline = NOTICE_KIND[kind] || NOTICE_KIND.outage;
  if (sentences.length > 1 && sentences[0].length <= 48 && !/\.$/.test(sentences[0])) {
    headline = sentences[0].replace(/[!:…]+$/u, '').trim();
    sentences = sentences.slice(1);
  }
  const meaningful = sentences.filter((s) => !BOILERPLATE.test(s.toLowerCase()));
  return { headline, body: (meaningful.length ? meaningful : sentences).join(' ') };
}

// ---- Feed parsing ----

// "14.09.2026 13:06:44" is the provider's wall clock; read it in `tz`.
export function parseProviderDate(value, tz) {
  const text = String(value ?? '').trim();
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) {
    return localTimeToDate(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), tz);
  }
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The service notices in a `/v3/news` response, newest first.
export function extractServiceNotices(json, { tz, lang = 'RU', limit = 5 } = {}) {
  const items = json?.data?.items ?? json?.items ?? [];
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.isPublished === false) continue;
    const full = htmlToParagraphs(item.html ?? item.text ?? '').join('\n');
    if (!full || !isServiceNotice(full)) continue;
    const published = parseProviderDate(item.date, tz);
    if (!published) continue;
    const kind = noticeKind(full);
    const text = stripEmoji(languageSection(full, lang));
    const { headline, body } = summarizeNotice(text, kind);
    out.push({
      id: String(item.id ?? published.getTime()),
      published_at: published.toISOString(),
      kind,
      headline,
      body,
      // The whole section, for the AI retelling (news/aisummary.js) and the admin.
      text,
    });
  }
  return out
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .slice(0, limit);
}

// Notices recent enough to still be on screen. A notice has no end date, so
// age is the only way one leaves the slide.
export function activeNotices(notices, { now = new Date(), maxAgeHours = 48 } = {}) {
  const cutoff = now.getTime() - maxAgeHours * 3_600_000;
  return (Array.isArray(notices) ? notices : [])
    .filter((n) => Date.parse(n.published_at) >= cutoff);
}

// ---- Session cookie jar ----

// "a=1; b=2" (optionally pasted with a leading "Cookie:") -> Map.
export function parseCookieHeader(header) {
  const jar = new Map();
  const text = String(header ?? '').replace(/^\s*cookie\s*:/i, '');
  for (const part of text.split(/;|\r?\n/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) jar.set(name, part.slice(eq + 1).trim());
  }
  return jar;
}

export function serializeCookies(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Apply a response's Set-Cookie lines to a Cookie header: a rotated session
// replaces the old value, an expired/emptied cookie is removed.
export function applySetCookies(header, setCookies = [], now = Date.now()) {
  const jar = parseCookieHeader(header);
  for (const line of setCookies) {
    const [pair, ...attrs] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some((attr) => {
      const at = attr.indexOf('=');
      const key = (at === -1 ? attr : attr.slice(0, at)).trim().toLowerCase();
      const val = at === -1 ? '' : attr.slice(at + 1).trim();
      if (key === 'max-age') return Number(val) <= 0;
      if (key === 'expires') {
        const t = Date.parse(val);
        return Number.isFinite(t) && t <= now;
      }
      return false;
    });
    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return serializeCookies(jar);
}
