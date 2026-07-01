// Public, token-scoped notification sign-up. Reached from the intro-slide QR at
// /sub/:token. The token is the customer's existing private secret (same one
// that gates their stream), so it is the only credential — there is no login.
// One subscription per user. Mounted before the stream routes in server.js.
import express from 'express';
import { Users, Subscribers, Settings } from '../db.js';
import { validateSubscription, sendVerification, sendConfirmation } from '../notify.js';
import { log } from '../logger.js';

const router = express.Router();

// In-memory sliding-window rate limit for the write endpoints. The POST sends a
// confirmation email to whatever address is typed, so without this it could be
// abused as a spam relay. Keyed per-IP and per-token.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 5;
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > MAX_HITS;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) {
    const live = arr.filter((t) => now - t < WINDOW_MS);
    if (live.length) hits.set(k, live); else hits.delete(k);
  }
}, WINDOW_MS).unref();

function userFromToken(req, res) {
  const user = Users.getByNotifyToken(req.params.token);
  if (!user) { res.status(404).json({ error: 'not found' }); return null; }
  return user;
}

router.get('/sub/:token', (req, res) => {
  if (!Users.getByNotifyToken(req.params.token)) {
    return res.status(404).type('html').send(notFoundPage());
  }
  // The token is embedded as a JS string literal (charset is URL-safe); the page
  // otherwise renders all state via textContent, so no value is reflected as HTML.
  res.type('html').send(subscribePage(req.params.token));
});

router.get('/sub/:token/status', (req, res) => {
  const user = userFromToken(req, res);
  if (!user) return;
  const sub = Subscribers.byUser(user.id);
  res.json({
    brand: Settings.all().brand_name || 'IPTV-сервис',
    subscribed: !!sub,
    verified: !!sub?.verified,
    email: sub?.email || '',
    options: sub?.options || { server: false, expiry: true, renewal: true },
  });
});

router.post('/sub/:token', express.json(), async (req, res) => {
  const user = userFromToken(req, res);
  if (!user) return;
  if (rateLimited(`ip:${req.ip}`) || rateLimited(`uid:${user.id}`)) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
  }
  const { error, value } = validateSubscription(req.body || {});
  if (error) return res.status(400).json({ error });
  const sub = Subscribers.upsert(user.id, value);
  log.info('subscribe', 'subscription saved', { user_id: user.id, verified: sub.verified });
  // Double opt-in: an unverified address (new or just changed) gets a
  // verification link and no real notifications until it's confirmed. A pure
  // options change on an already-verified address sends nothing.
  if (!sub.verified) {
    await sendVerification(user, sub);
    return res.json({ ok: true, message: 'Мы отправили письмо со ссылкой для подтверждения адреса. Уведомления начнут приходить после подтверждения.' });
  }
  res.json({ ok: true, message: 'Настройки подписки сохранены.' });
});

// Double opt-in landing: the link from the verification email. A separate
// single-use token, distinct from the notify token.
router.get('/sub/verify/:vtoken', (req, res) => {
  const sub = Subscribers.verifyByToken(req.params.vtoken);
  if (!sub) return res.status(404).type('html').send(resultPage('Ссылка недействительна или уже использована.'));
  const user = Users.get(sub.user_id);
  const verified = Subscribers.markVerified(sub.user_id);
  log.info('subscribe', 'email verified', { user_id: sub.user_id });
  if (user) sendConfirmation(user, verified); // best-effort "you're subscribed" mail
  res.type('html').send(resultPage('Адрес подтверждён. Подписка активна — теперь вы будете получать уведомления.'));
});

router.post('/sub/:token/unsubscribe', express.json(), (req, res) => {
  const user = userFromToken(req, res);
  if (!user) return;
  if (rateLimited(`uid:${user.id}`)) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
  }
  Subscribers.remove(user.id);
  log.info('subscribe', 'unsubscribed', { user_id: user.id });
  res.json({ ok: true, message: 'Вы отписались от уведомлений.' });
});

function notFoundPage() {
  return resultPage('Ссылка недействительна.');
}

// Minimal centered message page (verification result / errors). The message is
// fixed server-side text, never user input.
function resultPage(message) {
  return `<!doctype html><meta charset="utf-8"><title>Уведомления</title>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1224;color:#e6edf7;display:grid;place-items:center;height:100vh;margin:0;padding:20px;text-align:center">
    <div style="max-width:420px;background:#0f1830;border:1px solid #24345f;border-radius:18px;padding:28px">
      <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#7dd3fc">Уведомления</div>
      <p style="font-size:17px;line-height:1.5;margin:14px 0 0">${message}</p>
    </div></body>`;
}

// Self-contained sign-up page: dark theme matching the channel, fetches its own
// state and renders everything client-side via textContent (no HTML injection).
function subscribePage(token) {
  return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Уведомления</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b1224;color:#e6edf7;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{width:100%;max-width:440px;background:#0f1830;border:1px solid #24345f;border-radius:18px;padding:26px}
  .kicker{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7dd3fc}
  h1{font-size:23px;margin:8px 0 4px}
  .muted{color:#9fb3d1;font-size:14px;line-height:1.5}
  label.field{display:block;margin:18px 0 6px;font-size:14px;color:#c7d5eb}
  input[type=email]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #2b3d68;background:#0b1224;color:#fff;font-size:16px}
  .opt{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid #2b3d68;border-radius:10px;margin-top:10px}
  .opt input{margin-top:3px;width:18px;height:18px}
  .opt .t{font-size:14px}
  .opt .t small{display:block;color:#9fb3d1;margin-top:2px}
  .opt.locked{opacity:.85}
  button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer}
  .primary{background:#38bdf8;color:#06243a}
  .ghost{background:transparent;color:#9fb3d1;border:1px solid #2b3d68;margin-top:10px}
  .note{margin-top:14px;padding:12px;border-radius:10px;font-size:14px;display:none}
  .note.ok{display:block;background:#0c2a1c;border:1px solid #16a34a;color:#86efac}
  .note.err{display:block;background:#2a0f12;border:1px solid #dc2626;color:#fca5a5}
  .badge{display:inline-block;margin-top:8px;padding:4px 10px;border-radius:999px;background:#16a34a;color:#04140c;font-size:12px;font-weight:700}
  .badge.pending{background:#d97706;color:#1a1206}
</style></head>
<body>
  <div class="card">
    <div class="kicker" id="brand">…</div>
    <h1>Уведомления по почте</h1>
    <p class="muted" id="lead">Подпишитесь, чтобы получать важные письма о вашей подписке.</p>
    <span class="badge" id="subbed" style="display:none">Вы уже подписаны</span>

    <label class="field" for="email">Электронная почта</label>
    <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com">

    <div class="opt locked">
      <input id="o-renewal" type="checkbox" checked disabled>
      <div class="t">Продление подписки<small>Обязательно — придёт, когда продлят срок действия</small></div>
    </div>
    <div class="opt">
      <input id="o-expiry" type="checkbox" checked>
      <div class="t">Подписка скоро истекает<small>Напомним заранее, чтобы вы успели продлить</small></div>
    </div>
    <div class="opt">
      <input id="o-server" type="checkbox">
      <div class="t">Статус сервера<small>Сообщим о сбоях и восстановлении сервиса</small></div>
    </div>

    <button class="primary" id="save">Подписаться</button>
    <button class="ghost" id="unsub" style="display:none">Отписаться</button>
    <div class="note" id="note"></div>
  </div>
<script>
const TOKEN = ${JSON.stringify(token)};
const base = '/sub/' + encodeURIComponent(TOKEN);
const $ = (id) => document.getElementById(id);
function note(msg, ok){ const n=$('note'); n.textContent=msg; n.className='note '+(ok?'ok':'err'); }
async function call(method, path, body){
  const r = await fetch(base+path, {method, headers: body?{'Content-Type':'application/json'}:undefined, body: body?JSON.stringify(body):undefined});
  const d = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||'Ошибка');
  return d;
}
function paint(s){
  $('brand').textContent = s.brand;
  const badge = $('subbed');
  badge.style.display = s.subscribed ? 'inline-block' : 'none';
  badge.classList.toggle('pending', s.subscribed && !s.verified);
  badge.textContent = s.subscribed
    ? (s.verified ? 'Вы подписаны' : 'Ожидает подтверждения по e-mail')
    : '';
  $('unsub').style.display = s.subscribed ? 'block' : 'none';
  $('save').textContent = s.subscribed
    ? (s.verified ? 'Сохранить изменения' : 'Отправить письмо повторно')
    : 'Подписаться';
  if(s.email) $('email').value = s.email;
  $('o-expiry').checked = s.options.expiry;
  $('o-server').checked = s.options.server;
}
async function refresh(){ try{ paint(await call('GET','/status')); }catch(e){ note(e.message,false);} }
$('save').onclick = async () => {
  const email = $('email').value.trim();
  if(!email){ note('Введите адрес электронной почты', false); return; }
  $('save').disabled = true;
  try{
    const d = await call('POST','',{ email, options:{ expiry:$('o-expiry').checked, server:$('o-server').checked } });
    note(d.message, true); await refresh();
  }catch(e){ note(e.message,false); } finally { $('save').disabled=false; }
};
$('unsub').onclick = async () => {
  $('unsub').disabled = true;
  try{ const d = await call('POST','/unsubscribe'); note(d.message,true); await refresh(); }
  catch(e){ note(e.message,false); } finally { $('unsub').disabled=false; }
};
refresh();
</script>
</body></html>`;
}

export default router;
