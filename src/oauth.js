// OAuth 2.1 so AI apps can use someone's account through the MCP server (/mcp).
// Dynamic client registration, authorization code with PKCE (S256), refresh-token rotation.
// Clients are public (no secret); tokens and codes are stored only as SHA-256 hashes.

import { json, now, sha256, randomToken, cookieValue, currentUser, checkLogin, startSession, cleanText, COOKIE } from './lib.js';

const CODE_MS = 5 * 60 * 1000;
const ACCESS_MS = 24 * 3600 * 1000;
const REFRESH_MS = 90 * 864e5;
export const OAUTH_PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/oauth/'];

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-expose-headers': 'www-authenticate, mcp-session-id' };
export const cors = (res) => { for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v); return res; };
const oerr = (error, description, status = 400) => cors(json({ error, error_description: description }, status));

export function authServerMeta(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['timeline'],
  };
}
export const resourceMeta = (origin) => ({
  resource: `${origin}/mcp`,
  authorization_servers: [origin],
  scopes_supported: ['timeline'],
  bearer_methods_supported: ['header'],
  resource_name: 'Big Picture',
});

/* Which user a bearer token belongs to, or null. */
export async function bearerUser(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/i);
  if (!m) return null;
  return (await env.DB.prepare(
    "SELECT u.*, t.client_id AS oauth_client FROM oauth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ?"
  ).bind(await sha256(m[1]), now()).first()) || null;
}

async function formOrJSON(req) {
  const type = req.headers.get('content-type') || '';
  const text = (await req.text()).slice(0, 16 * 1024);
  if (type.includes('application/json')) { try { return JSON.parse(text || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(text));
}

const okRedirect = (u) => {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    // Native apps may use private-use schemes like com.example.app:/callback.
    return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(url.protocol);
  } catch { return false; }
};

async function register(req, env) {
  const b = await formOrJSON(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 10) : [];
  if (!uris.length || !uris.every(okRedirect)) return oerr('invalid_redirect_uri', 'Redirect URIs must be https, a localhost http address, or an app scheme.');
  const name = cleanText(b.client_name, 60) || 'An AI app';
  const id = randomToken();
  await env.DB.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').bind(id, name, JSON.stringify(uris), now()).run();
  return cors(json({
    client_id: id, client_name: name, redirect_uris: uris, client_id_issued_at: Math.floor(now() / 1000),
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  }, 201));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${esc(title)} · Big Picture</title>
<style>
:root{--bg:#eceff3;--card:#ffffff;--ink:#1f2937;--soft:#64748b;--line:#d3dae3;--accent:#3d6fd1;--accent-ink:#fff}
@media (prefers-color-scheme: dark){:root{--bg:#12161c;--card:#1b2129;--ink:#e6ebf1;--soft:#98a4b3;--line:#2f3a46;--accent:#7aa2f0;--accent-ink:#10161d}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 ui-rounded,"SF Pro Rounded",system-ui,sans-serif}
main{max-width:400px;margin:0 auto;padding:40px 16px}
.card{background:var(--card);border:2px solid var(--line);border-radius:18px;padding:22px}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 14px;color:var(--soft)}b{color:var(--ink)}
ul{margin:0 0 18px;padding-left:20px;color:var(--soft)}li{margin:4px 0}
label{display:block;font-size:14px;font-weight:600;margin:12px 0 4px}
input{width:100%;font:inherit;font-size:16px;padding:11px 12px;border-radius:12px;border:2px solid var(--line);background:var(--bg);color:var(--ink)}
.row{display:flex;gap:10px;margin-top:20px}
button{flex:1;font:inherit;font-weight:700;padding:12px;border-radius:14px;border:2px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.go{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.err{background:#fde4e4;color:#7f1d1d;border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:14px}
.brand{font-weight:800;letter-spacing:.02em;margin-bottom:14px;color:var(--soft)}
a{color:var(--accent)}
</style></head><body><main><div class="brand">Big Picture</div><div class="card">${body}</div></main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' } });
}

async function checkRequest(env, p) {
  if (p.response_type !== 'code') return 'This app asked for an unsupported response type.';
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge || '')) return 'This app needs to use PKCE (S256).';
  const client = await env.DB.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind(p.client_id || '').first();
  if (!client) return 'This app isn’t registered. Try connecting again from the app.';
  if (!JSON.parse(client.redirect_uris).includes(p.redirect_uri)) return 'This app’s return address doesn’t match its registration.';
  return client;
}

const csrfFor = async (req) => sha256('oauth-consent|' + (cookieValue(req, COOKIE) || ''));

function consentPage(p, client, me, csrf, error) {
  const hidden = PARAMS.map((k) => p[k] != null ? `<input type="hidden" name="${k}" value="${esc(p[k])}">` : '').join('');
  const host = (() => { try { return new URL(p.redirect_uri).host; } catch { return p.redirect_uri; } })();
  const who = me
    ? `<p>Signed in as <b>@${esc(me.handle)}</b>. <a href="/oauth/authorize?${esc(new URLSearchParams({ ...Object.fromEntries(PARAMS.filter((k) => p[k] != null).map((k) => [k, p[k]])), switch: '1' }))}">Not you?</a></p>`
    : `<label for="h">Handle</label><input id="h" name="handle" autocomplete="username" autocapitalize="none" required>
       <label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required>
       <p style="margin-top:10px;font-size:14px">No account yet? <a href="/" target="_blank" rel="noopener">Make one</a>, then come back here.</p>`;
  return page('Connect an app', `
    <h1>Let ${esc(client.name)} use your account?</h1>
    <p>It will send you back to <b>${esc(host)}</b>. If you allow it, it can:</p>
    <ul><li>Read everything on your timeline</li><li>Add, change and delete tracks, items, measurements and views</li></ul>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${esc(csrf)}">
    ${who}
    <div class="row"><button name="decision" value="deny">Don’t allow</button><button class="go" name="decision" value="allow">${me ? 'Allow' : 'Sign in and allow'}</button></div>
    </form>`);
}

function back(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
}

async function authorize(req, env, url) {
  const isPost = req.method === 'POST';
  const p = isPost ? await formOrJSON(req) : Object.fromEntries(url.searchParams);
  const client = await checkRequest(env, p);
  if (typeof client === 'string') return page('Can’t connect', `<h1>Can’t connect</h1><p>${esc(client)}</p>`, 400);

  if (!isPost) {
    const me = url.searchParams.get('switch') ? null : await currentUser(req, env);
    return consentPage(p, client, me, me ? await csrfFor(req) : '', null);
  }

  if (p.decision !== 'allow') return back(p.redirect_uri, { error: 'access_denied', state: p.state });

  let me = null, setCookie = null;
  if (p.handle != null) {
    const r = await checkLogin(env, p.handle, p.password);
    if (r.error) return consentPage(p, client, null, '', r.error);
    me = r.user; setCookie = await startSession(env, me.id);
  } else {
    me = await currentUser(req, env);
    if (!me || p.csrf !== await csrfFor(req)) return consentPage(p, client, null, '', 'Please sign in to continue.');
  }

  const code = randomToken();
  await env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now()).run();
  await env.DB.prepare('INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256(code), client.id, me.id, p.redirect_uri, p.code_challenge, now() + CODE_MS).run();
  const res = back(p.redirect_uri, { code, state: p.state, iss: url.origin });
  if (setCookie) res.headers.append('set-cookie', setCookie);
  return res;
}

async function s256(verifier) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function issue(env, clientId, userId) {
  const access = randomToken(), refresh = randomToken(), t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND expires_at < ?').bind(userId, t),
    env.DB.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at, created_at) VALUES (?, 'access', ?, ?, ?, ?)").bind(await sha256(access), clientId, userId, t + ACCESS_MS, t),
    env.DB.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at, created_at) VALUES (?, 'refresh', ?, ?, ?, ?)").bind(await sha256(refresh), clientId, userId, t + REFRESH_MS, t),
  ]);
  return cors(json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: 'timeline' }));
}

async function token(req, env) {
  const b = await formOrJSON(req);
  if (b.grant_type === 'authorization_code') {
    const row = await env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(await sha256(String(b.code || ''))).first();
    if (row) await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').bind(row.code_hash).run();
    if (!row || row.expires_at < now()) return oerr('invalid_grant', 'That code has expired or was already used.');
    if (b.client_id && b.client_id !== row.client_id) return oerr('invalid_grant', 'That code belongs to a different app.');
    if (b.redirect_uri && b.redirect_uri !== row.redirect_uri) return oerr('invalid_grant', 'The return address doesn’t match.');
    if (!b.code_verifier || (await s256(String(b.code_verifier))) !== row.challenge) return oerr('invalid_grant', 'The PKCE verifier doesn’t match.');
    return issue(env, row.client_id, row.user_id);
  }
  if (b.grant_type === 'refresh_token') {
    const hash = await sha256(String(b.refresh_token || ''));
    const row = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").bind(hash).first();
    if (!row || row.expires_at < now()) return oerr('invalid_grant', 'That refresh token has expired. Connect again.');
    if (b.client_id && b.client_id !== row.client_id) return oerr('invalid_grant', 'That token belongs to a different app.');
    await env.DB.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').bind(hash).run();
    return issue(env, row.client_id, row.user_id);
  }
  return oerr('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

async function revoke(req, env) {
  const b = await formOrJSON(req);
  if (b.token) await env.DB.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').bind(await sha256(String(b.token))).run();
  return cors(new Response(null, { status: 200 }));
}

/* Handles the OAuth and discovery routes. Returns null for anything else. */
export async function oauth(req, env, url) {
  const p = url.pathname, m = req.method, origin = url.origin;
  if (m === 'OPTIONS' && (p.startsWith('/.well-known/') || p.startsWith('/oauth/') || p === '/mcp')) return cors(new Response(null, { status: 204 }));
  if (p.startsWith('/.well-known/oauth-authorization-server')) return cors(json(authServerMeta(origin)));
  if (p.startsWith('/.well-known/oauth-protected-resource')) return cors(json(resourceMeta(origin)));
  if (p === '/oauth/register' && m === 'POST') return register(req, env);
  if (p === '/oauth/authorize' && (m === 'GET' || m === 'POST')) return authorize(req, env, url);
  if (p === '/oauth/token' && m === 'POST') return token(req, env);
  if (p === '/oauth/revoke' && m === 'POST') return revoke(req, env);
  return null;
}
