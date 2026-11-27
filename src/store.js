// Data access for the timeline. Deliberately plain: it validates and stores what it is given, nothing more.
// Used by the page (read) and the MCP server (read and write).

import { now, UserError, KEY_RE, COLOR_RE, validDate, cleanText } from './lib.js';
import { cleanLife } from './life.js';

export const LIMITS = { tracks: 60, items: 20000, points: 80000, itemsPerCall: 200, pointsPerCall: 1000 };
const KINDS = ['span', 'event', 'series'];
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

function cleanObject(o, what, max = 4000) {
  if (o == null) return {};
  if (typeof o !== 'object' || Array.isArray(o)) throw new UserError(`${what} must be an object.`);
  const s = JSON.stringify(o);
  if (s.length > max) throw new UserError(`${what} is too large (limit ${max} characters).`);
  return JSON.parse(s);
}
const need = (cond, msg) => { if (!cond) throw new UserError(msg); };
const colorOf = (c, fallback) => (c == null || c === '' ? fallback : (need(COLOR_RE.test(c), 'Colors look like #3d6fd1.'), c.toLowerCase()));

/* ---------- Reading ---------- */

export const profileOf = (u) => ({ name: u.name, birth: u.birth, life: cleanLife(parse(u.profile, {}).life) });
const trackOut = (t) => ({ key: t.key, name: t.name, kind: t.kind, color: t.color, config: parse(t.config, {}) });
const itemOut = (i, key) => ({ id: i.id, track: key, start: i.start, end: i.end, label: i.label, color: i.color, attrs: parse(i.attrs, {}) });

export async function listTracks(env, me) {
  const { results } = await env.DB.prepare('SELECT * FROM tracks WHERE user_id = ? ORDER BY sort, id').bind(me.id).all();
  return results;
}

/* What the page fetches first: small, never cached blindly. Each track carries `rev`, which moves whenever
   its items or points change, so the page can tell which tracks it already has. */
export async function manifest(env, me) {
  const tracks = await listTracks(env, me);
  return { uid: me.id, profile: profileOf(me), tracks: tracks.map((t) => ({ ...trackOut(t), rev: t.rev })) };
}

/* One track's rows: items for span/event tracks, [date, value] pairs for series. Null if there is no such track. */
export async function trackData(env, me, key) {
  const t = await env.DB.prepare('SELECT * FROM tracks WHERE user_id = ? AND key = ?').bind(me.id, key).first();
  if (!t) return null;
  if (t.kind === 'series') {
    const { results } = await env.DB.prepare('SELECT date, value FROM points WHERE track_id = ? ORDER BY date').bind(t.id).all();
    return { rev: t.rev, points: results.map((r) => [r.date, r.value]) };
  }
  const { results } = await env.DB.prepare('SELECT * FROM items WHERE track_id = ? ORDER BY start, id').bind(t.id).all();
  return { rev: t.rev, items: results.map((i) => itemOut(i, t.key)) };
}

/* Marks a track's data as changed. Always moves forward, even if the clock hasn't. */
const touch = (env, trackId) => env.DB.prepare('UPDATE tracks SET rev = MAX(rev + 1, ?) WHERE id = ?').bind(now(), trackId).run();

export async function summary(env, me) {
  const tracks = await listTracks(env, me);
  const ic = (await env.DB.prepare('SELECT track_id, COUNT(*) n, MIN(start) lo, MAX(COALESCE(end, start)) hi FROM items WHERE user_id = ? GROUP BY track_id').bind(me.id).all()).results;
  const pc = (await env.DB.prepare('SELECT track_id, COUNT(*) n, MIN(date) lo, MAX(date) hi FROM points WHERE user_id = ? GROUP BY track_id').bind(me.id).all()).results;
  const by = new Map([...ic, ...pc].map((r) => [r.track_id, r]));
  return {
    profile: profileOf(me),
    tracks: tracks.map((t) => { const r = by.get(t.id); return { ...trackOut(t), count: r ? r.n : 0, first: r ? r.lo : null, last: r ? r.hi : null }; }),
  };
}

async function trackByKey(env, me, key) {
  const t = await env.DB.prepare('SELECT * FROM tracks WHERE user_id = ? AND key = ?').bind(me.id, String(key || '')).first();
  if (!t) throw new UserError(`No track "${key}". Use get_timeline to see the track keys, or save_track to make one.`);
  return t;
}

export async function listItems(env, me, a) {
  const t = await trackByKey(env, me, a.track);
  const from = a.from ? validDate(a.from) : '0000-01-01', to = a.to ? validDate(a.to) : '9999-12-31';
  need(from && to, 'from and to are dates like 1990-04-23.');
  const limit = Math.max(1, Math.min(500, Number(a.limit) || 200));
  // Overlaps the window: starts before `to` and (ends after `from` or has no end).
  const { results } = await env.DB.prepare(
    'SELECT * FROM items WHERE track_id = ? AND start <= ? AND COALESCE(end, start) >= ? ORDER BY start, id LIMIT ?'
  ).bind(t.id, to, from, limit).all();
  return results.map((i) => itemOut(i, t.key));
}

export async function listPoints(env, me, a) {
  const t = await trackByKey(env, me, a.track);
  const from = a.from ? validDate(a.from) : '0000-01-01', to = a.to ? validDate(a.to) : '9999-12-31';
  need(from && to, 'from and to are dates like 1990-04-23.');
  const limit = Math.max(1, Math.min(2000, Number(a.limit) || 1000));
  const { results } = await env.DB.prepare('SELECT date, value FROM points WHERE track_id = ? AND date >= ? AND date <= ? ORDER BY date LIMIT ?').bind(t.id, from, to, limit).all();
  return { track: t.key, points: results.map((r) => [r.date, r.value]) };
}

/* ---------- Profile ---------- */

export async function setProfile(env, me, a) {
  let name = me.name, birth = me.birth;
  const p = parse(me.profile, {});
  if (a.name !== undefined) name = cleanText(a.name, 40) || me.handle;
  if (a.birth !== undefined) { birth = validDate(a.birth); need(birth, 'birth is a date like 1990-04-23.'); }
  if (a.life !== undefined) p.life = cleanLife({ ...cleanLife(p.life), ...a.life });
  await env.DB.prepare('UPDATE users SET name = ?, birth = ?, profile = ? WHERE id = ?').bind(name, birth, JSON.stringify(p), me.id).run();
  return profileOf({ ...me, name, birth, profile: JSON.stringify(p) });
}

/* ---------- Tracks ---------- */

export async function saveTrack(env, me, a) {
  const key = String(a.key || '').toLowerCase();
  need(KEY_RE.test(key), 'A track key is 1–32 lowercase letters, numbers, - or _ (like "jobs").');
  const old = await env.DB.prepare('SELECT * FROM tracks WHERE user_id = ? AND key = ?').bind(me.id, key).first();
  if (!old) {
    need(KINDS.includes(a.kind), 'A new track needs kind: "span", "event" or "series".');
    const n = (await env.DB.prepare('SELECT COUNT(*) n FROM tracks WHERE user_id = ?').bind(me.id).first()).n;
    need(n < LIMITS.tracks, `At most ${LIMITS.tracks} tracks.`);
    const name = cleanText(a.name, 60) || key;
    const sort = a.sort != null ? Number(a.sort) || 0 : n;
    await env.DB.prepare('INSERT INTO tracks (user_id, key, name, kind, color, sort, config, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(me.id, key, name, a.kind, colorOf(a.color, '#4f7cdb'), sort, JSON.stringify(cleanObject(a.config, 'config')), now()).run();
  } else {
    need(a.kind == null || a.kind === old.kind, `A track's kind can't change (it is ${old.kind}). Make a new track instead.`);
    const config = a.config !== undefined ? cleanObject(a.config, 'config') : parse(old.config, {});
    await env.DB.prepare('UPDATE tracks SET name = ?, color = ?, sort = ?, config = ? WHERE id = ?')
      .bind(a.name !== undefined ? cleanText(a.name, 60) || key : old.name, colorOf(a.color, old.color), a.sort != null ? Number(a.sort) || 0 : old.sort, JSON.stringify(config), old.id).run();
  }
  return trackOut(await env.DB.prepare('SELECT * FROM tracks WHERE user_id = ? AND key = ?').bind(me.id, key).first());
}

export async function deleteTrack(env, me, key) {
  const t = await trackByKey(env, me, key);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM items WHERE track_id = ?').bind(t.id),
    env.DB.prepare('DELETE FROM points WHERE track_id = ?').bind(t.id),
    env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(t.id),
  ]);
  return { deleted: t.key };
}

/* ---------- Items (spans and events) ---------- */

export async function saveItems(env, me, a) {
  const t = await trackByKey(env, me, a.track);
  need(t.kind !== 'series', `"${t.key}" is a series track: use save_points for its numbers.`);
  const list = Array.isArray(a.items) ? a.items : [];
  need(list.length > 0, 'Give items: [{start, end?, label, color?, attrs?}].');
  need(list.length <= LIMITS.itemsPerCall, `At most ${LIMITS.itemsPerCall} items per call.`);
  const rows = list.map((it, n) => {
    const at = `Item ${n + 1}`;
    const start = validDate(it.start); need(start, `${at}: start is a date like 1990-04-23.`);
    let end = it.end == null || it.end === '' ? null : validDate(it.end);
    need(it.end == null || it.end === '' || end, `${at}: end is a date like 1990-04-23, or leave it out if it is still going.`);
    if (t.kind === 'event') end = null;
    need(!end || end >= start, `${at}: end is before start.`);
    const id = it.id != null ? Number(it.id) : null;
    need(id == null || Number.isInteger(id), `${at}: id must be a whole number.`);
    return { id, start, end, label: cleanText(it.label, 120), color: colorOf(it.color, null), attrs: cleanObject(it.attrs, `${at}: attrs`, 2000) };
  });
  const creating = rows.filter((r) => r.id == null).length;
  if (creating) need((await env.DB.prepare('SELECT COUNT(*) n FROM items WHERE user_id = ?').bind(me.id).first()).n + creating <= LIMITS.items, `At most ${LIMITS.items} items.`);
  const stmts = rows.map((r) => r.id == null
    ? env.DB.prepare('INSERT INTO items (user_id, track_id, start, end, label, color, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(me.id, t.id, r.start, r.end, r.label, r.color, JSON.stringify(r.attrs))
    : env.DB.prepare('UPDATE items SET start = ?, end = ?, label = ?, color = ?, attrs = ? WHERE id = ? AND track_id = ?').bind(r.start, r.end, r.label, r.color, JSON.stringify(r.attrs), r.id, t.id));
  const res = await env.DB.batch(stmts);
  await touch(env, t.id);
  const missing = rows.map((r, i) => (r.id != null && !res[i].meta.changes ? r.id : null)).filter((x) => x != null);
  need(!missing.length, `No item with id ${missing.join(', ')} on track "${t.key}" (the rest were saved).`);
  return { track: t.key, saved: rows.length, created_ids: res.map((r, i) => (rows[i].id == null ? r.meta.last_row_id : null)).filter((x) => x != null) };
}

export async function deleteItems(env, me, a) {
  const ids = (Array.isArray(a.ids) ? a.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
  need(ids.length, 'Give ids: [item ids].');
  const tracks = new Set();
  let deleted = 0;
  for (const part of chunk(ids, 90)) { // D1 allows about 100 bound values per statement
    const ph = part.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT DISTINCT track_id FROM items WHERE user_id = ? AND id IN (${ph})`).bind(me.id, ...part).all();
    results.forEach((r) => tracks.add(r.track_id));
    deleted += (await env.DB.prepare(`DELETE FROM items WHERE user_id = ? AND id IN (${ph})`).bind(me.id, ...part).run()).meta.changes;
  }
  for (const id of tracks) await touch(env, id);
  return { deleted };
}

/* ---------- Points (one number per day on a series track) ---------- */

export async function savePoints(env, me, a) {
  const t = await trackByKey(env, me, a.track);
  need(t.kind === 'series', `"${t.key}" is a ${t.kind} track: use save_items for it.`);
  const list = Array.isArray(a.points) ? a.points : [];
  need(list.length > 0, 'Give points: [{date, value}].');
  need(list.length <= LIMITS.pointsPerCall, `At most ${LIMITS.pointsPerCall} points per call.`);
  const add = a.mode === 'add';
  const rows = list.map((p, n) => {
    const date = validDate(Array.isArray(p) ? p[0] : p.date), value = Number(Array.isArray(p) ? p[1] : p.value);
    need(date, `Point ${n + 1}: date is like 1990-04-23.`);
    need(Number.isFinite(value) && Math.abs(value) < 1e9, `Point ${n + 1}: value must be a number.`);
    return [date, value];
  });
  const total = (await env.DB.prepare('SELECT COUNT(*) n FROM points WHERE user_id = ?').bind(me.id).first()).n;
  need(total < LIMITS.points, `At most ${LIMITS.points} points in total.`); // soft cap: checked per call
  const sql = add
    ? 'INSERT INTO points (track_id, user_id, date, value) VALUES (?, ?, ?, ?) ON CONFLICT(track_id, date) DO UPDATE SET value = value + excluded.value'
    : 'INSERT INTO points (track_id, user_id, date, value) VALUES (?, ?, ?, ?) ON CONFLICT(track_id, date) DO UPDATE SET value = excluded.value';
  for (const part of chunk(rows, 100)) await env.DB.batch(part.map(([d, v]) => env.DB.prepare(sql).bind(t.id, me.id, d, v)));
  await touch(env, t.id);
  return { track: t.key, saved: rows.length, mode: add ? 'add' : 'set' };
}

export async function deletePoints(env, me, a) {
  const t = await trackByKey(env, me, a.track);
  if (Array.isArray(a.dates) && a.dates.length) {
    const dates = a.dates.map(validDate).filter(Boolean).slice(0, 1000);
    for (const part of chunk(dates, 100)) await env.DB.batch(part.map((d) => env.DB.prepare('DELETE FROM points WHERE track_id = ? AND date = ?').bind(t.id, d)));
    await touch(env, t.id);
    return { track: t.key, deleted_dates: dates.length };
  }
  const from = validDate(a.from), to = validDate(a.to);
  need(from && to, 'Give dates: [...] or both from and to.');
  const r = await env.DB.prepare('DELETE FROM points WHERE track_id = ? AND date >= ? AND date <= ?').bind(t.id, from, to).run();
  await touch(env, t.id);
  return { track: t.key, deleted: r.meta.changes };
}
