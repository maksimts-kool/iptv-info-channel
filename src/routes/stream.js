// Public endpoints: per-user .m3u playlist + the HLS stream (.m3u8 / .ts).
import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { Users, Settings } from '../db.js';
import { userHlsDir, ensureUserStream } from '../channel.js';
import { buildLivePlaylist, createIntroSession } from '../liveloop.js';
import { log } from '../logger.js';

const router = express.Router();

// Only allow the playlist file and numbered segments.
const SAFE_FILE = /^(index\.m3u8|seg_\d{3,}\.ts)$/;
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000;
const entrySessions = new Map();

// Build the .m3u a player loads. token via path or query.
function m3uFor(user, settings) {
  const brand = settings.brand_name || 'Мой IPTV-сервис';
  const name = `${brand} — ${user.username}`;
  // A unique entry id lets this channel open start at the intro while normal
  // HLS playlist refreshes continue along the same infinite timeline.
  const entry = randomUUID();
  const url = `${config.publicBaseUrl}/hls/${user.token}/index.m3u8?entry=${entry}`;
  return [
    '#EXTM3U',
    `#EXTINF:-1 tvg-id="account-info" tvg-name="${name}" group-title="Аккаунт",${name}`,
    url,
    '',
  ].join('\n');
}

function sendPlaylist(req, res, token) {
  const user = Users.getByToken(token);
  if (!user) {
    log.warn('stream', 'playlist requested with unknown token');
    return res.status(404).type('text/plain').send('Unknown token');
  }
  const settings = Settings.all();
  res
    .status(200)
    .type('application/x-mpegurl')
    .set('Content-Disposition', `inline; filename="${user.username}.m3u"`)
    .send(m3uFor(user, settings));
}

// GET /playlist.m3u?token=XXXX
router.get('/playlist.m3u', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).type('text/plain').send('Missing ?token=');
  sendPlaylist(req, res, token);
});

// GET /u/:token/playlist.m3u  (clean per-user URL)
router.get('/u/:token/playlist.m3u', (req, res) => sendPlaylist(req, res, req.params.token));

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
  if (file === 'index.m3u8' && config.channel.liveLoop) {
    const now = Date.now();
    const requestedEntry = String(req.query.entry || '');
    const entry = ENTRY_ID.test(requestedEntry) ? requestedEntry : '';
    const entryKey = entry ? `${token}:${entry}` : null;
    let introSession = entryKey ? entrySessions.get(entryKey)?.session : null;

    if (entryKey && !introSession) {
      introSession = createIntroSession(dir, now);
      if (introSession) entrySessions.set(entryKey, { session: introSession, touchedAt: now });
    } else if (entryKey) {
      entrySessions.get(entryKey).touchedAt = now;
    }

    // Opportunistic cleanup keeps abandoned tune-in sessions bounded.
    for (const [key, value] of entrySessions) {
      if (now - value.touchedAt > ENTRY_TTL_MS) entrySessions.delete(key);
    }

    const playlist = buildLivePlaylist(dir, now, introSession);
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

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (file.endsWith('.m3u8')) res.type('application/vnd.apple.mpegurl');
  else res.type('video/mp2t');
  fs.createReadStream(filePath).pipe(res);
});

export default router;
