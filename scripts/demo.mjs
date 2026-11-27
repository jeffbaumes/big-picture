// Fills a demo account through the real OAuth + MCP path, so it doubles as an end-to-end test.
//   node scripts/demo.mjs [baseUrl] [handle] [password]
// Creates the account if needed (born 1988-06-14), then writes sample tracks, items and numbers.

const BASE = process.argv[2] || 'http://localhost:8787';
const HANDLE = process.argv[3] || 'demo';
const PASS = process.argv[4] || 'demo-password-1';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const post = (path, body, headers = {}) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });

// 1. Account
let r = await post('/api/signup', { handle: HANDLE, password: PASS, name: 'Demo', birth: '1988-06-14' });
if (r.status === 409) console.log('account exists'); else if (!r.ok) throw new Error('signup: ' + (await r.text())); else console.log('account created');

// 2. OAuth: register client, authorize with PKCE (the consent page accepts handle+password), exchange the code
const redirect = 'http://localhost:9/cb';
const reg = await (await post('/oauth/register', { client_name: 'demo script', redirect_uris: [redirect] })).json();
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
const form = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'x', decision: 'allow', handle: HANDLE, password: PASS });
r = await fetch(BASE + '/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
const code = new URL(r.headers.get('location')).searchParams.get('code');
const tok = await (await post('/oauth/token', { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier })).json();

let id = 1;
async function rpc(method, params) {
  const res = await post('/mcp', { jsonrpc: '2.0', id: id++, method, params }, { authorization: 'Bearer ' + tok.access_token });
  return res.json();
}
async function tool(name, args) {
  const out = await rpc('tools/call', { name, arguments: args });
  if (out.result?.isError) throw new Error(`${name}: ${out.result.content[0].text}`);
  return out.result.structuredContent;
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo', version: '1' } });
console.log('tools:', (await rpc('tools/list', {})).result.tools.map((t) => t.name).join(', '));

// 3. Data
await tool('save_track', { key: 'places', kind: 'span', name: 'Places lived', color: '#3d8f7a' });
await tool('save_items', { track: 'places', items: [
  { start: '1988-06-14', end: '1993-08-20', label: 'Madison, WI', attrs: { with: 'parents' } },
  { start: '1993-08-21', end: '2006-06-10', label: 'Minneapolis, MN', attrs: { type: 'family home' } },
  { start: '2006-08-15', end: '2010-05-20', label: 'Ann Arbor, MI', attrs: { type: 'dorm / apartments' } },
  { start: '2010-06-01', end: '2014-09-01', label: 'Chicago, IL', color: '#c2603f' },
  { start: '2014-09-02', end: '2019-03-15', label: 'Seattle, WA' },
  { start: '2019-03-16', label: 'Denver, CO', attrs: { type: 'own house' } },
] });

await tool('save_track', { key: 'school', kind: 'span', name: 'School', color: '#d98a2b' });
await tool('save_items', { track: 'school', items: [
  { start: '1993-09-01', end: '1999-06-10', label: 'Elementary' },
  { start: '1999-09-01', end: '2002-06-10', label: 'Middle school' },
  { start: '2002-09-01', end: '2006-06-10', label: 'High school' },
  { start: '2006-09-04', end: '2010-05-01', label: 'College', attrs: { degree: 'B.S. Computer Science', school: 'U. Michigan' } },
  { start: '2012-09-01', end: '2014-06-01', label: 'Grad school', attrs: { degree: 'M.S.' } },
] });

await tool('save_track', { key: 'jobs', kind: 'span', name: 'Jobs', color: '#6b57c9' });
await tool('save_items', { track: 'jobs', items: [
  { start: '2003-06-01', end: '2005-08-15', label: 'Scoop shop', attrs: { employer: 'Cold Stone', title: 'Scooper', wage: '$7.50/hr' } },
  { start: '2010-06-14', end: '2012-08-31', label: 'Analyst', attrs: { employer: 'Initech', title: 'Analyst', salary: 62000 } },
  { start: '2014-09-15', end: '2018-02-28', label: 'Engineer', attrs: { employer: 'Globex', title: 'Software Engineer', salary: 118000 } },
  { start: '2017-01-01', end: '2018-02-28', label: 'Consulting', attrs: { employer: 'Self', note: 'overlaps Globex' } },
  { start: '2018-03-15', end: '2023-10-01', label: 'Senior Eng', attrs: { employer: 'Hooli', title: 'Senior Engineer', salary: 165000 } },
  { start: '2023-11-01', label: 'Staff Eng', attrs: { employer: 'Pied Piper', title: 'Staff Engineer', salary: 210000 } },
] });

await tool('save_track', { key: 'moments', kind: 'event', name: 'Big moments', color: '#d6456b' });
await tool('save_items', { track: 'moments', items: [
  { start: '2006-06-10', label: 'Graduated high school' }, { start: '2010-05-01', label: 'Graduated college' },
  { start: '2015-07-04', label: 'Met Sam' }, { start: '2019-03-16', label: 'Bought house' },
  { start: '2021-09-18', label: 'Wedding' }, { start: '2024-02-11', label: 'First kid' },
] });
await tool('save_track', { key: 'trips', kind: 'event', name: 'Trips', color: '#2e86c1' });
await tool('save_items', { track: 'trips', items: [
  { start: '2009-03-14', label: 'Spring break, Mexico' }, { start: '2016-08-05', label: 'Japan' }, { start: '2018-06-20', label: 'Iceland' },
  { start: '2022-05-12', label: 'Portugal' }, { start: '2025-07-01', label: 'Road trip' },
] });

await tool('save_track', { key: 'weight', kind: 'series', name: 'Weight', color: '#2f7fb8', config: { unit: 'lb', min: 140, max: 220, chart: 'line', hold: 31 } });
await tool('save_track', { key: 'runs', kind: 'series', name: 'Run (miles)', color: '#e0572f', config: { unit: 'mi', min: 0, max: 8, chart: 'bars', bucket: 'month' } });

const wt = [], runs = [];
const start = Date.UTC(2008, 0, 1) / 864e5, end = Date.UTC(2026, 10, 24) / 864e5;
for (let d = start; d <= end; d += 7) {
  const date = new Date(d * 864e5).toISOString().slice(0, 10), t = (d - start) / 365;
  wt.push({ date, value: Math.round((168 + t * 1.4 + 6 * Math.sin(t * 2.1) + (Math.sin(d * 12.9898) * 2)) * 10) / 10 });
}
for (let d = Date.UTC(2016, 0, 1) / 864e5; d <= end; d++) {
  const rnd = Math.abs(Math.sin(d * 78.233)) % 1;
  if (rnd > 0.55) runs.push({ date: new Date(d * 864e5).toISOString().slice(0, 10), value: Math.round((1 + rnd * 6) * 10) / 10 });
}
for (let i = 0; i < wt.length; i += 800) await tool('save_points', { track: 'weight', points: wt.slice(i, i + 800) });
for (let i = 0; i < runs.length; i += 800) await tool('save_points', { track: 'runs', points: runs.slice(i, i + 800) });


console.log(JSON.stringify((await tool('get_timeline', {})).tracks.map((t) => [t.key, t.count, t.first, t.last])));
console.log(`Done. Sign in at ${BASE} as ${HANDLE} / ${PASS}`);
