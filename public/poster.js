// The calendar poster. One canvas, laid out directly in DEVICE pixels: the canvas is exactly as many pixels as the
// screen gives it, and every cell and gap is a whole number of them, so nothing is ever resampled or blurred, at any
// pixel density (1x, 2x, 3x, 1.25x, 2.625x...). A strict grid of square weeks: 52 columns, one row per year, no gaps
// between years or decades. Bars are inset pills laid over the squares. Nothing here edits data; it only draws it.

export const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MS = 864e5;
const C = { paper: '#ffffff', ink: '#26323f', soft: '#6f7b8a', faint: '#b9c1cc', past: '#dde2e9', future: '#e9ecf1', ring: '#111a24' };

/* ---------- dates ---------- */
export const dn = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / MS; };
export const dnToStr = (n) => new Date(n * MS).toISOString().slice(0, 10);
const yearOf = (n) => new Date(n * MS).getUTCFullYear();
const yearStart = (y) => Date.UTC(y, 0, 1) / MS;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_COL = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
export const prettyDate = (s) => { const [y, m, d] = s.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; };
const shortRange = (a, b) => (b ? `${a.slice(0, 4) === b.slice(0, 4) ? prettyDate(a).slice(0, -6) : prettyDate(a)} – ${prettyDate(b)}` : `${prettyDate(a)} –`);

/* ---------- colors ---------- */
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return [h, s, l];
}
const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
/* Items without their own color alternate between three shades of the track's color so neighbours stay distinct. */
export function shade(hex, i) {
  const [h, s, l] = hexToHsl(hex);
  const k = i % 3;
  if (k === 0) return hex;
  return hsl(h + (k === 1 ? 0 : 10), s, k === 1 ? Math.min(.8, l + .15) : Math.max(.22, l - .12));
}
const lum = (hex) => { const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const mixHex = (a, b, t) => {
  const p = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => Math.round(p(a, i) * (1 - t) + p(b, i) * t).toString(16).padStart(2, '0')).join('');
};
/* A color string for ink on top of a fill: works for #rrggbb and the hsl() shades. */
function inkOn(fill) {
  if (fill.startsWith('#')) return lum(fill) > 0.62 ? '#1d2733' : '#ffffff';
  const l = Number(fill.match(/(\d+)%\)$/)?.[1] || 50);
  return l > 62 ? '#1d2733' : '#ffffff';
}

/* ---------- model: everything the poster needs, from data + what is switched on ---------- */
/* What is switched on the first time the page is opened (and for tracks added later): everything that is a span or an
   event. Numeric series start off since there are usually many; with nothing else to show they start on instead.
   A track with config.hidden stays off. After that, what is on is the person's own choice, kept in the browser. */
export function defaultOn(data) {
  const shown = data.tracks.filter((t) => !t.config.hidden);
  const story = shown.filter((t) => t.kind !== 'series');
  return new Set((story.length ? story : shown).map((t) => t.key));
}

/* Which track fills the grid. The person's pick (st.main: a track key, or 'none') wins; otherwise the first switched-on
   span track draws as bars, or failing that the first switched-on numeric track as a heatmap (so showing only "Weight"
   shows a weight heatmap). Returns a track key or null. */
export function resolveMain(data, st) {
  if (st.main === 'none') return null;
  if (st.main && st.on.has(st.main) && data.tracks.some((t) => t.key === st.main)) return st.main;
  const first = data.tracks.find((t) => t.kind === 'span' && st.on.has(t.key)) || data.tracks.find((t) => t.kind === 'series' && st.on.has(t.key));
  return first ? first.key : null;
}
/* How each switched-on track is drawn: bars, heatmap, chart (a thin strip of color along each square), ticks (span starts/ends), dots (events). */
export function rolesOf(data, st) {
  const main = resolveMain(data, st), out = {};
  for (const t of data.tracks) out[t.key] = !st.on.has(t.key) ? '' : t.key === main ? (t.kind === 'series' ? 'heatmap' : 'bars') : t.kind === 'series' ? 'chart' : t.kind === 'event' ? 'dots' : 'ticks';
  return out;
}

export function buildModel(data, st) {
  const birth = dn(data.profile.birth), today = dn(data.today);
  const byKey = new Map(data.tracks.map((t) => [t.key, t]));
  const on = (k) => st.on.has(k);

  const mainKey = resolveMain(data, st);
  const mainT = mainKey ? byKey.get(mainKey) : null;
  const itemsOf = new Map();
  for (const t of data.tracks) itemsOf.set(t.key, []);
  for (const it of data.items) itemsOf.get(it.track)?.push(it);
  for (const [k, list] of itemsOf) { const t = byKey.get(k); list.forEach((it, i) => { it.fill = it.color || shade(t.color, i); it.tk = t; }); }

  const bars = mainT && mainT.kind !== 'series' ? itemsOf.get(mainT.key) : [];
  const markers = [];
  const tickTracks = data.tracks.filter((t) => t.kind !== 'series' && t.key !== mainT?.key && on(t.key));
  const heatMain = mainT && mainT.kind === 'series' ? heatLane(mainT, data.points[mainT.key] || []) : null;
  for (const t of tickTracks) {
    for (const it of itemsOf.get(t.key)) {
      if (t.kind === 'event') markers.push({ d: dn(it.start), type: 'event', color: it.color || t.color, it, t });
      else {
        markers.push({ d: dn(it.start), type: 'start', color: it.color || t.color, it, t });
        if (it.end) markers.push({ d: dn(it.end), type: 'end', color: it.color || t.color, it, t });
      }
    }
  }
  const heat = [];
  for (const t of data.tracks) {
    if (t.kind !== 'series' || !on(t.key)) continue;
    if (t.key !== mainT?.key) heat.push(heatLane(t, data.points[t.key] || []));
  }

  // First and last rows: from the birth year until the fade is gone.
  const firstYear = yearOf(birth);
  const ageNow = (today - birth) / 365.2425;
  let lastYear = yearOf(today);
  const sNow = surv(data.life, ageNow);
  for (let a = ageNow; a < 125; a += 0.25) { if (surv(data.life, a) / sNow >= 0.012) lastYear = yearOf(birth + a * 365.2425); }
  for (const it of data.items) { const e = dn(it.end || it.start); if (yearOf(e) > lastYear && yearOf(e) < firstYear + 130) lastYear = yearOf(e); }
  for (const [k, pts] of Object.entries(data.points)) if (pts.length && on(k)) { const y = Number(pts[pts.length - 1][0].slice(0, 4)); if (y > lastYear && y < firstYear + 130) lastYear = y; }

  // Bars: each gets a lane (overlapping items stack, like a calendar's multi-day events) and a day range.
  const d0 = yearStart(firstYear), d1 = yearStart(lastYear + 1), rows = lastYear - firstYear + 1;
  const sorted = [...bars].sort((x, y) => dn(x.start) - dn(y.start) || x.id - y.id);
  const laneEnd = [];
  const rowDepth = new Uint8Array(rows).fill(1);
  for (const it of sorted) {
    it.ds = dn(it.start); it.de = Math.max(it.ds, dn(it.end || data.today));
    let l = laneEnd.findIndex((e) => e < it.ds); if (l < 0) { l = laneEnd.length; laneEnd.push(0); }
    laneEnd[l] = it.de; it.lane = Math.min(l, 2);
    for (let r = Math.max(0, yearOf(it.ds) - firstYear); r <= Math.min(rows - 1, yearOf(it.de) - firstYear); r++) rowDepth[r] = Math.max(rowDepth[r], it.lane + 1);
  }
  for (const lane of [...(heatMain ? [heatMain] : []), ...heat]) weekly(lane, firstYear, rows);
  return { data, st, birth, today, ageNow, firstYear, lastYear, rows, d0, d1, rowDepth, mainT, heatMain, bars: sorted, markers, heat, life: data.life };
}

/* A numeric track as heat. Counts (chart "bars" or agg "sum") are summed per week and shown in five GitHub-style
   levels, with zero left empty; other series (weight...) are averaged and shown as a continuous ramp.
   Config hints: agg "sum" | "avg" | "max", min, max (top of the scale for one day, and for weekly averages or maxima;
   weekly totals scale themselves), scale "sqrt", hold (days a reading carries), grain "week" (the data is already one
   number per week square, so there are no per-day strips to draw). */
function heatLane(t, pts) {
  const cfg = t.config, counts = cfg.chart === 'bars' || cfg.agg === 'sum';
  const agg = cfg.agg === 'avg' || cfg.agg === 'max' || cfg.agg === 'sum' ? cfg.agg : (counts ? 'sum' : 'avg');
  let vmin = Infinity, vmax = -Infinity; const nz = [];
  for (const p of pts) { if (p[1] < vmin) vmin = p[1]; if (p[1] > vmax) vmax = p[1]; if (p[1] > 0) nz.push(p[1]); }
  const lo = cfg.min != null ? Number(cfg.min) : (counts ? 0 : vmin);
  const hi = cfg.max != null ? Number(cfg.max) : (counts ? p95(nz) : vmax);
  const hold = Math.max(0, Math.min(3650, Number(cfg.hold) || 0));
  const map = new Map();
  pts.forEach((p, i) => {
    const a = dn(p[0]);
    const next = i + 1 < pts.length ? dn(pts[i + 1][0]) : Infinity;
    const stop = Math.min(a + hold, next - 1);
    for (let d = a; d <= stop; d++) map.set(d, p[1]);
  });
  return { t, lo, hi, hiWeek: hi, map, counts, agg, weekly: cfg.grain === 'week', sqrt: cfg.scale === 'sqrt', week: new Map(), total: pts.reduce((n, p) => n + p[1], 0), days: pts.length };
}
/* The top of a count scale: the 95th percentile of the non-zero values, so one huge day doesn't wash out the rest. */
function p95(vals) { if (!vals.length) return 1; const s = [...vals].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; }
/* One value per week square: key = row * 52 + column. */
function weekly(lane, firstYear, rows) {
  const acc = new Map();
  for (const [d, v] of lane.map) {
    const y = yearOf(d), r = y - firstYear; if (r < 0 || r >= rows) continue;
    const k = r * COLS + colOf(d, yearStart(y));
    let a = acc.get(k); if (!a) acc.set(k, a = { sum: 0, n: 0, max: -Infinity });
    a.sum += v; a.n++; if (v > a.max) a.max = v;
  }
  const vals = [];
  for (const [k, a] of acc) { const v = lane.agg === 'sum' ? a.sum : lane.agg === 'max' ? a.max : a.sum / a.n; lane.week.set(k, v); if (v > 0) vals.push(v); }
  // Weekly totals are on a different scale from single days, so they scale themselves; min/max still govern averages and maxima.
  if (lane.agg === 'sum') lane.hiWeek = p95(vals); else lane.hiWeek = lane.hi;
}
const BASE_HEAT = '#e3e8ef', LEVELS = [0, 0.3, 0.52, 0.76, 1];
/* The color of a value: null means "leave the square empty" (a zero count). level is 'week' or 'day'. */
function heatColor(lane, v, level) {
  if (v == null) return null;
  const hi = level === 'week' ? lane.hiWeek : lane.hi;
  let t = hi > lane.lo ? clampN((v - lane.lo) / (hi - lane.lo), 0, 1) : 1;
  if (lane.sqrt) t = Math.sqrt(t);
  if (lane.counts) return v > 0 ? mixHex(BASE_HEAT, lane.t.color, LEVELS[Math.max(1, Math.ceil(t * 4))]) : null;
  return mixHex(BASE_HEAT, lane.t.color, 0.2 + 0.8 * t);
}

/* Chance of being alive at an age, from the server's survival curve. */
function surv(life, age) {
  const x = Math.max(0, age) / life.step, i = Math.floor(x), c = life.curve;
  if (i >= c.length - 1) return c[c.length - 1];
  return c[i] + (c[i + 1] - c[i]) * (x - i);
}
/* How visible a day is: fully for the past, then fading with the chance of still being here. */
function dayAlpha(M, d) {
  if (d <= M.today) return 1;
  return surv(M.life, (d - M.birth) / 365.2425) / surv(M.life, M.ageNow);
}

/* ---------- layout, in whole device pixels ---------- */
const COLS = 52;                       // weeks per row; the last square of a year also holds its 1-2 leftover days
const mctx = document.createElement('canvas').getContext('2d');
const tw = (s, px, weight = 400) => { mctx.font = `${weight} ${px}px ${FONT}`; return mctx.measureText(s).width; };
const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
/* Sizes that scale with pixel density: n CSS pixels, in whole device pixels. */
const cssPx = (D) => (n) => Math.max(1, Math.round(n * D));

/* W: canvas width in device pixels. D: device pixels per CSS pixel (may be fractional).
   zoom: a square size in CSS px, 'fit' (the largest: the grid fills the width, so there is never sideways scrolling),
   or null for the default (up to 26 CSS px). The squares are never larger than fit.
   title: draw the name, age and day count above the grid. Only the saved image does; on the page that lives in the page header. */
export function plan(M, W, D, zoom = null, title = false) {
  const css = cssPx(D), narrow = W / D < 700;
  const padX = css(narrow ? 12 : 28), gutL = css(narrow ? 30 : 40), gutR = css(narrow ? 32 : 44);
  const avail = Math.max(COLS, W - 2 * padX - gutL - gutR);
  const fitPitch = Math.max(1, Math.floor(avail / COLS));
  const want = zoom === 'fit' ? fitPitch : zoom == null ? css(26) : Math.round(zoom * D);
  const pitch = clampN(want, 1, fitPitch);                      // one square, gap included
  const gridW = pitch * COLS;
  const bx = padX + Math.floor((avail - gridW) / 2);            // content block, centered when squares are smaller than fit
  const bw = gutL + gridW + gutR, gridX = bx + gutL;
  const gap = M.st.layers.grid && pitch >= 4 ? Math.max(1, Math.round(pitch / 8)) : 0;
  const cell = pitch - gap;                                      // the filled square
  const ins = Math.max(1, Math.round(cell * 0.1));               // bars sit slightly inside their squares
  const R = Math.max(1, Math.min(Math.round(cell * 0.28), Math.floor((cell - 2 * ins) / 2)));   // the one corner radius
  const Rcell = gap ? R : 0;                                     // with gaps off the squares run together as plain filled blocks
  const rowY0 = css(title ? 18 : 6) + (title ? (narrow ? css(59) : css(64)) : 0) + css(22);   // the last 22 is the month labels
  const gridH = M.rows * pitch;

  // Heat strips live inside each square along its bottom edge; only when squares are big enough to hold them.
  const heatOK = pitch >= css(12) && M.heat.length > 0;
  const heat = heatOK ? M.heat : [];
  const hh = Math.max(2, Math.round(cell * 0.14)), hg = Math.max(1, Math.round(D / 2));
  const heatBlock = heat.length ? heat.length * (hh + hg) : 0;
  // A heatmap main track shows each of a square's 7 days as a thin strip when there is room for them.
  const stripW = Math.floor((cell - 6) / 7), strips = !!M.heatMain && !M.heatMain.weekly && stripW >= 4;

  // Legend
  const fL = css(narrow ? 12 : 10.5), rowL = Math.round(fL * 1.55);
  const keys = [];
  const seen = new Set();
  for (const mk of M.markers) if (!seen.has(mk.t.key)) { seen.add(mk.t.key); keys.push({ kind: 'mark', t: mk.t, label: `${mk.t.kind === 'event' ? '◆' : '▶ start  ◀ end'}  ${mk.t.name}`, w: 0 }); }
  const gradW = css(48);
  const rampW = (lane) => (lane.counts ? 5 * css(11) : gradW);
  for (const lane of [...(M.heatMain ? [M.heatMain] : []), ...heat]) {
    const u = lane.t.config.unit ? ' ' + lane.t.config.unit : '';
    keys.push({ kind: 'heat', lane, label: lane.t.name, range: `${fmt(lane.lo)} → ${fmt(lane.hiWeek)}${u}${lane.agg === 'sum' ? ' / week' : lane.agg === 'max' ? ' (weekly max)' : ' (weekly avg)'}`, w: 0 });
  }
  const gx = css(18);
  for (const k of keys) k.w = k.kind === 'mark' ? tw(k.label, fL, 650) : tw(k.label, fL, 650) + css(8) + rampW(k.lane) + css(6) + tw(k.range, fL - 1);
  const keyRows = [[]]; let kx = 0;
  for (const k of keys) { if (kx > 0 && kx + k.w > bw) { keyRows.push([]); kx = 0; } k.x = kx; keyRows[keyRows.length - 1].push(k); kx += k.w + gx; }
  if (!keys.length) keyRows[0].push({ kind: 'none', x: 0, w: 0 });
  const legCols = clampN(Math.floor(bw / css(narrow ? 300 : 330)), 1, 4);
  const shown = M.bars.slice(0, 160);
  const legRows = Math.ceil(shown.length / legCols);
  const notes = ['One row per year · one square per week'];
  if (M.heatMain) {
    const hm = M.heatMain;
    notes.push(`Each square is its week's ${hm.agg === 'sum' ? 'total' : hm.agg === 'max' ? 'highest value' : 'average'}${hm.weekly ? '' : strips ? '; each square also shows its 7 days' : '; zoom in to see each day'} · ${hm.days.toLocaleString('en-US')} ${hm.weekly ? 'weeks' : 'days'} recorded`);
  }
  if (M.st.layers.fade) notes.push(`Fading with life expectancy (about ${Math.round(M.data.life.life.expectancy)})`);
  if (M.heat.length && !heatOK) notes.push('Small charts along each square appear when squares are larger');
  notes.push('bigpicture.io27.com');
  const legendTop = rowY0 + gridH + css(20);
  const H = legendTop + css(14) + keyRows.length * rowL + (shown.length ? css(8) + rowL + legRows * rowL + (M.bars.length > shown.length ? rowL : 0) : 0) + css(10) + notes.length * rowL + css(14);

  return { W, H, D, css, narrow, title, cols: COLS, pitch, fitPitch, cell, gap, ins, R, Rcell, gridX, gridW, bx, bw, rowY0, gridH, heat, hh, hg, heatBlock, strips, stripW,
    fL, rowL, keyRows, legCols, shown, legRows, notes, legendTop, gx, gradW, padX, gutL, gutR, rowY: (r) => rowY0 + r * pitch };
}

/* ---------- squares: a week each; the last of the year also takes the 1-2 leftover days ---------- */
const cellRange = (ys, ye, c) => [ys + c * 7, c === COLS - 1 ? ye - 1 : ys + c * 7 + 6];
const colOf = (d, ys) => Math.min(COLS - 1, Math.floor((d - ys) / 7));

/* ---------- text, centered exactly ---------- */
// Text is centered by its cap height (the height of "H"), the way type is optically centered in a button, and the
// baseline lands on a whole pixel. The font size is nudged by a device pixel when needed so the space above and
// below the capitals is equal rather than off by a half pixel.
// Glyph bounds that measureText reports at small sizes are rounded outward, so the cap height is measured once at a
// large size (where rounding doesn't matter) and scaled.
const capRatio = new Map();
function capRaw(px, weight) {
  let r = capRatio.get(weight);
  if (r == null) { mctx.font = `${weight} 1000px ${FONT}`; r = mctx.measureText('H').actualBoundingBoxAscent / 1000; capRatio.set(weight, r); }
  return Math.max(1, r * px);
}
const capH = (px, weight) => Math.max(1, Math.round(capRaw(px, weight)));
/* Fits a label's capitals into a box h tall with equal space above and below, on whole pixels. Looks at the sizes
   just under the target; for each, picks the whole-pixel cap height (of matching parity, so the margins are equal)
   nearest the font's real cap height, and returns the size whose small vertical stretch (sy, usually under 4%) is least. */
function centeredFont(target, h, weight) {
  let best = null;
  for (let f = Math.max(1, target); f >= Math.max(1, target - 3); f--) {
    const raw = capRaw(f, weight);
    let cap = Math.round(raw);
    if ((h - cap) % 2 !== 0) cap = Math.abs(raw - (cap + 1)) < Math.abs(raw - (cap - 1)) ? cap + 1 : cap - 1;
    cap = Math.max(1, cap);
    const sy = cap / raw, cost = Math.abs(sy - 1) + (target - f) * 0.015;
    if (!best || cost < best.cost) best = { px: f, sy, cap, cost };
  }
  return best;
}
/* Draws s with its capitals exactly centered in the box [y, y + h): integer baseline, cap height a whole number of pixels. */
function textInBox(ctx, s, x, y, h, spec, color, { weight = 400, align = 'left' } = {}) {
  ctx.font = `${weight} ${spec.px}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.save(); ctx.translate(Math.round(x), Math.round(y) + Math.floor((h + spec.cap) / 2)); ctx.scale(1, spec.sy); ctx.fillText(s, 0, 0); ctx.restore();
}

/* ---------- drawing ---------- */
function text(ctx, s, x, y, px, color, { weight = 400, align = 'left', base = 'alphabetic' } = {}) {
  ctx.font = `${weight} ${px}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(s, Math.round(x), Math.round(y));
}
const fit = (s, px, weight, maxW) => { if (tw(s, px, weight) <= maxW) return s; let t = s; while (t.length > 1 && tw(t + '…', px, weight) > maxW) t = t.slice(0, -1); return t + '…'; };
/* Rounded rectangle with separate radii; works in every browser. r = [topLeft, topRight, bottomRight, bottomLeft] */
function pill(ctx, x, y, w, h, [tl, tr, br, bl]) {
  ctx.beginPath(); ctx.moveTo(x + tl, y); ctx.lineTo(x + w - tr, y); if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br); if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h); if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl); if (tl) ctx.arcTo(x, y, x + tl, y, tl); ctx.closePath(); ctx.fill();
}

export function drawPoster(canvas, M, P) {
  const { W, H, css, pitch, cell, gridX, ins, narrow } = P;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
  const { data, st } = M;
  const fade = st.layers.fade, dpx = P.D;
  let lastA = -1;
  const setAlpha = (a) => { const q = Math.round(a * 50); if (q !== lastA) { ctx.globalAlpha = q / 50; lastA = q; } };
  const solid = () => { ctx.globalAlpha = 1; lastA = -1; };
  const alphaAt = (d) => (fade ? dayAlpha(M, Math.max(M.birth, d)) : 1);

  /* Title: only in the saved image (the page shows it in its own header) */
  if (P.title) {
    const top = css(18), name = data.profile.name || 'My life';
    const ageDays = M.today - M.birth;
    if (narrow) {
      text(ctx, `${name}’s big picture`, P.bx, top + css(21), css(21), C.ink, { weight: 750 });
      text(ctx, `Born ${prettyDate(data.profile.birth)} · age ${Math.floor(M.ageNow)} · day ${ageDays.toLocaleString('en-US')}`, P.bx, top + css(42), css(11.5), C.soft);
    } else {
      text(ctx, `${name}’s big picture`, P.bx, top + css(24), css(26), C.ink, { weight: 750 });
      text(ctx, `Born ${prettyDate(data.profile.birth)}  ·  age ${Math.floor(M.ageNow)}  ·  day ${ageDays.toLocaleString('en-US')}`, P.bx, top + css(46), css(12), C.soft);
    }
  }

  /* Month header */
  if (st.layers.months) {
    const letters = (pitch * 4.3) / dpx < 24;
    for (let m = 0; m < 12; m++) {
      const x = gridX + Math.min(COLS - 1, Math.floor(MONTH_COL[m] / 7)) * pitch;
      ctx.fillStyle = C.faint; ctx.fillRect(x, P.rowY0 - css(8), Math.max(1, Math.round(dpx / 2)), css(6));
      text(ctx, letters ? MON[m][0] : MON[m], x + css(3), P.rowY0 - css(11), css(9.5), C.soft, { weight: 600 });
    }
  }

  /* Which bar pieces sit in which row */
  const pieces = Array.from({ length: M.rows }, () => []);
  for (const it of M.bars) {
    for (let r = Math.max(0, yearOf(it.ds) - M.firstYear); r <= Math.min(M.rows - 1, yearOf(it.de) - M.firstYear); r++) {
      const ys = yearStart(M.firstYear + r), ye = yearStart(M.firstYear + r + 1);
      const startsHere = it.ds >= ys, endsHere = it.de < ye;
      pieces[r].push({ it, c0: startsHere ? colOf(it.ds, ys) : 0, c1: endsHere ? colOf(it.de, ys) : COLS - 1, startsHere, endsHere, d0: Math.max(it.ds, ys), d1: Math.min(it.de, ye - 1) });
    }
  }

  // Lanes are decided within each row: bars that share a day in that row stack, and everything else sits in the top
  // lane. (A bar that had to sit lower in one year because of an overlap drops back up once nothing overlaps it.)
  const rowDepth = new Uint8Array(M.rows).fill(1);
  for (let r = 0; r < M.rows; r++) {
    const ends = [];
    for (const pc of pieces[r].sort((a, b) => a.d0 - b.d0 || a.it.id - b.it.id)) {
      let l = ends.findIndex((e) => e < pc.d0); if (l < 0) { l = ends.length; ends.push(0); }
      ends[l] = pc.d1; pc.lane = Math.min(l, 2);
      rowDepth[r] = Math.max(rowDepth[r], pc.lane + 1);
    }
  }

  /* Rows: squares (or the heatmap), bars inset over them, heat strips */
  const stepFor = (fontPx) => { for (const s of [1, 2, 5, 10]) if (s * pitch >= fontPx * 1.25) return s; return 10; };
  const fYear = centeredFont(css(9), cell, 400), fYearB = centeredFont(css(9), cell, 700);
  const yStep = stepFor(fYear.px), aStep = Math.max(5, yStep);
  // One corner radius for everything: the squares, the ends of bars and the today square all match.
  const R = P.R;
  const EMPTY = 0.7;   // empty gray squares are a little fainter than anything with data in it
  const todayRow = yearOf(M.today) - M.firstYear;
  const placed = new Map();   // bar item -> its pieces on screen, for labels
  const lane0 = M.heatMain;
  for (let r = 0; r < M.rows; r++) {
    const year = M.firstYear + r, ys = yearStart(year), ye = yearStart(year + 1);
    const y = P.rowY(r);
    if (fade && ys > M.today && dayAlpha(M, ys) < 0.012) break;
    const labA = fade ? clampN(dayAlpha(M, ys + 180) * 1.4, 0.25, 1) : 1;
    ctx.globalAlpha = labA; lastA = -1;
    if (r % yStep === 0) textInBox(ctx, String(year), gridX - css(5), y, cell, r % 5 === 0 ? fYearB : fYear, r % 5 === 0 ? C.ink : C.soft, { weight: r % 5 === 0 ? 700 : 400, align: 'right' });
    if (r % aStep === 0 && !(st.layers.today && Math.abs(r - todayRow) * pitch < css(14))) textInBox(ctx, String(r), gridX + P.gridW + css(5), y, cell, fYearB, C.soft, { weight: 700 });
    solid();

    // squares, except under bars; in a heatmap they carry the week's value
    // A square hides under bars only when bars cover all of its days; a square shared by two bars that meet in it
    // (one ends, the next starts, no day in common) stays visible underneath them.
    const dayCov = new Uint8Array(ye - ys);
    for (const pc of pieces[r]) for (let d = pc.d0; d <= pc.d1; d++) dayCov[d - ys] = 1;
    const fullyCovered = (a, b) => { if (!pieces[r].length) return false; for (let d = a; d <= b; d++) if (!dayCov[d - ys]) return false; return true; };
    for (let c = 0; c < COLS; c++) {
      const [a, b] = cellRange(ys, ye, c);
      if (b < M.birth || fullyCovered(a, b)) continue;
      const alpha = alphaAt((a + b) >> 1); if (alpha < 0.012) break;
      const x = gridX + c * pitch;
      const wk = lane0 ? lane0.week.get(r * COLS + c) : undefined;
      const hc = lane0 && !P.strips ? heatColor(lane0, wk, 'week') : null;
      setAlpha(hc ? alpha : alpha * EMPTY); ctx.fillStyle = hc || (a <= M.today ? C.past : C.future);
      if (P.Rcell) pill(ctx, x, y, cell, cell, [R, R, R, R]); else ctx.fillRect(x, y, cell, cell);
      if (P.strips && wk != null) {            // the week's seven days, side by side
        setAlpha(alpha);
        const total = 7 * P.stripW + 6, off = Math.floor((cell - total) / 2);
        for (let k = 0; k < 7; k++) {
          const dc = heatColor(lane0, lane0.map.get(a + k), 'day'); if (!dc) continue;
          ctx.fillStyle = dc; ctx.fillRect(x + off + k * (P.stripW + 1), y + ins, P.stripW, cell - 2 * ins);
        }
      }
    }

    // bars: slightly inset pills; overlapping items share the square's height. Squares in the row never change size.
    const depth = rowDepth[r], laneGap = Math.max(1, Math.round(ins / 2));
    const usable = cell - 2 * ins - P.heatBlock;
    const laneH = Math.max(1, Math.floor((usable - (depth - 1) * laneGap) / depth));
    const radius = Math.max(1, Math.min(R, Math.floor(laneH / 2)));
    for (const pc of pieces[r]) {
      const { it } = pc;
      // Bars start and end on their actual day inside a week square, so two bars that meet within one week (the first
      // ends, the next starts on a later day) sit side by side with a gap instead of overlapping.
      const weekLen = (c) => (c === COLS - 1 ? ye - (ys + c * 7) : 7);
      const x0 = pc.startsHere ? gridX + pc.c0 * pitch + Math.round(((pc.d0 - (ys + pc.c0 * 7)) / weekLen(pc.c0)) * cell) + ins : gridX;
      const x1 = pc.endsHere ? gridX + pc.c1 * pitch + Math.round(((pc.d1 - (ys + pc.c1 * 7) + 1) / weekLen(pc.c1)) * cell) - ins : gridX + (COLS - 1) * pitch + cell;
      const py = y + ins + pc.lane * (laneH + laneGap), pw = Math.max(1, x1 - x0);
      const alpha = alphaAt(ys + Math.round(((pc.c0 + pc.c1) / 2) * 7));
      setAlpha(alpha); ctx.fillStyle = it.fill;
      const rr = Math.min(radius, Math.floor(pw / 2));
      pill(ctx, x0, py, pw, laneH, [pc.startsHere ? rr : 0, pc.endsHere ? rr : 0, pc.endsHere ? rr : 0, pc.startsHere ? rr : 0]);
      let arr = placed.get(it); if (!arr) placed.set(it, arr = []);
      arr.push({ x0, pw, py, laneH, alpha });
    }

    // heat strips along the bottom of each square (secondary numeric tracks)
    P.heat.forEach((lane, i) => {
      const sy = y + cell - ins - (P.heat.length - i) * P.hh - (P.heat.length - 1 - i) * P.hg;
      for (let c = 0; c < COLS; c++) {
        const [a, b] = cellRange(ys, ye, c); if (b < M.birth) continue;
        const col = heatColor(lane, lane.week.get(r * COLS + c), 'week'); if (!col) continue;
        const alpha = alphaAt((a + b) >> 1); if (alpha < 0.012) break;
        setAlpha(alpha); ctx.fillStyle = col;
        ctx.fillRect(gridX + c * pitch + ins, sy, cell - 2 * ins, P.hh);
      }
    });
  }
  solid();

  /* Bar labels. Each bar's name is bold and sits at the start of the bar. Inside the bar when it is tall enough;
     otherwise as text with a white halo over the start of the bar. Long bars repeat the name every few rows. */
  if (st.layers.labels && placed.size) {
    const boxes = [], gridR = gridX + P.gridW, weight = 700;
    const fontFor = (s) => { const f = centeredFont(Math.min(css(13), Math.round(s.laneH * 0.66)), s.laneH, weight); return f.px >= css(8.5) ? f : null; };
    const padOf = (s) => Math.max(css(5), Math.round(s.laneH * 0.4));
    const inside = (it, s, f, label) => { ctx.globalAlpha = s.alpha; textInBox(ctx, label, s.x0 + padOf(s), s.py, s.laneH, f, inkOn(it.fill), { weight }); };
    for (const it of M.bars) {
      const segs = placed.get(it); if (!segs || !it.label) continue;
      let done = -1;
      for (let i = 0; i < Math.min(segs.length, 4); i++) {          // the start, or the first of the next rows where it fits whole
        const s = segs[i], f = fontFor(s); if (!f) break;
        if (tw(it.label, f.px, weight) + padOf(s) + css(4) <= s.pw) { inside(it, s, f, it.label); done = i; break; }
      }
      if (done < 0) { const s = segs[0], f = fontFor(s); if (f && s.pw >= css(44)) { inside(it, s, f, fit(it.label, f.px, weight, s.pw - padOf(s) - css(4))); done = 0; } }
      if (done >= 0) {
        for (let j = done + 4; j < segs.length; j += 4) { const s = segs[j], f = fontFor(s); if (f && tw(it.label, f.px, weight) + padOf(s) + css(4) <= s.pw) inside(it, s, f, it.label); }
      } else {                                                       // squares too small for text inside: haloed text at the start
        const s = segs[0], f = css(10), w = tw(it.label, f, weight), ch = capH(f, weight);
        const x = clampN(s.x0 + css(3), gridX, gridR - w), base = Math.round(s.py + s.laneH / 2 + ch / 2);
        const box = [x - css(2), base - ch - css(2), w + css(4), ch + css(4)];
        if (boxes.some((b) => box[0] < b[0] + b[2] && box[0] + box[2] > b[0] && box[1] < b[1] + b[3] && box[1] + box[3] > b[1])) continue;
        boxes.push(box);
        ctx.globalAlpha = s.alpha; ctx.font = `${weight} ${f}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, Math.round(css(3))); ctx.strokeStyle = '#fff'; ctx.strokeText(it.label, x, base);
        ctx.fillStyle = C.ink; ctx.fillText(it.label, x, base);
      }
    }
    solid();
  }

  /* Markers, in the square of their date: ◆ event, ▶ start, ◀ end, with a white edge so they read over bars */
  const ms = clampN(Math.round(cell * 0.5), 3, css(10));
  const edge = Math.max(1, Math.round(dpx * 0.75));
  for (const mk of M.markers) {
    if (mk.d < M.birth || mk.d < M.d0 || mk.d >= M.d1) continue;
    const year = yearOf(mk.d), r = year - M.firstYear, ys = yearStart(year);
    const alpha = alphaAt(mk.d); if (alpha < 0.05) continue;
    const cx = gridX + colOf(mk.d, ys) * pitch + cell / 2, cy = P.rowY(r) + cell / 2;
    ctx.globalAlpha = Math.min(1, alpha * 1.2); ctx.fillStyle = mk.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = edge; ctx.lineJoin = 'round'; ctx.beginPath();
    if (mk.type === 'start') { ctx.moveTo(cx - ms / 2, cy - ms / 2); ctx.lineTo(cx + ms / 2, cy); ctx.lineTo(cx - ms / 2, cy + ms / 2); }
    else if (mk.type === 'end') { ctx.moveTo(cx + ms / 2, cy - ms / 2); ctx.lineTo(cx - ms / 2, cy); ctx.lineTo(cx + ms / 2, cy + ms / 2); }
    else { ctx.moveTo(cx, cy - ms / 2); ctx.lineTo(cx + ms / 2, cy); ctx.lineTo(cx, cy + ms / 2); ctx.lineTo(cx - ms / 2, cy); }
    ctx.closePath(); ctx.stroke(); ctx.fill();
  }
  solid();

  /* Today: its square, outlined and lit */
  if (st.layers.today && M.today >= M.birth) {
    const ty = yearOf(M.today), r = ty - M.firstYear, ys = yearStart(ty);
    const x = gridX + colOf(M.today, ys) * pitch, y = P.rowY(r), t = Math.max(1, Math.round(dpx * 1.25));
    const Rt = P.Rcell ? P.Rcell : 0;
    ctx.fillStyle = C.ring; pill(ctx, x - t, y - t, cell + 2 * t, cell + 2 * t, [Rt ? Rt + t : 0, Rt ? Rt + t : 0, Rt ? Rt + t : 0, Rt ? Rt + t : 0]);
    ctx.fillStyle = '#ffd23f'; pill(ctx, x, y, cell, cell, [Rt, Rt, Rt, Rt]);
    const ft = centeredFont(css(narrow ? 8 : 9), cell, 700);
    textInBox(ctx, '◂ today', gridX + P.gridW + css(4), y, cell, ft, C.ink, { weight: 700 });
  }

  drawLegend(ctx, M, P);
}

function drawLegend(ctx, M, P) {
  const { css, fL, rowL, bx, bw } = P;
  let y = P.legendTop;
  ctx.fillStyle = C.faint; ctx.fillRect(bx, y, bw, Math.max(1, Math.round(P.D / 2)));
  y += css(14);
  for (const row of P.keyRows) {
    const by = y + Math.round(rowL * 0.7);
    for (const k of row) {
      const x = bx + k.x;
      if (k.kind === 'mark') text(ctx, k.label, x, by, fL, k.t.color, { weight: 650 });
      else if (k.kind === 'heat') {
        text(ctx, k.label, x, by, fL, C.ink, { weight: 650 });
        let gx = x + tw(k.label, fL, 650) + css(8);
        const sh = Math.round(fL * 0.9), sy = by - Math.round(fL * 0.8);
        if (k.lane.counts) {            // five levels, like a contribution calendar
          const sw = css(11) - css(2);
          for (let i = 0; i < 5; i++) { ctx.globalAlpha = i === 0 ? 0.7 : 1; ctx.fillStyle = i === 0 ? C.past : mixHex(BASE_HEAT, k.lane.t.color, LEVELS[i]); ctx.fillRect(gx + i * css(11), sy, sw, sh); }
          ctx.globalAlpha = 1;
          gx += 5 * css(11) + css(6);
        } else {
          const n = 24, cwg = Math.max(1, Math.floor(P.gradW / n));
          for (let i = 0; i < n; i++) { ctx.fillStyle = mixHex(BASE_HEAT, k.lane.t.color, 0.2 + 0.8 * (i / (n - 1))); ctx.fillRect(gx + i * cwg, sy, cwg, sh); }
          gx += n * cwg + css(6);
        }
        text(ctx, k.range, gx, by, fL - 1, C.soft);
      } else text(ctx, 'No other tracks shown', x, by, fL, C.faint);
    }
    y += rowL;
  }
  if (P.shown.length) {
    y += css(8);
    text(ctx, M.mainT.name.toUpperCase(), bx, y + Math.round(rowL * 0.7), fL - 1, C.soft, { weight: 700 }); y += rowL;
    const colW = Math.floor(bw / P.legCols);
    P.shown.forEach((it, i) => {
      const col = Math.floor(i / P.legRows), row = i % P.legRows;
      const lx = bx + col * colW, by = y + row * rowL + Math.round(rowL * 0.7);
      const sw = Math.round(fL * 0.8); ctx.fillStyle = it.fill; pill(ctx, lx, by - sw + Math.round(fL * 0.1), sw, sw, [css(2), css(2), css(2), css(2)]);
      const label = it.label || '(untitled)', rng = shortRange(it.start, it.end), tx = lx + sw + css(5);
      const maxLabel = colW - (tx - lx) - css(8);
      const rngW = tw(rng, fL - 1);
      const lab = fit(label, fL, 650, Math.max(css(60), maxLabel - rngW - css(6)));
      text(ctx, lab, tx, by, fL, C.ink, { weight: 650 });
      const rx = tx + tw(lab, fL, 650) + css(6);
      if (rx + rngW <= lx + colW) text(ctx, rng, rx, by, fL - 1, C.soft);
    });
    y += P.legRows * rowL;
    if (M.bars.length > P.shown.length) { text(ctx, `+ ${M.bars.length - P.shown.length} more`, bx, y + Math.round(rowL * 0.7), fL - 1, C.soft); y += rowL; }
  }
  y += css(10);
  P.notes.forEach((n, i) => { text(ctx, n, bx, y + Math.round(rowL * 0.7), fL - 1, i === P.notes.length - 1 ? C.faint : C.soft); y += rowL; });
}
const fmt = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 10) / 10));

/* ---------- hover / tap: what is at a device-pixel point on the poster ---------- */
/* Which week square (row r, column c) a device-pixel point is in, if it is a square that is drawn. */
export function cellAt(M, P, x, y) {
  const c = Math.floor((x - P.gridX) / P.pitch), r = Math.floor((y - P.rowY0) / P.pitch);
  if (c < 0 || c >= COLS || r < 0 || r >= M.rows) return null;
  const [, b] = cellRange(yearStart(M.firstYear + r), yearStart(M.firstYear + r + 1), c);
  return b < M.birth ? null : { r, c };
}
/* Draws the outline around one square on a transparent overlay canvas the same size as the poster: a dark ring
   just outside the square with a white ring outside that, so it shows over bars, gray squares and fades alike. */
export function drawCellOutline(canvas, P, cell) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!cell) return;
  const t = Math.max(1, Math.round(P.D * 1.5));
  const x = P.gridX + cell.c * P.pitch, y = P.rowY(cell.r), n = P.cell;
  const ring = (off, width, color) => {                    // a ring whose inner edge is `off` outside the square
    const o = off + width / 2, r = P.Rcell ? P.Rcell + o : 0;
    ctx.beginPath(); ctx.moveTo(x - o + r, y - o);
    ctx.arcTo(x + n + o, y - o, x + n + o, y + n + o, r); ctx.arcTo(x + n + o, y + n + o, x - o, y + n + o, r);
    ctx.arcTo(x - o, y + n + o, x - o, y - o, r); ctx.arcTo(x - o, y - o, x + n + o, y - o, r); ctx.closePath();
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
  };
  ring(t, t, '#ffffff'); ring(0, t, '#111a24');
}
export function whatsAt(M, P, x, y) {
  const c = Math.floor((x - P.gridX) / P.pitch), r = Math.floor((y - P.rowY0) / P.pitch);
  if (c < 0 || c >= COLS || r < 0 || r >= M.rows) return null;
  const ys = yearStart(M.firstYear + r), ye = yearStart(M.firstYear + r + 1);
  const [a, b] = cellRange(ys, ye, c);
  if (b < M.birth) return null;
  const from = Math.max(a, M.birth), date = dnToStr(from);
  const out = { date, weekTo: dnToStr(b), age: ageString(M.birth, from), day: from - M.birth, future: from > M.today, lines: [] };
  const { data, st } = M;
  for (const t of data.tracks) {
    if (!st.on.has(t.key) || t.kind === 'series') continue;
    for (const it of data.items) {
      if (it.track !== t.key) continue;
      const s = dn(it.start), e = it.end ? dn(it.end) : (t.kind === 'event' ? s : Math.max(s, M.today));
      if (s <= b && e >= a) out.lines.push({ color: it.fill || t.color, track: t.name, label: it.label, range: t.kind === 'event' ? shortRange(it.start, null).replace(' –', '') : shortRange(it.start, it.end), attrs: it.attrs });
    }
  }
  for (const t of data.tracks) {
    if (!st.on.has(t.key) || t.kind !== 'series') continue;
    const vals = (data.points[t.key] || []).filter((q) => { const d = dn(q[0]); return d >= a && d <= b; });
    if (!vals.length) continue;
    const counts = t.config.chart === 'bars' || t.config.agg === 'sum';
    const agg = t.config.agg === 'avg' || t.config.agg === 'max' || t.config.agg === 'sum' ? t.config.agg : (counts ? 'sum' : 'avg');
    const nums = vals.map((q) => q[1]);
    const v = agg === 'sum' ? nums.reduce((x, y) => x + y, 0) : agg === 'max' ? Math.max(...nums) : nums.reduce((x, y) => x + y, 0) / nums.length;
    const u = t.config.unit ? ' ' + t.config.unit : '';
    const days = {}; for (const q of vals) days[prettyDate(q[0]).slice(0, -6)] = fmt(q[1]);
    out.lines.push({ color: t.color, track: t.name, label: `${fmt(v)}${u}`, range: t.config.grain === 'week' ? 'for the week' : vals.length > 1 ? `${agg === 'sum' ? 'total' : agg === 'max' ? 'highest' : 'average'} of ${vals.length} days` : '', attrs: vals.length > 1 && t.config.grain !== 'week' ? days : {} });
  }
  return out;
}
export function ageString(birth, d) {
  const b = new Date(birth * MS), t = new Date(d * MS);
  let y = t.getUTCFullYear() - b.getUTCFullYear(), m = t.getUTCMonth() - b.getUTCMonth();
  if (t.getUTCDate() < b.getUTCDate()) m--;
  if (m < 0) { y--; m += 12; }
  return y > 0 ? `${y}y ${m}m` : `${m}m`;
}
