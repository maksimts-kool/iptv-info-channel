// Public endpoints: per-user .m3u playlist + the HLS stream (.m3u8 / .ts).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { Users, Settings, Incidents } from '../db.js';
import { userHlsDir, ensureUserStream } from '../channel.js';
import { buildLivePlaylist } from '../liveloop.js';
import { buildEpgXml, epgChannelId } from '../epg.js';
import { log } from '../logger.js';

const router = express.Router();

// Only allow the playlist file and numbered segments.
const SAFE_FILE = /^(index\.m3u8|seg_\d{3,}\.ts)$/;

// Build the .m3u a player loads. token via path or query.
function m3uFor(user, settings) {
  const brand = settings.brand_name || 'Мой IPTV-сервис';
  const name = `${brand} — ${user.username}`;
  const url = `${config.publicBaseUrl}/hls/${user.token}/index.m3u8`;
  const tvgId = epgChannelId(user);
  const header = config.epg.enabled
    ? `#EXTM3U url-tvg="${config.publicBaseUrl}/u/${user.token}/epg.xml"`
    : '#EXTM3U';
  return [
    header,
    `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${name}" group-title="Аккаунт",${name}`,
    url,
    '',
  ].join('\n');
}

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

// GET /epg.xml?token=XXXX  -> XMLTV guide (advertised via url-tvg in the .m3u)
router.get('/epg.xml', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).type('text/plain').send('Missing ?token=');
  return sendEpg(req, res, token);
});

// GET /u/:token/epg.xml  (clean per-user URL)
router.get('/u/:token/epg.xml', (req, res) => sendEpg(req, res, req.params.token));

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

export default router;
