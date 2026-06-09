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
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();
process.env.TZ ||= 'Europe/Tallinn';

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

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
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${num(process.env.PORT, 9222)}`).replace(/\/+$/, ''),

  adminPassword: process.env.ADMIN_PASSWORD || 'changeme',
  sessionSecret: process.env.SESSION_SECRET || 'please-change-this-to-a-long-random-string',

  channel: {
    duration: num(process.env.CHANNEL_DURATION, 120),
    width: num(process.env.CHANNEL_WIDTH, 1920),
    height: num(process.env.CHANNEL_HEIGHT, 1080),
    // Serve the per-user stream as an endless LIVE playlist (looped segments,
    // no seek bar, no end) instead of a finite VOD clip. `false` = plain VOD.
    liveLoop: (process.env.CHANNEL_LIVE_LOOP ?? 'true').toLowerCase() !== 'false',
  },
  intro: {
    // Animated brand intro (slide 1 -> slide 2) before the user-details card.
    enabled: (process.env.INTRO_ENABLED ?? 'true').toLowerCase() !== 'false',
    // Seconds each brand slide is on screen (incl. its share of the transition).
    slideSeconds: num(process.env.INTRO_SLIDE_SECONDS, 4),
    // ffmpeg xfade transition used between the two brand slides (e.g. slideleft,
    // fade, wipeleft, dissolve, smoothleft).
    transition: process.env.INTRO_TRANSITION || 'slideleft',
  },
  expiringThresholdDays: num(process.env.EXPIRING_THRESHOLD_DAYS, 7),

  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'app.db'),
  hlsDir: path.join(DATA_DIR, 'hls'),
  musicFile: configuredMusicFile,
  defaultMusicFile: DEFAULT_MUSIC_FILE,
};

// Ensure runtime directories exist.
for (const dir of [config.dataDir, config.hlsDir, path.dirname(config.musicFile)]) {
  fs.mkdirSync(dir, { recursive: true });
}
