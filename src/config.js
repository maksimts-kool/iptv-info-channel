// Loads a .env file (if present) into process.env without external deps,
// then exposes a typed config object used across the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// --- minimal .env loader (no dependency) ---
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // A variable already present in the environment wins over the .env file, so
    // Docker/compose `environment:` values and shell exports override .env.
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();
process.env.TZ ||= 'Europe/Tallinn';

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
// Env flag: defaults to `d` (true) unless explicitly set to "false".
const bool = (v, d = true) => (v ?? String(d)).toLowerCase() !== 'false';
// Express `trust proxy` value: number of trusted proxy hops, a boolean, or a
// passthrough string (e.g. a subnet). Defaults to false (use the socket IP).
const parseTrustProxy = (v) => {
  if (v === undefined || v === '') return false;
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

const DATA_DIR = path.isAbsolute(process.env.DATA_DIR || 'data')
  ? process.env.DATA_DIR
  : path.join(ROOT, process.env.DATA_DIR || 'data');
const DEFAULT_MUSIC_FILE = path.join(ROOT, 'assets/music/background.mp3');
const configuredMusicFile = process.env.MUSIC_FILE
  ? (path.isAbsolute(process.env.MUSIC_FILE)
    ? process.env.MUSIC_FILE
    : path.join(ROOT, process.env.MUSIC_FILE))
  : DEFAULT_MUSIC_FILE;

export const config = {
  root: ROOT,
  port: num(process.env.PORT, 9222),
  timezone: process.env.TZ,
  // Baked into every generated .m3u/HLS URL. On a LAN this MUST be the host IP
  // the IPTV box can reach (e.g. http://192.168.1.50:9222) — never localhost —
  // or the links the player receives will 404. Off-LAN it should be an https://
  // origin so the per-user token in the path isn't exposed in plaintext.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${num(process.env.PORT, 9222)}`).replace(/\/+$/, ''),

  adminPassword: process.env.ADMIN_PASSWORD || 'changeme',
  sessionSecret: process.env.SESSION_SECRET || 'please-change-this-to-a-long-random-string',
  // Trusted reverse-proxy hops for req.ip (used by the /sub rate limiter). Set
  // TRUST_PROXY=1 behind one proxy (nginx / DO load balancer); leave unset
  // (false) on a directly-exposed port so clients can't spoof X-Forwarded-For.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  channel: {
    // On-screen seconds for the account (info) card — its own slide duration,
    // matching how the intro/status/World Cup slides each set their own. The
    // loop total is the sum of every enabled slide, rounded up to whole HLS
    // segments (the still card absorbs the small rounding slack).
    accountSlideSeconds: num(process.env.ACCOUNT_SLIDE_SECONDS, 15),
    width: num(process.env.CHANNEL_WIDTH, 1280),
    height: num(process.env.CHANNEL_HEIGHT, 720),
    // The card is essentially a still image, so a high frame rate just burns CPU
    // re-encoding identical frames. Low rates are visually identical here.
    fps: num(process.env.CHANNEL_FPS, 12),          // intro path (has a short xfade)
    stillFps: num(process.env.CHANNEL_STILL_FPS, 4), // plain still-card path
    // libx264 preset. For a static image the quality cost of `ultrafast` is
    // irrelevant but the CPU savings are large.
    preset: process.env.FFMPEG_PRESET || 'ultrafast',
    // HLS segment length (seconds). Keyframes are forced on these boundaries.
    hlsTime: num(process.env.HLS_TIME, 6),
    // Serve the per-user stream as an endless LIVE playlist (looped segments,
    // no seek bar, no end) instead of a finite VOD clip. `false` = plain VOD.
    liveLoop: bool(process.env.CHANNEL_LIVE_LOOP),
    // Bottom-right "next slide in N" countdown, baked in via ffmpeg drawtext.
    // Needs a font ffmpeg can resolve: fontconfig name `Inter` by default (the
    // Docker image installs fonts-inter), or set TIMER_FONT_FILE to a TTF path
    // (forward slashes) on systems without fontconfig.
    slideTimer: {
      enabled: bool(process.env.SLIDE_TIMER_ENABLED),
      fontFile: process.env.TIMER_FONT_FILE || '',
    },
  },
  intro: {
    // Animated brand intro (slide 1 -> slide 2) before the user-details card.
    enabled: bool(process.env.INTRO_ENABLED),
    // Seconds each brand slide is on screen (incl. its share of the transition).
    slideSeconds: num(process.env.INTRO_SLIDE_SECONDS, 4),
    // ffmpeg xfade transition used between the two brand slides (e.g. slideleft,
    // fade, wipeleft, dissolve, smoothleft).
    transition: process.env.INTRO_TRANSITION || 'slideleft',
  },
  statusSlide: {
    // Better Stack–style service-status frame appended to the channel loop.
    enabled: bool(process.env.STATUS_SLIDE_ENABLED),
    // Seconds the status board is held on screen each loop.
    seconds: num(process.env.STATUS_SLIDE_SECONDS, 12),
  },
  worldcupSlide: {
    // Auto-updating World Cup 2026 knockout-bracket frame appended to the loop.
    // Opt-in (off by default) so existing channels are unchanged. Like the
    // status board it is a single GLOBAL slide shared by every user.
    enabled: bool(process.env.WORLDCUP_SLIDE_ENABLED, false),
    // Seconds the bracket is held on screen each loop.
    seconds: num(process.env.WORLDCUP_SLIDE_SECONDS, 14),
  },
  footballApi: {
    // Free results feed for the World Cup slide. football-data.org by default:
    // register for a free token at https://www.football-data.org/client/register
    // and set FOOTBALL_API_TOKEN. Without a token the bracket still renders the
    // seeding skeleton (group winners / placeholders), just no live teams/scores.
    token: process.env.FOOTBALL_API_TOKEN || '',
    base: (process.env.FOOTBALL_API_BASE || 'https://api.football-data.org/v4').replace(/\/+$/, ''),
    competition: process.env.FOOTBALL_API_COMPETITION || 'WC',
    // How long a fetched bracket is cached before the next refresh re-fetches it.
    // The daily 00:05 cron forces a refresh regardless; this bounds lazy single-
    // user regenerations so they don't each hit the API.
    ttlMinutes: num(process.env.FOOTBALL_API_TTL_MINUTES, 360),
  },
  epg: {
    // XMLTV programme guide advertised via `url-tvg` in each user's .m3u. The
    // guide's now/next programmes carry the service-status headline (operational
    // / degraded / outage) plus the account's own subscription status.
    enabled: bool(process.env.EPG_ENABLED),
    // Calendar days of schedule emitted forward of / behind "today".
    daysAhead: num(process.env.EPG_DAYS_AHEAD, 7),
    daysBehind: num(process.env.EPG_DAYS_BEHIND, 1),
    // OTT-play FOSS uses its own JSON guide format. Static sources are loaded
    // directly from this server instead of going through the public matcher.
    foss: {
      enabled: bool(process.env.EPG_FOSS_ENABLED),
      providerId: process.env.EPG_FOSS_PROVIDER_ID || 'infochannel',
      upstreamMatchUrl: (process.env.EPG_FOSS_UPSTREAM_MATCH_URL || 'https://ottp.eu.org')
        .replace(/\/+$/, ''),
    },
  },
  notify: {
    // Email notification system. Customers scan the intro-slide QR to open
    // /sub/:token and subscribe with their email. Mail is sent over a third-party
    // HTTP email API (HTTPS:443) because DigitalOcean blocks outbound SMTP ports.
    // The on/off flag is also stored in Settings (admin toggle); the env var is
    // the fallback when unset, overlaid by syncNotifySettings() in channel.js.
    enabled: bool(process.env.NOTIFY_ENABLED, false),
    provider: (process.env.NOTIFY_PROVIDER || 'brevo').toLowerCase(), // brevo | resend
    apiKey: process.env.NOTIFY_API_KEY || '',
    from: process.env.NOTIFY_FROM || '',
    fromName: process.env.NOTIFY_FROM_NAME || 'IPTV Info Channel',
    // Log instead of sending — lets you test the flow locally / in Docker
    // without a real API key.
    dryRun: bool(process.env.NOTIFY_DRY_RUN, false),
  },
  expiringThresholdDays: num(process.env.EXPIRING_THRESHOLD_DAYS, 7),

  dataDir: DATA_DIR,
  hlsDir: path.join(DATA_DIR, 'hls'),
  musicFile: configuredMusicFile,
  defaultMusicFile: DEFAULT_MUSIC_FILE,
};

// Ensure runtime directories exist.
for (const dir of [config.dataDir, config.hlsDir, path.dirname(config.musicFile)]) {
  fs.mkdirSync(dir, { recursive: true });
}
