// Provider service notices on the status slide: settings, fetching and the
// polling watcher. The parsing/classification is pure and lives in notices.js.
//
// The feed (tv.team `/v3/news`) sits behind the provider's web login, which is
// a cookie session. The admin pastes the browser's Cookie header once; when the
// feed answers 401/403 the watcher calls the site's own `/v3/auth/refresh`
// with that jar and persists whatever cookies come back, so a rotated session
// keeps working without another paste.
//
// Stored under Settings `provider_news` ({ enabled, url, cookie, notices }).
// The cookie is a credential: never hand Settings.all() to a client without
// removing that key (see publicSettings in http/admin.js).
import { config } from '../config.js';
import { Settings } from '../data/store.js';
import { log } from '../core/logger.js';
import { activeNotices, applySetCookies, extractServiceNotices } from './notices.js';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Accept: 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
};
// A news page is a few kilobytes; anything near this is the wrong URL.
const MAX_BYTES = 2 * 1024 * 1024;

// In-memory only: the outcome of the last attempt, for the admin card.
const runtime = { checkedAt: null, error: null, authFailed: false };

function stored() {
  const value = Settings.all().provider_news;
  return value && typeof value === 'object' ? value : {};
}

function saveStored(patch) {
  Settings.set('provider_news', { ...stored(), ...patch });
}

// Admin values overlaid onto the env defaults.
export function providerNewsSettings() {
  const s = stored();
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : config.providerNews.enabled,
    url: s.url || config.providerNews.url,
    cookie: typeof s.cookie === 'string' ? s.cookie : config.providerNews.cookie,
    notices: Array.isArray(s.notices) ? s.notices : [],
  };
}

export function updateProviderNewsSettings({ enabled, url, cookie }) {
  const patch = {};
  if (enabled !== undefined) patch.enabled = enabled;
  if (url !== undefined) patch.url = url;
  if (cookie !== undefined) {
    patch.cookie = cookie;
    runtime.authFailed = false;
  }
  // A different feed makes the stored notices meaningless.
  if (url !== undefined && (url || config.providerNews.url) !== providerNewsSettings().url) {
    patch.notices = [];
  }
  saveStored(patch);
}

// What the status slide shows right now ([] when the feature is off).
export function currentProviderNotices(now = new Date()) {
  const s = providerNewsSettings();
  if (!s.enabled) return [];
  return activeNotices(s.notices, { now, maxAgeHours: config.providerNews.maxAgeHours });
}

// The status slide is global, so any change to what it shows means a rebuild
// of every stream. Both the watcher and the admin routes ask this; the first
// caller to see a change gets `true`, so the same change isn't rebuilt twice.
const shownKey = (notices) => JSON.stringify(notices.map((n) => [n.id, n.headline, n.body]));
let lastShown = null;
export function consumeShownChange() {
  const key = shownKey(currentProviderNotices());
  if (lastShown === null || key === lastShown) {
    lastShown = key;
    return false;
  }
  lastShown = key;
  return true;
}

function setCookiesOf(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function request(url, { method = 'GET', cookie, fetchImpl }) {
  const { origin } = new URL(url);
  return fetchImpl(url, {
    method,
    headers: {
      ...BROWSER_HEADERS,
      Origin: origin,
      Referer: `${origin}/`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(config.providerNews.timeoutMs),
  });
}

async function readJson(res) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error(`news response is larger than ${MAX_BYTES} bytes`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error(`news response is larger than ${MAX_BYTES} bytes`);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('news response is not JSON');
  }
}

const isAuthFailure = (res) => res.status === 401 || res.status === 403;

async function fetchNotices(fetchImpl) {
  const s = providerNewsSettings();
  let cookie = s.cookie || '';
  let res = await request(s.url, { cookie, fetchImpl });
  cookie = applySetCookies(cookie, setCookiesOf(res));

  if (isAuthFailure(res) && cookie) {
    const refreshUrl = config.providerNews.refreshUrl || new URL('/v3/auth/refresh', s.url).href;
    const refreshed = await request(refreshUrl, { method: 'POST', cookie, fetchImpl });
    cookie = applySetCookies(cookie, setCookiesOf(refreshed));
    if (refreshed.ok) {
      res = await request(s.url, { cookie, fetchImpl });
      cookie = applySetCookies(cookie, setCookiesOf(res));
    }
  }
  // Persist a rotated session even when the request itself failed.
  if (cookie !== (s.cookie || '')) saveStored({ cookie });

  if (isAuthFailure(res)) {
    const err = new Error(`provider rejected the session (${res.status})`);
    err.authFailed = true;
    throw err;
  }
  if (!res.ok) throw new Error(`provider responded ${res.status}`);
  return extractServiceNotices(await readJson(res), { tz: config.timezone });
}

// One fetch at a time. A failure keeps the previous notices (a provider hiccup
// must not wipe a real maintenance notice); they still age out on their own.
let running = null;
export function refreshProviderNews({ fetchImpl = globalThis.fetch } = {}) {
  if (running) return running;
  running = (async () => {
    try {
      const notices = await fetchNotices(fetchImpl);
      if (JSON.stringify(notices) !== JSON.stringify(providerNewsSettings().notices)) {
        saveStored({ notices });
        log.info('provider-news', 'service notices updated', {
          notices: notices.length, newest: notices[0]?.headline || null,
        });
      }
      Object.assign(runtime, { error: null, authFailed: false });
    } catch (e) {
      Object.assign(runtime, { error: e.message, authFailed: Boolean(e.authFailed) });
      log.warn('provider-news', 'fetch failed', { error: e.message });
    } finally {
      runtime.checkedAt = new Date().toISOString();
    }
    return { error: runtime.error };
  })().finally(() => { running = null; });
  return running;
}

// The admin card's view. Carries whether a cookie is set, never the cookie.
export function providerNewsView(now = new Date()) {
  const s = providerNewsSettings();
  const shown = new Set(currentProviderNotices(now).map((n) => n.id));
  return {
    enabled: s.enabled,
    url: s.url,
    default_url: config.providerNews.url,
    cookie_set: Boolean(s.cookie),
    checked_at: runtime.checkedAt,
    error: runtime.error,
    auth_failed: runtime.authFailed,
    check_minutes: config.providerNews.checkMinutes,
    max_age_hours: config.providerNews.maxAgeHours,
    notices: s.notices.map((n) => ({ ...n, active: shown.has(n.id) })),
  };
}

// Poll the feed and call `onChange` whenever what the slide shows changes —
// including a notice ageing out between fetches. First tick runs immediately.
let timer = null;
export function startProviderNewsWatcher({
  onChange,
  intervalMs = Math.max(1, config.providerNews.checkMinutes) * 60_000,
} = {}) {
  if (timer) return timer;
  consumeShownChange(); // baseline: what the streams were just built with
  const tick = async () => {
    if (providerNewsSettings().enabled) await refreshProviderNews();
    if (consumeShownChange()) onChange?.();
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();
  log.info('provider-news', 'watcher started', { check_every_minutes: Math.round(intervalMs / 60_000) });
  return timer;
}
