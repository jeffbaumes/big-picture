// Apple Health export -> Big Picture series tracks (one number per day).
//
//   node scripts/import-apple-health.mjs <export.zip | export.xml> [options]
//
// Default is a DRY RUN: it reads the export, prints what it found and what it would save.
// Add --upload to save it through the same OAuth + MCP path the AI apps use.
//
// Options
//   --metrics a,b,c     sleep,steps,weight,restinghr,hrv,activeenergy,o2,respiratory (default) | all | any of:
//                       sleep steps weight restinghr hrv activeenergy o2 respiratory exercise distance flights vo2max bodyfat workouts
//                       (o2 and respiratory use only overnight readings, 22:00-08:00, dated the morning you wake)
//   --since YYYY-MM-DD  ignore anything before this date
//   --upload            save to Big Picture (asks for handle and password, or reads BP_HANDLE / BP_PASSWORD)
//   --url <base>        default https://bigpicture.io27.com
//   --out file.json     also write everything it would save to a JSON file
//   --sleep-source txt  only use sleep records whose source name contains txt (e.g. "Watch")
//   --min-sleep 2       a night needs at least this many hours asleep to count
//   --gap 3             hours awake that split two sleeps (a nap vs. the night)
//   --weight-unit lb    lb (default, matches the existing Weight track) or kg
//   --weight-track key  where weight goes (default weight-measured, the existing Weight track; a track that already
//                       exists keeps its name, colour and settings, and only gets the readings added or updated)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const POINT_CAP = 80000; // LIMITS.points in src/store.js (soft cap, checked per save_points call)
const PER_CALL = 1000;   // LIMITS.pointsPerCall

/* ---------- options ---------- */
const opt = { metrics: 'sleep,steps,weight,restinghr,hrv,activeenergy,o2,respiratory', since: null, upload: false, url: 'https://bigpicture.io27.com', out: null, sleepSource: null, minSleep: 2, gap: 3, weightUnit: 'lb', weightTrack: 'weight-measured' };
let file = null;
{
  const a = process.argv.slice(2);
  const die = (m) => { console.error(m); process.exit(2); };
  for (let i = 0; i < a.length; i++) {
    const f = a[i], val = () => (i + 1 < a.length ? a[++i] : die(`${f} needs a value`));
    if (f === '--metrics') opt.metrics = val();
    else if (f === '--since') opt.since = val();
    else if (f === '--upload') opt.upload = true;
    else if (f === '--url') opt.url = val().replace(/\/+$/, '');
    else if (f === '--out') opt.out = val();
    else if (f === '--sleep-source') opt.sleepSource = val().toLowerCase();
    else if (f === '--min-sleep') opt.minSleep = Number(val());
    else if (f === '--gap') opt.gap = Number(val());
    else if (f === '--weight-unit') opt.weightUnit = val();
    else if (f === '--weight-track') opt.weightTrack = val();
    else if (f.startsWith('--')) die(`Unknown option ${f}`);
    else file = f;
  }
  if (!file) die('Usage: node scripts/import-apple-health.mjs <export.zip | export.xml> [--upload] [--metrics ...]  (see the top of the script)');
  if (opt.since && !/^\d{4}-\d\d-\d\d$/.test(opt.since)) die('--since is a date like 2020-01-31');
  if (!['lb', 'kg'].includes(opt.weightUnit)) die('--weight-unit is lb or kg');
  if (!Number.isFinite(opt.minSleep) || !Number.isFinite(opt.gap)) die('--min-sleep and --gap are numbers of hours');
}

/* ---------- what to import ---------- */
const Q = (s) => 'HKQuantityTypeIdentifier' + s;
// mode "sum": daily total, with the per-source totals compared so iPhone + Watch don't double count.
// mode "avg": mean of the day's readings.
const METRICS = {
  steps:        { mode: 'sum', type: Q('StepCount'),             key: 'steps',         name: 'Steps',                      color: '#2a9d8f', config: { unit: 'steps', chart: 'bars', agg: 'sum' }, digits: 0 },
  activeenergy: { mode: 'sum', type: Q('ActiveEnergyBurned'),    key: 'active-energy', name: 'Active energy',              color: '#e76f51', config: { chart: 'bars', agg: 'sum' }, digits: 0, unitFromData: true },
  exercise:     { mode: 'sum', type: Q('AppleExerciseTime'),     key: 'exercise',      name: 'Exercise minutes',           color: '#f4a261', config: { unit: 'min', chart: 'bars', agg: 'sum' }, digits: 0 },
  distance:     { mode: 'sum', type: Q('DistanceWalkingRunning'), key: 'distance',      name: 'Walking + running distance', color: '#4d908e', config: { chart: 'bars', agg: 'sum' }, digits: 2, unitFromData: true },
  flights:      { mode: 'sum', type: Q('FlightsClimbed'),        key: 'flights',       name: 'Flights climbed',            color: '#7a5cc2', config: { unit: 'flights', chart: 'bars', agg: 'sum' }, digits: 0 },
  workouts:     { mode: 'sum', type: 'Workout',                   key: 'workout-min',   name: 'Workout minutes',            color: '#c2603f', config: { unit: 'min', chart: 'bars', agg: 'sum' }, digits: 0 },
  weight:       { mode: 'avg', type: Q('BodyMass'),              key: opt.weightTrack, name: 'Weight (Apple Health)',     color: '#1d6fd1', config: { unit: opt.weightUnit, chart: 'line', agg: 'avg', hold: 31 }, digits: 1, weight: true },
  bodyfat:      { mode: 'avg', type: Q('BodyFatPercentage'),     key: 'body-fat',      name: 'Body fat',                   color: '#b5651d', config: { unit: '%', chart: 'line', agg: 'avg', hold: 31 }, digits: 1, scale: 100 },
  restinghr:    { mode: 'avg', type: Q('RestingHeartRate'),      key: 'resting-hr',    name: 'Resting heart rate',         color: '#d6456b', config: { unit: 'bpm', chart: 'line', agg: 'avg' }, digits: 0 },
  hrv:          { mode: 'avg', type: Q('HeartRateVariabilitySDNN'), key: 'hrv',        name: 'Heart rate variability',     color: '#9b5de5', config: { unit: 'ms', chart: 'line', agg: 'avg' }, digits: 1 },
  o2:           { mode: 'avg', type: Q('OxygenSaturation'),      key: 'o2',            name: 'Blood oxygen (overnight)',   color: '#2f8fbf', config: { unit: '%', chart: 'line', agg: 'avg' }, digits: 1, scale: 100, night: true },
  respiratory:  { mode: 'avg', type: Q('RespiratoryRate'),        key: 'respiratory',   name: 'Respiratory rate (overnight)', color: '#6aa84f', config: { unit: 'breaths/min', chart: 'line', agg: 'avg' }, digits: 1, night: true },
  vo2max:       { mode: 'avg', type: Q('VO2Max'),                key: 'vo2max',        name: 'VO2 max',                    color: '#2b9348', config: { unit: 'mL/kg/min', chart: 'line', agg: 'avg', hold: 31 }, digits: 1 },
};
const ALL = ['sleep', ...Object.keys(METRICS)];
const wanted = opt.metrics === 'all' ? ALL : opt.metrics.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
for (const m of wanted) if (!ALL.includes(m)) { console.error(`Unknown metric "${m}". Choose from: ${ALL.join(', ')}`); process.exit(2); }
const SLEEP_TYPE = 'HKCategoryTypeIdentifierSleepAnalysis';
const byType = new Map(Object.entries(METRICS).filter(([m]) => wanted.includes(m)).map(([m, d]) => [d.type, { m, ...d }]));

/* ---------- reading the export ---------- */
function openLines(p) {
  let input;
  if (/\.zip$/i.test(p)) {
    // `*export.xml` matches apple_health_export/export.xml but not export_cda.xml
    const unzip = spawn('unzip', ['-p', path.resolve(p), '*export.xml'], { stdio: ['ignore', 'pipe', 'inherit'] });
    unzip.on('error', () => { console.error('Could not run `unzip`. Unzip the export yourself and pass the export.xml inside it.'); process.exit(1); });
    input = unzip.stdout;
  } else input = fs.createReadStream(p);
  input.on('error', (e) => { console.error(`Cannot read ${p}: ${e.message}`); process.exit(1); });
  return readline.createInterface({ input, crlfDelay: Infinity });
}

const RECORD = /^\s*<Record type="([^"]+)"/;
const WORKOUT = /^\s*<Workout /;
const ATTR = /([A-Za-z]+)="([^"]*)"/g;
const attrs = (line) => { const o = {}; let m; ATTR.lastIndex = 0; while ((m = ATTR.exec(line))) o[m[1]] = m[2]; return o; };
const unent = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// "2024-03-05 23:12:44 -0600" -> epoch ms
const epoch = (s) => Date.parse(`${s.slice(0, 10)}T${s.slice(11, 19)}${s.slice(20, 23)}:${s.slice(23, 25)}`);
const hourOf = (s) => +s.slice(11, 13) + +s.slice(14, 16) / 60 + +s.slice(17, 19) / 3600;
const dayNum = (d) => Date.parse(d + 'T00:00:00Z') / 864e5;
const round = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };
const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const nest = (map, key, make) => { let v = map.get(key); if (!v) map.set(key, (v = make())); return v; };

const typeCounts = new Map();
const sums = new Map();      // metric -> date -> source -> total
const avgs = new Map();      // metric -> date -> [sum, n]
const units = new Map();     // metric -> unit -> n
const sources = new Map();   // metric -> source -> n
const sleepIv = [];          // asleep intervals
const sleepValues = new Map(), sleepSources = new Map(), asleepSources = new Set();

function onQuantity(d, r) {
  let date = r.startDate && r.startDate.slice(0, 10);
  if (!date) return;
  if (d.night) { // overnight readings only (22:00-08:00), dated the morning you wake, like sleep
    const hour = +r.startDate.slice(11, 13);
    if (hour >= 8 && hour < 22) return;
    if (hour >= 22) date = new Date(Date.parse(date + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
  }
  if (opt.since && date < opt.since) return;
  let v = parseFloat(r.value);
  if (!Number.isFinite(v)) return;
  const src = unent(r.sourceName || '');
  if (d.weight) { // convert to the chosen unit
    const from = r.unit || 'lb';
    if (from === 'kg' && opt.weightUnit === 'lb') v *= 2.2046226218; else if (from === 'lb' && opt.weightUnit === 'kg') v /= 2.2046226218;
  }
  if (d.scale) v *= d.scale;
  if (r.unit) bump(nest(units, d.m, () => new Map()), r.unit);
  bump(nest(sources, d.m, () => new Map()), src);
  if (d.mode === 'sum') bump(nest(nest(sums, d.m, () => new Map()), date, () => new Map()), src, v);
  else { const a = nest(nest(avgs, d.m, () => new Map()), date, () => [0, 0]); a[0] += v; a[1]++; }
}

function onWorkout(r) {
  if (!wanted.includes('workouts') || !r.startDate) return;
  const date = r.startDate.slice(0, 10);
  if (opt.since && date < opt.since) return;
  let min = parseFloat(r.duration);
  if (!Number.isFinite(min)) return;
  if (r.durationUnit === 'hr') min *= 60; else if (r.durationUnit === 'sec') min /= 60;
  const src = unent(r.sourceName || '');
  bump(nest(sources, 'workouts', () => new Map()), src);
  bump(nest(nest(sums, 'workouts', () => new Map()), date, () => new Map()), src, min);
}

function onSleep(r) {
  if (!r.startDate || !r.endDate) return;
  const v = (r.value || '').replace('HKCategoryValueSleepAnalysis', '');
  const src = unent(r.sourceName || '');
  if (opt.sleepSource && !src.toLowerCase().includes(opt.sleepSource)) return;
  if (opt.since && r.endDate.slice(0, 10) < opt.since) return;
  bump(sleepValues, v);
  bump(sleepSources, src);
  if (v.startsWith('Asleep')) asleepSources.add(src);
  if (!v.startsWith('Asleep')) return; // skip InBed and Awake; Asleep, AsleepCore/Deep/REM/Unspecified count
  const s = epoch(r.startDate), e = epoch(r.endDate);
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) sleepIv.push({ s, e, sl: r.startDate, el: r.endDate });
}

let lines = 0;
const t0 = Date.now();
for await (const line of openLines(file)) {
  if (++lines % 2_000_000 === 0) process.stderr.write(`  …${(lines / 1e6).toFixed(0)}M lines read\r`);
  const m = RECORD.exec(line);
  if (m) {
    const type = m[1];
    bump(typeCounts, type);
    if (type === SLEEP_TYPE) { if (wanted.includes('sleep')) onSleep(attrs(line)); }
    else { const d = byType.get(type); if (d) onQuantity(d, attrs(line)); }
  } else if (WORKOUT.test(line)) { bump(typeCounts, 'Workout'); onWorkout(attrs(line)); }
}
if (lines === 0) { console.error('That file was empty or not an Apple Health export.'); process.exit(1); }
console.log(`Read ${lines.toLocaleString()} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s.\n`);

/* ---------- building tracks ---------- */
const tracks = [];
const notes = [];
const track = (key, name, color, config, map) => {
  const points = [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));
  if (points.length) tracks.push({ key, name, color, config, points });
  return points.length;
};
const mostCommon = (m) => (m && m.size ? [...m].sort((a, b) => b[1] - a[1])[0][0] : null);

for (const m of wanted) {
  if (m === 'sleep') continue;
  const d = METRICS[m], daily = new Map();
  if (d.mode === 'sum') {
    // Per day take the biggest single source: iPhone and Watch both count the same steps, so adding them would double.
    for (const [date, bySrc] of sums.get(m) || []) daily.set(date, round(Math.max(...bySrc.values()), d.digits));
  } else {
    for (const [date, [s, n]] of avgs.get(m) || []) daily.set(date, round(s / n, d.digits));
  }
  const config = { ...d.config };
  if (d.unitFromData) { const u = mostCommon(units.get(m)); if (u) config.unit = u; }
  if (!daily.size) { notes.push(`${m}: no records found in this export.`); continue; }
  track(d.key, d.name, d.color, config, daily);
}

function sleepTracks() {
  const iv = sleepIv.sort((a, b) => a.s - b.s), merged = [];
  for (const x of iv) { // union across sources and stages
    const last = merged[merged.length - 1];
    if (last && x.s <= last.e) { if (x.e > last.e) { last.e = x.e; last.el = x.el; } } else merged.push({ ...x });
  }
  const gap = opt.gap * 3600e3, sessions = [];
  let cur = null;
  for (const x of merged) {
    if (cur && x.s - cur.e <= gap) { cur.e = x.e; cur.el = x.el; cur.asleep += x.e - x.s; }
    else sessions.push((cur = { sl: x.sl, el: x.el, e: x.e, asleep: x.e - x.s }));
  }
  const nights = new Map(); // wake date -> longest session
  for (const s of sessions) {
    const hours = s.asleep / 3600e3;
    if (hours < opt.minSleep) continue;
    const wake = s.el.slice(0, 10), old = nights.get(wake);
    if (!old || hours > old.hours) nights.set(wake, { hours, sl: s.sl, el: s.el });
  }
  const dur = new Map(), bed = new Map(), up = new Map();
  for (const [date, n] of nights) {
    if (opt.since && date < opt.since) continue;
    dur.set(date, round(n.hours, 2));
    up.set(date, round(hourOf(n.el), 2));
    const b = hourOf(n.sl) - 24 * (dayNum(date) - dayNum(n.sl.slice(0, 10))); // hours after midnight, negative = evening before
    if (b > -18) bed.set(date, round(b, 2));
  }
  track('sleep', 'Sleep (hours asleep)', '#5b6cc9', { unit: 'h', chart: 'line', agg: 'avg', min: 3, max: 10, note: 'Time actually asleep in the longest sleep ending that day (awake gaps and in-bed time excluded). Dated the day you woke up.' }, dur);
  track('sleep-bed', 'Fell asleep', '#3d4a9a', { unit: 'h from midnight', chart: 'line', agg: 'avg', note: 'When the longest sleep ending that day began, in hours after midnight; negative is the evening before (-1.5 = 10:30 pm, 0.5 = 12:30 am).' }, bed);
  track('sleep-wake', 'Woke up', '#8e9ae0', { unit: 'h (clock)', chart: 'line', agg: 'avg', note: 'When the longest sleep ending that day ended, as hours since midnight (7.5 = 7:30 am).' }, up);
}
if (wanted.includes('sleep')) {
  if (sleepIv.length) {
    sleepTracks();
    if (asleepSources.size > 1) notes.push(`sleep: ${asleepSources.size} sources wrote "asleep" time (${[...asleepSources].join(', ')}). They are merged, which can fill in awake gaps and overstate sleep. To use just one, add e.g. --sleep-source "Watch".`);
  }
  else notes.push(`sleep: no "asleep" records found${sleepValues.size ? ` (only ${[...sleepValues.keys()].join(', ')}: in-bed times alone can't give sleep duration)` : ''}.`);
}

/* ---------- report ---------- */
const trunc = (m, n = 4) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k || '(unnamed)'} ${v.toLocaleString()}`).join('; ');
console.log('What I found for the metrics you picked:');
for (const m of wanted) {
  if (m === 'sleep') { if (sleepValues.size) console.log(`  sleep   values: ${trunc(sleepValues, 8)}\n          sources: ${trunc(sleepSources)}`); }
  else if (sources.get(m)) console.log(`  ${m.padEnd(7)} sources: ${trunc(sources.get(m))}`);
}
for (const n of notes) console.log('  ! ' + n);

console.log('\nTracks to save:');
console.log('  ' + 'key'.padEnd(16) + 'points'.padStart(7) + '  first        last         unit');
let total = 0;
for (const t of tracks) {
  total += t.points.length;
  console.log('  ' + t.key.padEnd(16) + String(t.points.length).padStart(7) + `  ${t.points[0].date}   ${t.points[t.points.length - 1].date}   ${t.config.unit || ''}`);
}
console.log(`  total ${total.toLocaleString()} points (an account holds ${POINT_CAP.toLocaleString()})`);

const extras = [...typeCounts].filter(([t]) => !t.startsWith('HKCategoryTypeIdentifierSleep') && !byType.has(t) && t !== 'Workout')
  .sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t, n]) => `${t.replace(/^HK(Quantity|Category)TypeIdentifier/, '')} (${n.toLocaleString()})`);
if (extras.length) console.log(`\nAlso in your export (not imported): ${extras.join(', ')}`);

if (opt.out) { fs.writeFileSync(opt.out, JSON.stringify(tracks)); console.log(`\nWrote ${opt.out}`); }
if (!tracks.length) { console.log('\nNothing to save.'); process.exit(0); }
if (!opt.upload) { console.log('\nDry run: nothing was saved. Add --upload to save these to ' + opt.url); process.exit(0); }

/* ---------- upload (same OAuth + MCP path as scripts/demo.mjs) ---------- */
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
  console.log(`\nSign in to ${opt.url} (the password goes only to that site, to authorize this one upload).`);
  if (!handle) handle = await ask('Handle: ');
  if (!password) password = await askHidden('Password: ');
}

const redirect = 'http://localhost:9/cb';
const reg = await (await post('/oauth/register', { client_name: 'apple health import', redirect_uris: [redirect] })).json();
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
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'apple-health-import', version: '1' } });

// Point budget: saving a date that already has a value overwrites it, so at best the new points reuse existing rows.
const tl = await tool('get_timeline', {});
const mine = new Set(tracks.map((t) => t.key));
const used = tl.tracks.filter((t) => t.kind === 'series').reduce((n, t) => n + (t.count || 0), 0);
const newCount = new Map(tracks.map((t) => [t.key, t.points.length]));
const reusable = tl.tracks.filter((t) => mine.has(t.key)).reduce((n, t) => n + Math.min(t.count || 0, newCount.get(t.key)), 0);   // at best every new point lands on a date that's already there
const projected = used - reusable + total;
console.log(`\nPoint budget: ${used.toLocaleString()} used now, about ${projected.toLocaleString()} after this import, cap ${POINT_CAP.toLocaleString()}.`);
if (projected > POINT_CAP) {
  console.error('That would go over the cap. Re-run with fewer --metrics or a later --since, or ask for weekly storage for the big ones.');
  process.exit(1);
}

const existing = new Set(tl.tracks.map((t) => t.key));
for (const t of tracks) {
  // A track that is already there keeps its own name, colour and settings (they may carry notes you wrote); only points are written.
  if (!existing.has(t.key)) await tool('save_track', { key: t.key, kind: 'series', name: t.name, color: t.color, config: t.config });
  else process.stdout.write(`  ${t.key}: already exists, keeping its settings\n`);
  for (let i = 0; i < t.points.length; i += PER_CALL) {
    await tool('save_points', { track: t.key, points: t.points.slice(i, i + PER_CALL), mode: 'set' });
    process.stdout.write(`  ${t.key}: ${Math.min(i + PER_CALL, t.points.length)}/${t.points.length}\r`);
  }
  process.stdout.write(`  ${t.key}: ${t.points.length} points saved      \n`);
}

console.log('\nDone. Refresh the page.');
