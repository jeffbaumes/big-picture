// Shared helpers: responses, hashing, sessions, sign-in, validation.

const COOKIE = 'bp_s';
const SESSION_DAYS = 60;
// PBKDF2 cost is limited by the Workers free plan's per-request CPU budget.
const PBKDF2_ITER = 25000;
const MAX_FAILS = 5, LOCK_MS = 5 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/i;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const enc = new TextEncoder();
const now = () => Date.now();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}
const fail = (message, status = 400) => json({ error: message }, status);

/* Errors whose message is safe to show the person. */
class UserError extends Error {}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return new Uint8Array(bits);
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function cookieValue(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));

async function startSession(env, userId) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, now() + SESSION_DAYS * 864e5).run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}
async function currentUser(req, env) {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  ).bind(await sha256(token), now()).first();
  return row || null;
}

async function readJSON(req, maxBytes = 64 * 1024) {
  const text = await req.text();
  if (text.length > maxBytes) throw new UserError('Request is too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new UserError('Request body is not valid JSON.'); }
}
function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

/* A real calendar date like 1990-04-23, or null. */
function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
}
const today = () => new Date().toISOString().slice(0, 10);

/* Checks a handle and password, with a short lockout after repeated misses. Returns {user} or {error, status}. */
async function checkLogin(env, handleIn, passwordIn) {
  const handle = cleanText(handleIn, 20).toLowerCase();
  const password = String(passwordIn || '').slice(0, 200);
  const user = await env.DB.prepare('SELECT * FROM users WHERE handle = ?').bind(handle).first();
  const wrong = { error: 'That handle and password don’t match.', status: 401 };
  if (!user) { await hashPassword(password, new Uint8Array(16)); return wrong; }
  if (user.locked_until > now()) return { error: 'Too many tries. Wait a few minutes and try again.', status: 429 };
  const hash = await hashPassword(password, unb64(user.pw_salt));
  if (!sameBytes(hash, unb64(user.pw_hash))) {
    const fails = user.fail_count + 1;
    await env.DB.prepare('UPDATE users SET fail_count = ?, locked_until = ? WHERE id = ?')
      .bind(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? now() + LOCK_MS : 0, user.id).run();
    return wrong;
  }
  await env.DB.prepare('UPDATE users SET fail_count = 0, locked_until = 0 WHERE id = ?').bind(user.id).run();
  return { user };
}

export { COOKIE, SESSION_DAYS, DATE_RE, HANDLE_RE, KEY_RE, COLOR_RE, enc, now, json, fail, UserError, b64, unb64, sha256, hashPassword, sameBytes, cookieValue, sessionCookie, startSession, currentUser, readJSON, cleanText, validDate, today, checkLogin };
