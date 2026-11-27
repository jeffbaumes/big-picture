// Derives a daily weight-change series from a weight series already on your account.
//
//   node scripts/derive-weight-delta.mjs [options]
//
// Weigh-ins are joined by straight lines, so every day between two readings gets an interpolated weight, and each
// day's value is that day's weight minus the day before's (positive = gained). Across a gap every day therefore
// carries the same value: the average rate of change over the gap. The series starts the day after the first reading
// and ends on the last reading.
//
// It signs in (handle and password, or BP_HANDLE / BP_PASSWORD) because the readings live on your account.
// Default is a summary only; add --upload to save the series.
//
// Options
//   --source key     the weight series to read (default weight-measured)
//   --key key        the series to write (default weight-delta; if it exists it keeps its settings, only points are written)
//   --max-gap days   don't fill across gaps longer than this many days (default: fill every gap)
//   --upload         save the points
//   --url <base>     default https://bigpicture.io27.com
//   --out file.json  also write the source readings and derived points to a file

import fs from 'node:fs';
import readline from 'node:readline';

const opt = { source: 'weight-measured', key: 'weight-delta', maxGap: Infinity, upload: false, url: 'https://bigpicture.io27.com', out: null };
{
  const a = process.argv.slice(2), die = (m) => { console.error(m); process.exit(2); };
  for (let i = 0; i < a.length; i++) {
    const f = a[i], val = () => (i + 1 < a.length ? a[++i] : die(`${f} needs a value`));
    if (f === '--source') opt.source = val();
    else if (f === '--key') opt.key = val();
    else if (f === '--max-gap') { opt.maxGap = Number(val()); if (!(opt.maxGap >= 1)) die('--max-gap is a number of days, 1 or more'); }
    else if (f === '--upload') opt.upload = true;
    else if (f === '--url') opt.url = val().replace(/\/+$/, '');
    else if (f === '--out') opt.out = val();
    else die(`Unknown option ${f}`);
  }
}

const POINT_CAP = 80000, PER_CALL = 1000, MS = 864e5;   // LIMITS in src/store.js
const dn = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / MS;
const ds = (n) => new Date(n * MS).toISOString().slice(0, 10);

/* ---------- sign in (same OAuth + MCP path as the other scripts) ---------- */
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const post = (p, body, headers = {}) => fetch(opt.url + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
function askHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    const on = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); return resolve(s); }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    stdin.on('data', on);
  });
}
async function ask(q) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const a = await new Promise((r) => rl.question(q, r)); rl.close(); return a.trim(); }

let handle = process.env.BP_HANDLE, password = process.env.BP_PASSWORD;
if (!handle || !password) {
  if (!process.stdin.isTTY) { console.error('Set BP_HANDLE and BP_PASSWORD, or run this in a terminal so it can ask.'); process.exit(1); }
  console.log(`Sign in to ${opt.url} (the password goes only to that site).`);
  if (!handle) handle = await ask('Handle: ');
  if (!password) password = await askHidden('Password: ');
}
const redirect = 'http://localhost:9/cb';
const reg = await (await post('/oauth/register', { client_name: 'weight delta', redirect_uris: [redirect] })).json();
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
const form = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'x', decision: 'allow', handle, password });
const auth = await fetch(opt.url + '/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
const loc = auth.headers.get('location');
const code = loc && new URL(loc, opt.url).searchParams.get('code');
if (!code) { console.error(`Sign-in failed (HTTP ${auth.status}). Check the handle and password.`); process.exit(1); }
const tok = await (await post('/oauth/token', { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier })).json();
if (!tok.access_token) { console.error('Could not get a token: ' + JSON.stringify(tok)); process.exit(1); }
let rid = 1;
const rpc = async (method, params) => (await post('/mcp', { jsonrpc: '2.0', id: rid++, method, params }, { authorization: 'Bearer ' + tok.access_token })).json();
const tool = async (name, args) => {
  const out = await rpc('tools/call', { name, arguments: args });
  if (out.error) throw new Error(`${name}: ${out.error.message}`);
  if (out.result?.isError) throw new Error(`${name}: ${out.result.content[0].text}`);
  return out.result.structuredContent;
};
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'weight-delta', version: '1' } });

/* ---------- read the weigh-ins (paged) ---------- */
const tl = await tool('get_timeline', {});
const src = tl.tracks.find((t) => t.key === opt.source);
if (!src || src.kind !== 'series') { console.error(`No number series "${opt.source}". Series on this account: ${tl.tracks.filter((t) => t.kind === 'series').map((t) => t.key).join(', ')}`); process.exit(1); }
const readings = [];
for (let from; ;) {
  const { points } = await tool('list_points', { track: opt.source, ...(from ? { from } : {}), limit: 2000 });
  readings.push(...points);
  if (points.length < 2000) break;
  from = ds(dn(points[points.length - 1][0]) + 1);
}
readings.sort((a, b) => (a[0] < b[0] ? -1 : 1));
if (readings.length < 2) { console.error(`${opt.source} needs at least two readings.`); process.exit(1); }

/* ---------- interpolate and difference ---------- */
// Between readings (d0, w0) and (d1, w1) the weight on day d is w0 + (w1 - w0) * (d - d0) / (d1 - d0), so every day
// from d0+1 to d1 changes by (w1 - w0) / (d1 - d0).
const points = [];
let filled = 0, skipped = 0, longest = 0;
for (let i = 1; i < readings.length; i++) {
  const d0 = dn(readings[i - 1][0]), d1 = dn(readings[i][0]), gap = d1 - d0, step = (readings[i][1] - readings[i - 1][1]) / gap;
  if (gap > opt.maxGap) { skipped++; continue; }
  if (gap > 1) { filled += gap - 1; longest = Math.max(longest, gap); }
  const v = Math.round(step * 1000) / 1000;
  for (let d = d0 + 1; d <= d1; d++) points.push({ date: ds(d), value: v });
}
const unit = src.config?.unit || 'lb';
console.log(`\nRead ${readings.length} readings from "${opt.source}" (${readings[0][0]} to ${readings[readings.length - 1][0]}).`);
console.log(`Derived ${points.length.toLocaleString()} daily changes (${points.length - filled} on days with a reading, ${filled.toLocaleString()} interpolated across gaps; longest gap ${longest} days).`);
if (skipped) console.log(`Left ${skipped} gap${skipped > 1 ? 's' : ''} longer than ${opt.maxGap} days unfilled.`);
if (!points.length) { console.log('Nothing to save.'); process.exit(0); }
const vals = points.map((p) => p.value);
console.log(`Daily change ${unit}/day: min ${Math.min(...vals)}, max ${Math.max(...vals)}, mean ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)}`);
if (opt.out) { fs.writeFileSync(opt.out, JSON.stringify({ readings, points })); console.log(`Wrote ${opt.out}`); }
if (!opt.upload) { console.log(`\nSummary only: nothing was saved. Add --upload to save it as "${opt.key}".`); process.exit(0); }

/* ---------- save ---------- */
const existing = tl.tracks.find((t) => t.key === opt.key);
const used = tl.tracks.filter((t) => t.kind === 'series').reduce((n, t) => n + (t.count || 0), 0);
const projected = used - Math.min(existing?.count || 0, points.length) + points.length;
console.log(`\nPoint budget: ${used.toLocaleString()} used now, about ${projected.toLocaleString()} after this, cap ${POINT_CAP.toLocaleString()}.`);
if (projected > POINT_CAP) { console.error('That would go over the cap. Use --max-gap to fill fewer gaps.'); process.exit(1); }
if (existing) console.log(`"${opt.key}" already exists: keeping its settings, writing points.`);
else {
  await tool('save_track', {
    key: opt.key, kind: 'series', name: 'Weight change per day', color: '#2d8f9b',
    config: {
      unit: `${unit}/day`, chart: 'line', agg: 'avg',
      note: `Day-over-day change in ${src.name || opt.source} (positive = gained), derived from the weigh-ins by joining them with straight lines. Days without a weigh-in are INTERPOLATED, so across a gap every day carries the same value: the average rate of change over that gap${opt.maxGap < Infinity ? ` (gaps longer than ${opt.maxGap} days are left empty)` : ' (every gap is filled, even the multi-year ones, so long gaps show as one flat stretch)'}. Re-run scripts/derive-weight-delta.mjs after adding weigh-ins.`,
    },
  });
}
for (let i = 0; i < points.length; i += PER_CALL) {
  await tool('save_points', { track: opt.key, points: points.slice(i, i + PER_CALL), mode: 'set' });
  process.stdout.write(`  ${Math.min(i + PER_CALL, points.length)}/${points.length}\r`);
}
console.log(`  ${points.length} points saved to "${opt.key}"      \nDone. Refresh the page.`);
