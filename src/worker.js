// Big Picture: one Worker serving /api/*, /mcp and OAuth in front of static assets. Storage is D1.
// Auth is handle + password (PBKDF2) with an HttpOnly session cookie. The page only reads; edits come through the MCP.

import { COOKIE, HANDLE_RE, now, json, fail, b64, sha256, hashPassword, cookieValue, sessionCookie, startSession, currentUser, readJSON, cleanText, validDate, today, checkLogin, UserError } from './lib.js';
import { oauth } from './oauth.js';
import { mcp } from './mcp.js';
import { manifest, trackData, profileOf } from './store.js';
import { lifeModel } from './life.js';

const OAUTH_PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/oauth/'];

const publicMe = (u) => ({ handle: u.handle, ...profileOf(u) });

async function signup(req, env) {
  const body = await readJSON(req);
  const handle = cleanText(body.handle, 20).toLowerCase();
  const name = cleanText(body.name, 40) || handle;
  const password = String(body.password || '');
  const birth = validDate(body.birth);
  if (!HANDLE_RE.test(handle)) return fail('Handles are 3 to 20 letters, numbers or underscores.');
  if (password.length < 8) return fail('Passwords need at least 8 characters.');
  if (password.length > 200) return fail('That password is too long.');
  if (!birth || birth > today() || birth < '1900-01-01') return fail('Enter your birth date.');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE handle = ?').bind(handle).first()) return fail('That handle is taken. Try another.', 409);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  const res = await env.DB.prepare('INSERT INTO users (handle, name, pw_hash, pw_salt, birth, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(handle, name, b64(hash), b64(salt), birth, now()).run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(res.meta.last_row_id).first();
  return json({ user: publicMe(user) }, 201, { 'set-cookie': await startSession(env, user.id) });
}

async function login(req, env) {
  const body = await readJSON(req);
  const r = await checkLogin(env, body.handle, body.password);
  if (r.error) return fail(r.error, r.status);
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(r.user.id, now()).run();
  return json({ user: publicMe(r.user) }, 200, { 'set-cookie': await startSession(env, r.user.id) });
}

async function logout(req, env) {
  const token = cookieValue(req, COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0), 'clear-site-data': '"cache"' });
}

/* The small "what exists and which revision is each track" document. The browser revalidates it with an ETag
   every time (a 304 costs almost nothing) and only downloads the tracks whose revision changed. */
async function manifestRoute(req, env, me) {
  const body = await manifest(env, me);
  body.life = lifeModel(body.profile.life);
  const text = JSON.stringify(body);
  const etag = `"${(await sha256(text)).slice(0, 24)}"`;
  const headers = { etag, 'cache-control': 'private, no-cache' };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(text, { headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' } });
}

/* One track's data at the revision the manifest named. The revision is in the URL (and so is the user), so a cached
   copy can never be mistaken for another version or another person's. If the revision has already moved on we
   still answer with the newest data but tell the browser not to keep it. */
async function trackRoute(env, me, uid, key, rev) {
  if (uid !== me.id) return fail('Not found.', 404);
  const data = await trackData(env, me, key);
  if (!data) return fail('Not found.', 404);
  const fresh = String(data.rev) === rev;
  return json(data, 200, { 'cache-control': fresh ? 'private, max-age=31536000, immutable' : 'no-store' });
}

async function api(req, env, url) {
  const { pathname: p } = url, m = req.method;
  if (m !== 'GET' && !(req.headers.get('content-type') || '').includes('application/json')) return fail('Send requests as JSON.', 415);
  if (p === '/api/signup' && m === 'POST') return signup(req, env);
  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/logout' && m === 'POST') return logout(req, env);

  const me = await currentUser(req, env);
  if (!me) return fail('Please sign in.', 401);

  if (p === '/api/me' && m === 'GET') return json({ user: publicMe(me) });
  if (p === '/api/manifest' && m === 'GET') return manifestRoute(req, env, me);
  let r;
  if ((r = p.match(/^\/api\/t\/(\d+)\/([a-z0-9_-]{1,32})\/(\d+)$/)) && m === 'GET') return trackRoute(env, me, Number(r[1]), r[2], r[3]);
  if (p === '/api/apps' && m === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.name, MAX(t.created_at) AS last FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
       WHERE t.user_id = ? AND t.expires_at > ? GROUP BY c.id ORDER BY last DESC LIMIT 50`
    ).bind(me.id, now()).all();
    return json({ apps: results });
  }
  if ((r = p.match(/^\/api\/apps\/([A-Za-z0-9_-]{20,60})$/)) && m === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND client_id = ?').bind(me.id, r[1]),
      env.DB.prepare('DELETE FROM oauth_codes WHERE user_id = ? AND client_id = ?').bind(me.id, r[1]),
    ]);
    return json({ ok: true });
  }
  return fail('Not found.', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/mcp' || OAUTH_PATHS.some((x) => url.pathname.startsWith(x))) {
      try {
        if (url.pathname === '/mcp' && req.method !== 'OPTIONS') return await mcp(req, env, url);
        const res = await oauth(req, env, url);
        if (res) return res;
      } catch (err) {
        console.error(err);
        return json({ error: 'server_error', error_description: 'Something went wrong. Try again.' }, 500, { 'access-control-allow-origin': '*' });
      }
      return fail('Not found.', 404);
    }
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (err) {
        if (err instanceof UserError) return fail(err.message);
        console.error(err);
        return fail('Something went wrong. Try again.', 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
