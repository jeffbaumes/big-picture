// Big Picture page: sign-in, the track visibility controls (display only), the poster and charts.
// Nothing here edits timeline data. That happens through the MCP server.

import { buildModel, defaultOn, resolveMain, rolesOf, plan, drawPoster, whatsAt, cellAt, drawCellOutline, dn } from './poster.js';
import { icon, mountIcons } from './icons.js';
import { createTimeline } from './timeline.js';
import { createAnalysis } from './analysis.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };

mountIcons();   // <i data-icon="..."> in the page become Heroicons

// The analysis follows whatever range is selected on the timeline, so the timeline tells it when that changes.
const timeline = createTimeline($('charts'), { tip: $('tip'), onRange: () => analysis.refresh() });
let data = null, me = null, M = null;
// mode: 'calendar' (the poster) or 'analysis' (correlations); an: how analysis pairs series up
const st = { main: null, on: new Set(), zoom: null, layers: { fade: true, grid: true, today: true, labels: true, months: true }, mode: 'calendar', an: { res: 'week', fill: true } };
const analysis = createAnalysis($('analysis'), { tip: $('tip'), st, save: () => save(), getRange: () => timeline.getRange() });

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: opts.body ? { 'content-type': 'application/json' } : undefined });
  let body = null; try { body = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(body?.error || 'Something went wrong.'); e.status = res.status; throw e; }
  return body;
}

/* ---------- sign in / create account ---------- */
let mode = 'in';
function setMode(m) {
  mode = m;
  $('t-in').setAttribute('aria-selected', m === 'in'); $('t-up').setAttribute('aria-selected', m === 'up');
  $('f-name').hidden = $('f-birth').hidden = m === 'in';
  $('a-birth').required = m === 'up';
  $('a-go').textContent = m === 'in' ? 'Sign in' : 'Create my calendar';
  $('a-pass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
  $('a-err').hidden = true;
}
$('t-in').onclick = () => setMode('in'); $('t-up').onclick = () => setMode('up');
$('authform').onsubmit = async (e) => {
  e.preventDefault();
  const body = { handle: $('a-handle').value, password: $('a-pass').value };
  if (mode === 'up') { body.name = $('a-name').value; body.birth = $('a-birth').value; }
  $('a-go').disabled = true;
  try { await api(mode === 'in' ? '/api/login' : '/api/signup', { method: 'POST', body: JSON.stringify(body) }); await boot(); }
  catch (err) { $('a-err').textContent = err.message; $('a-err').hidden = false; }
  finally { $('a-go').disabled = false; }
};
$('b-out').onclick = async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {} location.reload(); };

/* ---------- load: a small manifest, then only the tracks whose revision changed ---------- */
// The manifest says which tracks exist and each one's revision. A track's data is fetched from a URL that contains
// that revision, so the browser keeps it forever and we only ask again when the revision moves. Here we also keep
// what we have in memory, and check the manifest again whenever you come back to the tab.
const have = new Map();               // track key -> {rev, items | points}
let lastManifest = '';
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/* Brings `data` up to date. Resolves to {changed, fetched: [track keys downloaded]}. */
async function sync() {
  const man = await api('/api/manifest'); // revalidated with an ETag; a 304 is nearly free
  const text = JSON.stringify(man);
  const stale = man.tracks.filter((t) => have.get(t.key)?.rev !== t.rev);
  const got = await Promise.all(stale.map(async (t) => [t.key, await api(`/api/t/${man.uid}/${t.key}/${t.rev}`)]));
  for (const [k, v] of got) have.set(k, v);
  for (const k of [...have.keys()]) if (!man.tracks.some((t) => t.key === k)) have.delete(k);
  const today = localToday();
  const changed = text !== lastManifest || got.length > 0 || data?.today !== today;
  lastManifest = text;
  if (!changed) return { changed: false, fetched: [] };
  const items = [], points = {};
  for (const t of man.tracks) { const h = have.get(t.key); if (h.items) items.push(...h.items); if (h.points) points[t.key] = h.points; }
  const known = new Set(data?.tracks.map((t) => t.key) || []);
  data = { profile: man.profile, life: man.life, tracks: man.tracks, items, points, today };
  data.newTracks = man.tracks.filter((t) => !known.has(t.key)).map((t) => t.key);
  return { changed: true, fetched: stale.map((t) => t.key) };
}

async function boot() {
  try { await sync(); }
  catch (e) { if (e.status === 401) { $('app').hidden = true; $('auth').hidden = false; setMode(mode); return; } throw e; }
  me = data.profile;
  $('auth').hidden = true; $('app').hidden = false;
  document.title = `${me.name}’s Big Picture`;
  if (!restore()) st.on = defaultOn(data);   // first visit in this browser: the defaults
  buildDisplayMenu(); buildChrome(); renderAll();
}

/* Out of date? Ask the (cheap) manifest, download only what moved, redraw only if something did. */
let checking = false, lastCheck = 0;
async function refresh() {
  if (!data || checking || Date.now() - lastCheck < 10000) return;
  checking = true; lastCheck = Date.now();
  try {
    const r = await sync();
    if (r.changed) {
      me = data.profile; document.title = `${me.name}’s Big Picture`;
      const d = defaultOn(data); for (const k of data.newTracks) if (d.has(k)) st.on.add(k);   // a new span or event track starts on
      st.on = new Set([...st.on].filter((k) => data.tracks.some((t) => t.key === k)));
      save(); buildChrome(); renderAll();
    }
    $('foot').dataset.checked = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    updateFoot(r.fetched);
  } catch (e) { if (e.status === 401) location.reload(); }
  finally { checking = false; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
window.addEventListener('focus', refresh);
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5 * 60 * 1000);

/* Display choices (what is switched on, the main grid, zoom, analysis settings) live in this browser only. */
const storeKey = () => `bp:${location.host}:${me?.name}:${me?.birth}`;
function restore() {   // true if this browser had saved choices
  try {
    const s = JSON.parse(localStorage.getItem(storeKey()) || 'null'); if (!s) return false;
    st.on = new Set(s.on || []); st.zoom = s.zoom ?? null; st.main = s.main ?? null; Object.assign(st.layers, s.layers || {});
    if (s.mode === 'analysis') st.mode = 'analysis';
    if (['day', 'week', 'month'].includes(s.an?.res)) st.an.res = s.an.res;
    if (typeof s.an?.fill === 'boolean') st.an.fill = s.an.fill;
    return true;
  } catch {}
  return false;
}
function save() { try { localStorage.setItem(storeKey(), JSON.stringify({ on: [...st.on], zoom: st.zoom, main: st.main, layers: st.layers, mode: st.mode, an: st.an })); } catch {} }

/* ---------- controls: read-only toggles for what the poster shows ---------- */
/* A toggle chip. With `star`, a ★ button beside it sets that track as the main grid. */
function chip(label, on, onClick, color, sub, star) {
  const wrap = el('div', { className: 'chip' + (on ? '' : ' off') });
  const b = el('button', { className: 'cb', type: 'button' });
  b.setAttribute('aria-pressed', on);
  if (color) b.append(el('span', { className: 'dot', style: `background:${color}` }));
  b.append(label); if (sub) b.append(el('small', { textContent: sub }));
  b.onclick = onClick;
  wrap.append(b);
  if (star) {
    const sb = el('button', { className: 'star' + (star.on ? ' on' : ''), type: 'button', title: star.on ? 'This is the main grid. Click to clear it.' : 'Make this the main grid' }, icon('star', star.on));
    sb.setAttribute('aria-label', star.on ? `${label} is the main grid; clear it` : `Make ${label} the main grid`);
    sb.setAttribute('aria-pressed', star.on);
    sb.onclick = star.onClick;
    wrap.append(sb);
  }
  return wrap;
}
function buildChrome() {
  const empty = data.tracks.length === 0;
  $('onboard').hidden = !empty;
  $('controls').hidden = empty;
  const t = $('toggles'); t.replaceChildren();
  if (empty) return;
  const roles = rolesOf(data, st), main = resolveMain(data, st);
  const chips = el('div', { className: 'chips' });
  for (const tr of data.tracks) {
    const toggle = () => { st.on.has(tr.key) ? st.on.delete(tr.key) : st.on.add(tr.key); save(); buildChrome(); renderAll(); };
    // ★ makes a span track the main bars or a numeric track the main heatmap (and switches it on); click it again to clear.
    const star = tr.kind === 'event' ? null : { on: main === tr.key, onClick: () => {
      if (main === tr.key) st.main = 'none'; else { st.main = tr.key; st.on.add(tr.key); }
      save(); buildChrome(); renderAll();
    } };
    chips.append(chip(tr.name, st.on.has(tr.key), toggle, tr.color, roles[tr.key], star));
  }
  t.append(el('div', { className: 'rowline' }, el('h3', { textContent: 'Tracks' }), chips));
}

/* ---------- drawing: the canvas is sized in whole device pixels ---------- */
// The poster is laid out directly in device pixels (see poster.js), so the canvas must be exactly as many device
// pixels wide as the space it occupies. That makes every cell a whole number of pixels at any density, fractional
// ones included. The browser's ResizeObserver can report the exact device-pixel size of the box; dividing that by
// its CSS width gives the true pixels-per-CSS-pixel even when window.devicePixelRatio is rounded or scaled (zoom,
// emulation, odd phones). Where that isn't supported we fall back to floor(css width × devicePixelRatio).
const poster = $('poster'), stage = $('stage'), hoverCv = $('hover');
const dpr = () => window.devicePixelRatio || 1;
let boxDevW = 0, boxD = 0, hasDPBox = false;
let P = null;
// Saved images are laid out again at a large fixed size (1400 CSS px wide at 3x = 4200 px) so they hold up on paper.
// If the browser can't make a canvas that big (phones have tight limits), we step down.
const EXPORT_SIZES = [{ W: 4200, D: 3 }, { W: 3400, D: 2.5 }, { W: 2800, D: 2 }, { W: 1800, D: 1.5 }];

/* Width of the stage in device pixels and the true device pixels per CSS pixel. */
function measure() {
  if (hasDPBox && boxDevW) return { W: boxDevW, D: boxD };
  const D = dpr();
  return { W: Math.max(1, Math.floor(stage.getBoundingClientRect().width * D)), D };
}
const sizeCanvas = (c, D) => { c.style.width = c.width / D + 'px'; c.style.height = c.height / D + 'px'; };

/* Two tabs under the timeline: the grid (the poster, with its own top bar) or the analysis (correlations over the range
   selected on the timeline). The timeline stays above both. */
function applyMode() {
  const an = st.mode === 'analysis', any = !!data?.tracks.length;
  $('ptabs').hidden = !any;
  $('gridview').hidden = an || !any;
  $('analysis').hidden = !an || !any;
  $('tab-grid').setAttribute('aria-selected', !an); $('tab-grid').tabIndex = an ? -1 : 0;
  $('tab-analysis').setAttribute('aria-selected', an); $('tab-analysis').tabIndex = an ? 0 : -1;
}
function showTab(m) { if (st.mode === m) return; st.mode = m; save(); renderAll(); }
$('tab-grid').onclick = () => showTab('calendar');
$('tab-analysis').onclick = () => showTab('analysis');
$('ptabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault(); const to = st.mode === 'analysis' ? 'calendar' : 'analysis'; showTab(to); $(to === 'analysis' ? 'tab-analysis' : 'tab-grid').focus();
});

/* The title at the top of the page: name, age and which day of life it is. (The poster only carries this in a saved image.) */
function renderTitle() {
  const days = dn(data.today) - dn(me.birth), age = Math.floor(days / 365.2425);
  $('t-name').textContent = `${me.name || 'My'}’s Big Picture`;
  $('t-sub').textContent = `age ${age} · day ${days.toLocaleString('en-US')}`;
}

/* The grid's Display menu: toggles for how the poster is drawn. Stays open while you flip several. */
const LAYERS = [['fade', 'Fade by life expectancy'], ['grid', 'Gaps between squares'], ['months', 'Months'], ['labels', 'Bar labels'], ['today', 'Today']];
function buildDisplayMenu() {
  const m = $('m-display'); m.replaceChildren();
  for (const [k, label] of LAYERS) {
    const b = el('button', { type: 'button', role: 'menuitemcheckbox' }, (() => { const c = icon('check'); c.classList.add('ck'); return c; })(), el('span', { textContent: label }));
    b.setAttribute('aria-checked', st.layers[k]);
    b.onclick = () => { st.layers[k] = !st.layers[k]; b.setAttribute('aria-checked', st.layers[k]); save(); renderAll(); };
    m.append(b);
  }
}
function setDisplayOpen(open) { $('m-display').hidden = !open; $('b-display').setAttribute('aria-expanded', open); }
$('b-display').onclick = () => setDisplayOpen($('m-display').hidden);
document.addEventListener('click', (e) => { if (!e.target.closest('.dd')) setDisplayOpen(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('m-display').hidden) { setDisplayOpen(false); $('b-display').focus(); } });

function renderAll() {
  applyMode(); renderTitle();
  if (st.mode !== 'analysis') {
    M = buildModel(data, st);
    const { W, D } = measure();
    P = plan(M, W, D, st.zoom);
    drawPoster(poster, M, P); sizeCanvas(poster, D);
    hoverCv.width = poster.width; hoverCv.height = poster.height; sizeCanvas(hoverCv, D);   // overlay for the hover outline (cleared by resizing)
  }
  timeline.update(data, st);   // every switched-on track, on one shared time axis
  if (st.mode === 'analysis') analysis.update(data);
  updateFoot(); updateZoom();
}
function updateFoot(fetched) {
  const f = $('foot');
  if (!data.tracks.length) { f.textContent = ''; return; }
  const bits = [`${data.items.length.toLocaleString('en-US')} items`, `${Object.values(data.points).reduce((n, p) => n + p.length, 0).toLocaleString('en-US')} measurements`];
  const when = f.dataset.checked ? ` · checked ${f.dataset.checked}${fetched?.length ? `, updated ${fetched.join(', ')}` : ', up to date'}` : '';
  f.textContent = `${bits.join(' · ')}${when} · edit by talking to your AI app (Connect AI above)`;
}
let raf = 0;
const rerender = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => data && renderAll()); };

const ro = new ResizeObserver((entries) => {
  const e = entries[entries.length - 1], dp = e.devicePixelContentBoxSize?.[0];
  const css = e.contentBoxSize?.[0]?.inlineSize ?? e.contentRect.width;
  if (dp && css > 0) { hasDPBox = true; boxDevW = Math.round(dp.inlineSize); boxD = dp.inlineSize / css; }
  rerender();
});
try { ro.observe(stage, { box: 'device-pixel-content-box' }); } catch { ro.observe(stage); }

/* Pixel density changes when the page is zoomed or moved to another screen: redraw at the new ratio. */
function watchDpr() {
  const mq = matchMedia(`(resolution: ${dpr()}dppx)`);
  mq.addEventListener('change', () => { watchDpr(); rerender(); }, { once: true });
}
watchDpr();
window.addEventListener('resize', rerender);

/* Save image: lay the poster out again at a large fixed size so it is print quality, whatever the screen. */
$('b-png').onclick = async () => {
  const btn = $('b-png'), lab = btn.querySelector('span'), label = lab.textContent;
  btn.disabled = true; lab.textContent = 'Saving…';
  try {
    for (const { W, D } of EXPORT_SIZES) {
      const c = document.createElement('canvas');
      drawPoster(c, M, plan(M, W, D, 'fit', true));   // true: add the name, age and day title
      const blob = await new Promise((done) => c.toBlob(done, 'image/png'));
      if (!blob) continue; // too big for this browser: try the next size down
      const a = el('a', { href: URL.createObjectURL(blob), download: `big-picture-${data.today}.png` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      return;
    }
    alert('This browser could not make the image. Try a computer.');
  } finally { btn.disabled = false; lab.textContent = label; }
};

/* ---------- zoom: the size of the squares. The largest size fills the width, so nothing ever scrolls sideways ---------- */
const ZOOMS = [3, 4, 5, 6, 8, 10, 12, 14, 17, 20, 24, 28, 34, 40, 48, 56];   // CSS px per square
function updateZoom() {
  if (!P) return;
  $('z-in').disabled = P.pitch >= P.fitPitch;
  $('z-out').disabled = P.pitch / P.D <= ZOOMS[0] + 0.05;
}
function zoomBy(dir) {
  if (!P) return;
  // Step from the chosen level (not the pixel-rounded result), unless it is on 'fit' or larger than fit.
  const fit = P.fitPitch / P.D, cur = typeof st.zoom === 'number' ? Math.min(st.zoom, fit) : P.pitch / P.D;
  let next;
  if (dir > 0) { const z = ZOOMS.find((v) => v > cur + 0.01); next = !z || z >= fit - 0.05 ? 'fit' : z; }
  else next = [...ZOOMS].reverse().find((v) => v < cur - 0.01) ?? ZOOMS[0];
  // keep whatever is in the middle of the screen in the middle of the screen
  const r = poster.getBoundingClientRect(), anchor = (innerHeight / 2 - r.top) / r.height;
  st.zoom = next; save(); renderAll();
  const r2 = poster.getBoundingClientRect();
  window.scrollBy(0, r2.top + anchor * r2.height - innerHeight / 2);
}
$('z-in').onclick = () => zoomBy(1);
$('z-out').onclick = () => zoomBy(-1);

/* ---------- hover (mouse) and tap (touch): what is at this spot ---------- */
const tip = $('tip');
function showTip(e, touch) {
  if (!M || !P) return false;
  const r = poster.getBoundingClientRect();
  const x = (e.clientX - r.left) * (P.W / r.width), y = (e.clientY - r.top) * (P.H / r.height);
  drawCellOutline(hoverCv, P, cellAt(M, P, x, y));       // always outline the week under the pointer
  const hit = whatsAt(M, P, x, y);
  if (!hit) { tip.hidden = true; return false; }
  const fmtD = (s) => new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  tip.replaceChildren(el('b', { textContent: `Week of ${fmtD(hit.date)}` }),
    el('div', { className: 'm', textContent: `age ${hit.age} · day ${hit.day.toLocaleString('en-US')}${hit.future ? ' · ahead' : ''}` }));
  for (const l of hit.lines.slice(0, 8)) {
    tip.append(el('div', {}, el('span', { className: 'sw', style: `background:${l.color}` }), el('b', { textContent: l.label || l.track }), el('span', { className: 'm', textContent: ` ${l.label ? l.track : ''}${l.range ? ' · ' + l.range : ''}` })));
    const extra = Object.entries(l.attrs || {}).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(' · ');
    if (extra) tip.append(el('div', { className: 'm', textContent: extra }));
  }
  if (hit.lines.length > 8) tip.append(el('div', { className: 'm', textContent: `+ ${hit.lines.length - 8} more` }));
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - w - 8, touch ? e.clientX - w / 2 : e.clientX + 14));
  const above = touch && e.clientY - h - 18 > 8;
  tip.style.left = left + 'px';
  tip.style.top = (above ? e.clientY - h - 18 : Math.max(8, Math.min(innerHeight - h - 8, e.clientY + 16))) + 'px';
  return true;
}
poster.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showTip(e, false); });
const clearHover = () => { tip.hidden = true; if (P) drawCellOutline(hoverCv, P, null); };
poster.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clearHover(); });
poster.addEventListener('click', (e) => { if (e.pointerType === 'mouse') return; if (!showTip(e, true)) clearHover(); });
window.addEventListener('scroll', clearHover, { passive: true });

/* ---------- connecting an AI app ---------- */
const mcpUrl = () => `${location.origin}/mcp`;
const cmd = () => `claude mcp add --transport http bigpicture ${mcpUrl()}`;
function fillConnect() {
  $('o-url').textContent = $('d-url').textContent = mcpUrl();
  $('o-cmd').textContent = $('d-cmd').textContent = cmd();
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); const lab = b.querySelector('span'), t = lab.textContent; lab.textContent = 'Copied'; setTimeout(() => (lab.textContent = t), 1200); } catch {}
});
$('b-connect').onclick = async () => {
  fillConnect(); $('dlg').showModal();
  const box = $('d-apps'); box.replaceChildren();
  try {
    const { apps } = await api('/api/apps');
    if (apps.length) box.append(el('b', { textContent: 'Connected apps' }));
    for (const a of apps) {
      const btn = el('button', { className: 'btn', textContent: 'Disconnect', type: 'button' });
      btn.onclick = async () => { await api('/api/apps/' + a.id, { method: 'DELETE', body: '{}' }); btn.closest('div').remove(); };
      box.append(el('div', {}, el('span', { textContent: a.name }), btn));
    }
  } catch {}
};
$('d-close').onclick = () => $('dlg').close();
$('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) $('dlg').close(); });
fillConnect();

boot().catch((e) => { $('auth').hidden = false; $('a-err').textContent = e.message; $('a-err').hidden = false; });
