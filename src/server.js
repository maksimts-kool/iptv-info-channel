// App entry: wires up routes, serves HLS + m3u + admin, and schedules refresh.
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import streamRoutes from './routes/stream.js';
import fossEpgRoutes from './routes/foss-epg.js';
import adminRoutes from './routes/admin.js';
import subscribeRoutes from './routes/subscribe.js';
import {
  ensureMusic, generateAll, startDailyRefresh, syncWorldcupSettings, syncNotifySettings,
} from './channel.js';
import { Users, Plans } from './db.js';
import { log } from './logger.js';

const app = express();
app.disable('x-powered-by');
// Honor X-Forwarded-For only for the configured number of proxy hops, so the
// /sub rate limiter sees real client IPs behind a reverse proxy (and can't be
// spoofed when directly exposed). See config.trustProxy.
app.set('trust proxy', config.trustProxy);
app.use(cookieParser());

// Public landing page.
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8">
  <title>m3u playlist info</title>
  <body style="font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b1224;color:#e6edf7;display:grid;place-items:center;height:100vh;margin:0">
    <div style="text-align:center">
      <h1>IPTV Info Channel</h1>
      <p>Per-user account channel server is running.</p>
      <p><a style="color:#7dd3fc" href="/admin">Open admin panel →</a></p>
    </div>
  </body>`);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Admin must be mounted before stream so /admin isn't shadowed.
app.use('/admin', adminRoutes);
// Public notification sign-up page (/sub/:token), before the stream routes.
app.use('/', subscribeRoutes);
if (config.epg.enabled && config.epg.foss.enabled) app.use('/', fossEpgRoutes);
app.use('/', streamRoutes);

const server = app.listen(config.port, async () => {
  // Apply any admin-saved slide / notification overrides before the first pre-gen.
  syncWorldcupSettings();
  syncNotifySettings();
  const users = Users.all();
  const plans = Plans.all();

  log.info('startup', 'server started', {
    pid: process.pid,
    listening: `http://localhost:${config.port}`,
    admin: `${config.publicBaseUrl}/admin`,
  });
  log.info('startup', 'configuration', {
    users: users.length,
    plans: plans.length,
    resolution: `${config.channel.width}x${config.channel.height}`,
    account_card_seconds: config.channel.accountSlideSeconds,
    intro: config.intro.enabled,
    timezone: config.timezone,
    data_dir: config.dataDir,
  });

  try {
    await ensureMusic();
    await generateAll({ reason: 'startup pre-generation' });
  } catch (e) {
    log.error('startup', 'channel pre-generation issue', { error: e.message });
  }
  startDailyRefresh();
  log.info('startup', 'ready');
});

function shutdown(signal) {
  log.warn('shutdown', 'signal received; closing HTTP server', { signal });
  server.close(() => {
    log.info('shutdown', 'HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
