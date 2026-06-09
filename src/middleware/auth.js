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

// For HTML pages: redirect to login.
export function requireAuthPage(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect('/admin/login');
}
