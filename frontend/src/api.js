// Thin fetch wrapper for /admin/api. Sends the session cookie (credentials:
// 'include') and, on mutating requests, the X-CSRF-Token header carrying the
// token learned from GET /api/state. A 401 throws AuthError so the app can drop
// back to the login view.

export class AuthError extends Error {}

let csrf = '';
export function setCsrfToken(token) {
  csrf = token || '';
}

async function request(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('unauthorized');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};

// Login/logout live outside /admin/api (no CSRF: login is the auth bootstrap).
export async function login(password) {
  const res = await fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Неверный пароль');
  }
  return true;
}

export async function logout() {
  await fetch('/admin/logout', { method: 'POST', credentials: 'include' });
}
