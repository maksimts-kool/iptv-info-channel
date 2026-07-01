// Minimal cookie session for the single admin user.
// The cookie holds an HMAC of the admin password; if the password changes,
// existing sessions are invalidated automatically.
import crypto from 'node:crypto';
import { config } from '../config.js';

export const COOKIE_NAME = 'admin_session';

export function sessionValue() {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`admin:${config.adminPassword}`)
    .digest('hex');
}

export function checkPassword(pw) {
  const a = Buffer.from(String(pw || ''));
  const b = Buffer.from(config.adminPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isAuthed(req) {
  const v = req.cookies?.[COOKIE_NAME];
  if (!v) return false;
  const expected = sessionValue();
  const a = Buffer.from(v);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function setSession(res) {
  res.cookie(COOKIE_NAME, sessionValue(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME);
}

// For JSON API routes.
export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// CSRF token for the cookie-auth admin API. Derived from the session secret +
// admin password (like the session cookie, so rotating the password rotates it),
// under a distinct label so it never equals the session value. It is handed to
// the authenticated SPA in /api/state and echoed back in an X-CSRF-Token header
// on mutating calls. A cross-site attacker can neither read it (same-origin policy
// on /api/state) nor set the custom header, so a forged cross-site request can't
// carry a valid token — even though the browser still auto-sends the cookie.
export function csrfToken() {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`csrf:${config.adminPassword}`)
    .digest('hex');
}

// Gate mutating admin API requests on a valid CSRF token. Safe (non-mutating)
// methods pass through so the SPA can GET /api/state to learn the token.
export function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const provided = Buffer.from(req.get('x-csrf-token') || '');
  const expected = Buffer.from(csrfToken());
  if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
    return next();
  }
  return res.status(403).json({ error: 'bad or missing CSRF token' });
}
