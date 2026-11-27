// The timeline: every switched-on track on ONE shared time axis.
//   - one Gantt chart: spans are bars, events are diamond milestones, all stacked together into the fewest lanes
//     (first-fit, in start order, like any calendar or project plan);
//   - one thin band per switched-on number series (a line, or bars for counts), each with its own vertical scale;
//   - an overview strip with the visible window; zooming or panning moves the window for EVERYTHING at once;
//   - hovering draws one crosshair through every band and lists what is under it.
// Nothing here edits data; it only draws it. Drawn on a canvas in CSS pixels scaled by the device ratio.

import { dn, dnToStr, prettyDate, ageString, FONT } from './poster.js';

const MS = 864e5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const INK = '#26323f', SOFT = '#6f7b8a', FAINT = '#b9c1cc', GRID = '#e8ebf0', STRIPE = '#f6f8fa', PAPER = '#ffffff', ACCENT = '#3d6fd1';
const LANE_H = 16, BAR_H = 12, BAND_H = 44, BAND_GAP = 2, OVER_H = 26, AXIS_H = 20, MIN_SPAN = 10;

/* ---------- small helpers ---------- */
const utc = (y, m, d = 1) => Date.UTC(y, m, d) / MS;
const ymd = (n) => { const t = new Date(n * MS); return [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()]; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtNum = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 10) / 10));
const fmtVal = (n, unit) => (unit === '$' ? (n < 0 ? '-$' : '$') + fmtNum(Math.abs(n)) : fmtNum(n) + (unit ? ' ' + unit : ''));
const monYear = (n) => { const [y, m] = ymd(n); return `${MON[m]} ${y}`; };
const dayStr = (n) => prettyDate(dnToStr(Math.floor(n)));
/* Ink for text on a fill: works for #rrggbb and hsl() colors. */
function inkOn(fill) {
  let l;
  if (fill.startsWith('#')) l = (0.299 * parseInt(fill.slice(1, 3), 16) + 0.587 * parseInt(fill.slice(3, 5), 16) + 0.114 * parseInt(fill.slice(5, 7), 16)) / 255 * 100;
  else l = Number(fill.match(/(\d+)%\)$/)?.[1] || 50);
  return l > 62 ? '#1d2733' : '#ffffff';
}
function niceCeil(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
/* Cut a string to fit a pixel width, with an ellipsis. */
function fit(ctx, s, w) {
  if (w <= 0) return '';
  if (ctx.measureText(s).width <= w) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, mid) + '…').width <= w) lo = mid; else hi = mid - 1; }
  return lo > 0 ? s.slice(0, lo) + '…' : '';
}

/* ---------- series: sorted arrays, kind, aggregation, buckets ---------- */
const prepped = new WeakMap();
function prep(pts) {
  let p = prepped.get(pts); if (p) return p;
  const rows = [...pts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const d = new Float64Array(rows.length), v = new Float64Array(rows.length);
  rows.forEach((r, i) => { d[i] = dn(r[0]); v[i] = r[1]; });
  const gaps = []; for (let i = 1; i < d.length; i++) gaps.push(d[i] - d[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[gaps.length >> 1] : 1;
  p = { d, v, brk: Math.max(45, median * 10) };   // a gap longer than this breaks a line instead of joining across it
  prepped.set(pts, p); return p;
}
const isBars = (t) => t.config.chart === 'bars' || t.config.agg === 'sum';
const aggOf = (t) => (t.config.agg === 'avg' || t.config.agg === 'max' || t.config.agg === 'sum' ? t.config.agg : isBars(t) ? 'sum' : 'avg');
const nativeDays = (t) => (t.config.grain === 'week' ? 7 : 1);
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

const BUCKETS = [['day', 1], ['week', 7], ['month', 30.44], ['quarter', 91.3], ['year', 365.25]];
function bucketStart(d, b, native) {
  if (b === 'native') return d;
  if (b === 'day') return d;
  if (b === 'week') return d - (((d + 3) % 7) + 7) % 7;
  const [y, m] = ymd(d);
  return b === 'month' ? utc(y, m) : b === 'quarter' ? utc(y, m - (m % 3)) : utc(y, 0);
}
function bucketEnd(s, b, native) {
  if (b === 'native') return s + native;
  if (b === 'day') return s + 1;
  if (b === 'week') return s + 7;
  const [y, m] = ymd(s);
  return b === 'month' ? utc(y, m + 1) : b === 'quarter' ? utc(y, m + 3) : utc(y + 1, 0);
}
/* The finest bucket whose bars are at least ~3.5px wide, never finer than the data itself. */
function pickBucket(t, pxPerDay) {
  const native = nativeDays(t);
  const list = native === 7 ? [['native', 7], ...BUCKETS.slice(2)] : BUCKETS;
  for (const [name, days] of list) if (days * pxPerDay >= 3.5) return name;
  return 'year';
}
const bucketLabel = { native: 'week', day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };

/* The numbers a band draws for the window [a, b]: bars (one per bucket) or line points. */
function bandData(t, pts, a, b, pxPerDay) {
  const { d, v, brk } = prep(pts), native = nativeDays(t);
  if (isBars(t)) {
    const bucket = pickBucket(t, pxPerDay), agg = aggOf(t);
    const lo = lowerBound(d, bucketStart(a, bucket, native));
    const out = [];
    let cur = null;
    for (let i = lo; i < d.length && d[i] <= b; i++) {
      const s = bucketStart(d[i], bucket, native);
      if (!cur || cur.s !== s) { cur = { s, e: bucketEnd(s, bucket, native), sum: 0, n: 0, max: -Infinity }; out.push(cur); }
      cur.sum += v[i]; cur.n++; if (v[i] > cur.max) cur.max = v[i];
    }
    for (const q of out) q.v = agg === 'sum' ? q.sum : agg === 'max' ? q.max : q.sum / q.n;
    return { bars: out, bucket };
  }
  const lo = Math.max(0, lowerBound(d, a) - 1), hi = Math.min(d.length, lowerBound(d, b) + 1);
  return { d, v, lo, hi, brk };
}

/* ---------- time axis ticks ---------- */
const STEPS = [
  ['day', 1, 1], ['day', 2, 2], ['week', 1, 7], ['week', 2, 14], ['month', 1, 30.44], ['month', 3, 91.3], ['month', 6, 182.6],
  ['year', 1, 365.25], ['year', 2, 730.5], ['year', 5, 1826], ['year', 10, 3652.5], ['year', 20, 7305], ['year', 50, 18262],
];
function makeTicks(a, b, pxPerDay, minPx) {
  const step = STEPS.find((s) => s[2] * pxPerDay >= minPx) || STEPS[STEPS.length - 1];
  const [unit, n] = step, out = [];
  if (unit === 'day' || unit === 'week') {
    const every = unit === 'week' ? 7 * n : n;
    let d = Math.floor(a);
    if (unit === 'week') d -= ((((d + 3) % 7) + 7) % 7);          // Mondays
    else d -= ((d % every) + every) % every;
    for (; d <= b; d += every) { if (d < a - 1) continue; const [y, m, dd] = ymd(d); out.push({ d, label: dd === 1 ? (m === 0 ? String(y) : MON[m]) : unit === 'week' ? `${MON[m]} ${dd}` : String(dd), major: dd === 1 }); }
  } else if (unit === 'month') {
    let [y, m] = ymd(a); m -= m % n;
    for (let d = utc(y, m); d <= b; m += n, d = utc(y, m)) { if (d < a - 1) continue; const [yy, mm] = ymd(d); out.push({ d, label: mm === 0 ? String(yy) : MON[mm], major: mm === 0 }); }
  } else {
    let y = ymd(a)[0]; y -= ((y % n) + n) % n;
    for (let d = utc(y, 0); d <= b; y += n, d = utc(y, 0)) { if (d < a - 1) continue; out.push({ d, label: String(y), major: true }); }
  }
  return out;
}

/* ---------- the component ---------- */
export function createTimeline(host, { tip, onRange }) {
  host.classList.add('tl');
  const bar = document.createElement('div'); bar.className = 'tl-bar';
  const help = document.createElement('div'); help.className = 'tl-help';
  help.textContent = matchMedia('(pointer: coarse)').matches
    ? 'Pinch to zoom · drag to pan · tap for details'
    : 'Scroll over the plots to zoom (over the labels it scrolls the page) · drag across them to zoom to a range · Shift-drag or scroll sideways to pan · double-click resets';
  bar.append(help);
  const wrap = document.createElement('div'); wrap.className = 'tl-wrap';
  const cv = document.createElement('canvas'), ov = document.createElement('canvas');
  cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Timeline: switched-on spans and events as a Gantt chart, and number series as thin plots, on one time axis');
  ov.className = 'tl-ov';
  wrap.append(cv, ov);
  host.append(bar, wrap);
  const ctx = cv.getContext('2d'), octx = ov.getContext('2d');

  let S = null;            // what to draw (from update())
  let range = null;        // [a, b] visible window in days, or null for everything
  let W = 0, K = 1;
  let hoverX = null;       // pointer x in CSS px over the plot (null when away)
  let brush = null;        // {x0, x1} while dragging to zoom
  let hits = [];           // gantt rectangles from the last draw, for hover
  let L = null;            // layout from the last draw

  /* ----- state -> what to draw ----- */
  function update(data, st) {
    const today = dn(data.today);
    const on = (k) => st.on.has(k);
    const tracks = new Map(data.tracks.map((t) => [t.key, t]));
    const items = data.items.filter((it) => on(it.track) && tracks.get(it.track)?.kind !== 'series');
    const legend = data.tracks.filter((t) => t.kind !== 'series' && on(t.key) && items.some((it) => it.track === t.key));
    const series = data.tracks.filter((t) => t.kind === 'series' && on(t.key) && (data.points[t.key] || []).length).map((t) => ({ t, pts: data.points[t.key] }));
    let fa = Infinity, fb = -Infinity;
    for (const it of items) { fa = Math.min(fa, dn(it.start)); fb = Math.max(fb, dn(it.end || (tracks.get(it.track).kind === 'event' ? it.start : data.today))); }
    for (const { pts } of series) { const p = prep(pts); if (p.d.length) { fa = Math.min(fa, p.d[0]); fb = Math.max(fb, p.d[p.d.length - 1] + nativeDays({ config: {} })); } }
    // Nothing switched on: still show the axis, over everything there is, so a date range can be picked (the analysis uses it).
    if (!items.length && !series.length) {
      for (const it of data.items) { fa = Math.min(fa, dn(it.start)); fb = Math.max(fb, dn(it.end || (tracks.get(it.track)?.kind === 'event' ? it.start : data.today))); }
      for (const pts of Object.values(data.points)) { const p = prep(pts); if (p.d.length) { fa = Math.min(fa, p.d[0]); fb = Math.max(fb, p.d[p.d.length - 1] + 1); } }
    }
    S = { data, st, today, birth: dn(data.profile.birth), items, legend, series, tracks };
    host.hidden = !isFinite(fa);   // only an account with no data at all has nothing to show
    if (!isFinite(fa)) { S.full = null; return; }
    fb = Math.max(fb, today);
    const pad = (fb - fa) * 0.01;
    S.full = [fa - pad, fb + pad];
    if (range) range = fitRange(range[0], range[1]);
    draw();
  }
  const full = () => S.full;
  const win = () => range || S.full;
  function fitRange(a, b) {
    const [fa, fb] = S.full, wFull = fb - fa;
    let w = clamp(b - a, Math.min(MIN_SPAN, wFull), wFull);
    a = clamp(a, fa, fb - w);
    return [a, a + w];
  }
  function setRange(a, b) {
    const r = fitRange(a, b);
    range = r[1] - r[0] >= (S.full[1] - S.full[0]) - 0.5 ? null : r;
    draw(); drawOverlay();
    onRange?.(range);
  }
  const zoomAt = (day, factor) => { const [a, b] = win(); setRange(day - (day - a) * factor, day + (b - day) * factor); };
  const pan = (days) => { const [a, b] = win(); setRange(a + days, b + days); };

  /* ----- gantt packing: first-fit lanes in start order, over ALL items so rows don't shuffle while panning ----- */
  function pack(ppd) {
    ctx.font = `500 10px ${FONT}`;
    const list = S.items.map((it) => {
      const t = S.tracks.get(it.track), ev = t.kind === 'event';
      const s = dn(it.start), e = ev ? s : Math.max(s, dn(it.end || S.data.today));
      let ps = s, pe, flip = false;
      if (ev) {
        const wPx = ctx.measureText(it.label || '').width + 10;     // diamond + label
        flip = s + (wPx + 8) / ppd > S.full[1];                     // too close to the right end of everything: the label goes on the left
        ps = flip ? s - wPx / ppd : s - 6 / ppd; pe = flip ? s + 6 / ppd : s + wPx / ppd;
      } else pe = s + Math.max(3 / ppd, e + 1 - s);               // a span covers its last day too, so the next one may start the day after
      return { it, ev, s, e, ps, end: ev ? pe + 3 / ppd : pe, flip, t };
    }).sort((x, y) => x.ps - y.ps || (y.e - y.s) - (x.e - x.s) || x.it.id - y.it.id);
    const lanes = [];
    for (const q of list) {
      let l = lanes.findIndex((end) => end <= q.ps); if (l < 0) { l = lanes.length; lanes.push(0); }
      lanes[l] = q.end; q.lane = l;
    }
    return { list, lanes: lanes.length };
  }

  /* ----- drawing ----- */
  function layout() {
    const narrow = W < 640;
    const GW = narrow ? 74 : 150, x0 = GW, x1 = W - 12;
    return { narrow, GW, x0, x1, pw: x1 - x0 };
  }
  function draw() {
    if (!S || !S.full) return;
    W = Math.max(280, Math.floor(wrap.clientWidth || host.clientWidth || 800)); K = window.devicePixelRatio || 1;
    const lay = layout();
    const [a, b] = win(), ppd = lay.pw / (b - a);
    const X = (d) => lay.x0 + (d - a) * ppd;
    const g = S.items.length ? pack(ppd) : { list: [], lanes: 0 };
    const ganttH = g.lanes ? g.lanes * LANE_H + 10 : 0;
    const yOver = 2, yAxis = OVER_H, yGantt = yAxis + AXIS_H, yBands = yGantt + ganttH;
    const empty = !g.lanes && !S.series.length;   // nothing switched on: a short empty plot with a hint
    const H = yBands + S.series.length * (BAND_H + BAND_GAP) + (empty ? 40 : 0) + 6;
    L = { ...lay, a, b, ppd, X, yOver, yAxis, yGantt, ganttH, yBands, H, g };
    for (const c of [cv, ov]) { c.width = Math.round(W * K); c.height = Math.round(H * K); c.style.width = W + 'px'; c.style.height = H + 'px'; }
    wrap.style.height = H + 'px';
    ctx.setTransform(K, 0, 0, K, 0, 0);
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
    const px = (x) => Math.round(x * K) / K;
    const text = (s, x, y, size, color, o = {}) => {
      ctx.font = `${o.weight || 400} ${size}px ${FONT}`; ctx.textAlign = o.align || 'left'; ctx.textBaseline = o.base || 'alphabetic';
      if (o.halo) { ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = PAPER; ctx.strokeText(s, x, y); }
      ctx.fillStyle = color; ctx.fillText(s, x, y);
    };

    /* overview strip: the whole range, with the visible window on it */
    const [fa, fb] = S.full, fppd = lay.pw / (fb - fa), FX = (d) => lay.x0 + (d - fa) * fppd;
    ctx.fillStyle = '#eef1f5'; ctx.fillRect(lay.x0, yOver + 5, lay.pw, 12);
    ctx.fillStyle = FAINT; for (const t of makeTicks(fa, fb, fppd, 44)) ctx.fillRect(px(FX(t.d)), yOver + 5, 1 / K, 12);
    if (range) {
      ctx.fillStyle = 'rgba(61,111,209,.22)'; ctx.fillRect(FX(a), yOver + 3, FX(b) - FX(a), 16);
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.strokeRect(FX(a) + .5, yOver + 3.5, Math.max(2, FX(b) - FX(a) - 1), 15);
    }
    ctx.fillStyle = SOFT; ctx.fillRect(px(FX(S.today)), yOver + 3, 1.5, 16);
    text(range ? `${monYear(a)} – ${monYear(b)}` : 'Everything', 6, yOver + 15, 10.5, SOFT, { weight: 600 });

    /* axis + vertical gridlines through everything below */
    const ticks = makeTicks(a, b, ppd, lay.narrow ? 52 : 62);
    ctx.fillStyle = GRID;
    for (const t of ticks) { const x = px(X(t.d)); ctx.fillRect(x, yAxis, 1 / K, H - yAxis - 4); }
    ctx.fillStyle = FAINT; ctx.fillRect(lay.x0, yGantt - 1, lay.pw, 1 / K);
    for (const t of ticks) { const x = X(t.d); if (x < lay.x0 - 1 || x > lay.x1 + 1) continue; text(t.label, x + 3, yAxis + 13, 10, t.major ? INK : SOFT, { weight: t.major ? 700 : 400 }); }

    ctx.save(); ctx.beginPath(); ctx.rect(lay.x0, yAxis, lay.pw + 1, H - yAxis); ctx.clip();

    /* gantt */
    hits = [];
    if (g.lanes) {
      for (const q of g.list) {
        if (q.e < a - 1 || q.s > b + 1) continue;
        const y = yGantt + 4 + q.lane * LANE_H, fill = q.it.fill || q.t.color;
        if (q.ev) {
          const cx = X(q.s); if (cx < lay.x0 - 8 || cx > lay.x1 + 8) continue;
          const cy = y + BAR_H / 2, r = 5.5;
          ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
          ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = PAPER; ctx.stroke();
          const label = q.it.label || '';
          ctx.font = `500 10px ${FONT}`;
          const lw = ctx.measureText(label).width, flip = q.flip;
          text(label, flip ? cx - 8 : cx + 8, cy + 3.5, 10, INK, { halo: true, weight: 500, align: flip ? 'right' : 'left' });
          hits.push({ x0: flip ? cx - 8 - lw : cx - 7, x1: flip ? cx + 7 : cx + 8 + lw, y0: y, y1: y + BAR_H, q });
        } else {
          const xa = X(q.s), xb = Math.max(xa + 3, X(q.e + 1) - 0.75), vx0 = Math.max(xa, lay.x0 - 2), vx1 = Math.min(xb, lay.x1 + 2);
          if (vx1 <= vx0) continue;
          ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(vx0, y, vx1 - vx0, BAR_H, 3); ctx.fill();
          const label = q.it.label || '', room = vx1 - Math.max(vx0, lay.x0) - 8;
          if (label && room >= 22) {
            ctx.save(); ctx.beginPath(); ctx.rect(vx0, y, vx1 - vx0, BAR_H); ctx.clip();
            ctx.font = `600 10px ${FONT}`;
            text(fit(ctx, label, room), Math.max(vx0, lay.x0) + 4, y + 9, 10, inkOn(fill), { weight: 600 });
            ctx.restore();
          }
          hits.push({ x0: vx0, x1: vx1, y0: y, y1: y + BAR_H, q });
        }
      }
    }

    /* bands */
    const scales = [], bandDatas = [], labels = [];
    S.series.forEach(({ t, pts }, i) => {
      const y0 = yBands + i * (BAND_H + BAND_GAP), y1 = y0 + BAND_H;
      if (i % 2 === 0) { ctx.fillStyle = STRIPE; ctx.fillRect(lay.x0, y0, lay.pw, BAND_H); }
      const data = bandData(t, pts, a, b, ppd); bandDatas[i] = data;
      const plotTop = y0 + 5, plotBot = y1 - 4, Y0 = plotBot, Yh = plotBot - plotTop;
      let ymin, ymax;
      if (data.bars) {
        let m = 0, lo = 0; for (const q of data.bars) { if (q.e > a && q.s < b) { if (q.v > m) m = q.v; if (q.v < lo) lo = q.v; } }
        ymax = niceCeil(m || 1); ymin = lo;
      } else {
        let lo = Infinity, hi = -Infinity;
        for (let k = data.lo; k < data.hi; k++) { const v = data.v[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        const cmin = t.config.min != null ? Number(t.config.min) : null, cmax = t.config.max != null ? Number(t.config.max) : null;
        const padv = (hi - lo || 1) * 0.1;
        ymin = cmin != null ? Math.min(cmin, lo) : lo - padv; ymax = cmax != null ? Math.max(cmax, hi) : hi + padv;
      }
      if (ymax <= ymin) ymax = ymin + 1;
      const Y = (v) => Y0 - ((v - ymin) / (ymax - ymin)) * Yh;
      scales[i] = Y;
      ctx.fillStyle = t.color;
      if (data.bars) {
        for (const q of data.bars) {
          const xa = X(q.s), xb = X(q.e); if (xb < lay.x0 || xa > lay.x1) continue;
          const w = Math.max(1, xb - xa - (xb - xa > 4 ? 1 : 0)), top = Y(Math.max(q.v, 0)), base = Y(Math.min(0, ymin));
          ctx.fillRect(xa, top, w, Math.max(1 / K, base - top));
        }
      } else {
        // One connected line through the readings. Across a long gap there are no readings, so that stretch is a straight
        // interpolation: drawn dashed and lighter so it reads as "joined up", not measured.
        const n = data.hi - data.lo, dots = n > 1 && ((data.d[data.hi - 1] - data.d[data.lo]) / (n - 1)) * ppd > 7;   // zoomed in far enough to see single readings
        ctx.strokeStyle = t.color; ctx.lineWidth = 1.3; ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let k = data.lo; k < data.hi; k++) {
          const x = X(data.d[k]), y = Y(data.v[k]);
          if (k === data.lo || data.d[k] - data.d[k - 1] > data.brk) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.save(); ctx.globalAlpha = 0.55; ctx.setLineDash([4, 3]); ctx.beginPath();
        for (let k = data.lo + 1; k < data.hi; k++) if (data.d[k] - data.d[k - 1] > data.brk) { ctx.moveTo(X(data.d[k - 1]), Y(data.v[k - 1])); ctx.lineTo(X(data.d[k]), Y(data.v[k])); }
        ctx.stroke(); ctx.restore();
        for (let k = data.lo; k < data.hi; k++) {
          const lone = (k === data.lo || data.d[k] - data.d[k - 1] > data.brk) && (k === data.hi - 1 || data.d[k + 1] - data.d[k] > data.brk);
          if (lone || dots) { ctx.beginPath(); ctx.arc(X(data.d[k]), Y(data.v[k]), lone ? 1.8 : 2, 0, 7); ctx.fillStyle = t.color; ctx.fill(); }
        }
      }
      // scale numbers at the left edge of the plot
      text(fmtNum(ymax), lay.x0 + 3, y0 + 11, 9, SOFT, { halo: true });
      if (!data.bars || ymin < 0) text(fmtNum(ymin), lay.x0 + 3, y1 - 3, 9, SOFT, { halo: true });
      ctx.fillStyle = GRID; ctx.fillRect(lay.x0, y1 + BAND_GAP / 2, lay.pw, 1 / K);
      labels.push([t, data, y0]);
    });
    ctx.restore();
    if (empty) {
      ctx.font = `500 11px ${FONT}`;
      text(fit(ctx, 'Nothing switched on · drag across the axis to pick a date range', lay.pw - 24), lay.x0 + lay.pw / 2, yGantt + 24, 11, SOFT, { align: 'center', weight: 500, halo: true });
    }

    /* today */
    const tx = X(S.today);
    if (tx >= lay.x0 && tx <= lay.x1) { ctx.strokeStyle = SOFT; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(px(tx) + .5, yAxis); ctx.lineTo(px(tx) + .5, H - 4); ctx.stroke(); ctx.setLineDash([]); }

    /* left gutter: legend for the gantt, a name for each band */
    ctx.save(); ctx.beginPath(); ctx.rect(0, yGantt, lay.GW - 6, ganttH || 1); ctx.clip();
    S.legend.forEach((t, i) => {
      const y = yGantt + 6 + i * 14; if (y > yGantt + ganttH) return;
      ctx.fillStyle = t.color; ctx.beginPath(); ctx.roundRect(6, y - 7, 9, 9, 3); ctx.fill();
      text(fit(ctx, t.name, lay.GW - 28), 20, y + 1, 10.5, INK, { weight: 600 });
    });
    ctx.restore();
    for (const [t, data, y0] of labels) band(t, data, y0);
    function band(t, data, y0) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, y0, lay.GW - 6, BAND_H); ctx.clip();
      ctx.fillStyle = t.color; ctx.beginPath(); ctx.roundRect(6, y0 + 7, 9, 9, 3); ctx.fill();
      ctx.font = `700 11px ${FONT}`;
      text(fit(ctx, t.name, lay.GW - 28), 20, y0 + 15, 11, INK, { weight: 700 });
      const unit = t.config.unit || '', sub = data.bars ? `${unit ? unit + ' ' : ''}per ${bucketLabel[data.bucket]}` : unit;
      ctx.font = `400 9.5px ${FONT}`;
      text(fit(ctx, sub, lay.GW - 14), 20, y0 + 28, 9.5, SOFT);
      ctx.restore();
    }
    L.bandData = bandDatas; L.scales = scales;
  }

  /* ----- what is under the pointer ----- */
  const dayAt = (x) => L.a + ((x - L.x0) / L.pw) * (L.b - L.a);
  function valueAt(i, day) {
    const { t, pts } = S.series[i], unit = t.config.unit || '', p = prep(pts), bd = L.bandData[i];
    if (bd.bars) {
      const q = bd.bars.find((r) => day >= r.s && day < r.e);
      if (!q) return null;
      const per = bucketLabel[bd.bucket];
      const when = per === 'day' ? dayStr(q.s) : per === 'week' ? `week of ${dayStr(q.s)}` : per === 'month' ? monYear(q.s) : per === 'quarter' ? `quarter from ${monYear(q.s)}` : String(ymd(q.s)[0]);
      return { text: fmtVal(q.v, unit), small: `${aggOf(t) === 'sum' ? 'total' : aggOf(t)} for ${when}`, dot: { d: (q.s + q.e) / 2, v: q.v, bar: true } };
    }
    if (!p.d.length) return null;
    let k = lowerBound(p.d, day); if (k > 0 && (k === p.d.length || day - p.d[k - 1] <= p.d[k] - day)) k--;
    if (Math.abs(p.d[k] - day) * L.ppd > 14) {
      const hi = lowerBound(p.d, day), lo = hi - 1;       // joined-up stretch: straight-line estimate between the readings either side
      if (lo < 0 || hi >= p.d.length) return { text: '—', small: 'no reading here', dim: true };
      const f = (day - p.d[lo]) / (p.d[hi] - p.d[lo]);
      return { text: '≈ ' + fmtVal(p.v[lo] + (p.v[hi] - p.v[lo]) * f, unit), small: `interpolated between ${dayStr(p.d[lo])} and ${dayStr(p.d[hi])}`, dim: true, dot: { d: day, v: p.v[lo] + (p.v[hi] - p.v[lo]) * f } };
    }
    return { text: fmtVal(p.v[k], unit), small: Math.floor(p.d[k]) === Math.floor(day) ? '' : `on ${dayStr(p.d[k])}`, dot: { d: p.d[k], v: p.v[k] } };
  }
  function drawOverlay() {
    octx.setTransform(K, 0, 0, K, 0, 0); octx.clearRect(0, 0, W, L ? L.H : 0);
    if (!L) return;
    if (brush) {
      const xa = Math.min(brush.x0, brush.x1), xb = Math.max(brush.x0, brush.x1);
      octx.fillStyle = 'rgba(61,111,209,.14)'; octx.fillRect(xa, L.yAxis, xb - xa, L.H - L.yAxis - 4);
      octx.fillStyle = ACCENT; octx.fillRect(xa, L.yAxis, 1, L.H - L.yAxis - 4); octx.fillRect(xb - 1, L.yAxis, 1, L.H - L.yAxis - 4);
      return;
    }
    if (hoverX == null) return;
    const x = Math.round(hoverX) + .5;
    octx.strokeStyle = 'rgba(31,41,55,.55)'; octx.lineWidth = 1; octx.beginPath(); octx.moveTo(x, L.yAxis); octx.lineTo(x, L.H - 4); octx.stroke();
    const day = dayAt(hoverX);
    const lab = dayStr(day); octx.font = `600 10px ${FONT}`;
    const w = octx.measureText(lab).width + 10, lx = clamp(x - w / 2, L.x0, L.x1 - w);
    octx.fillStyle = '#1c2530'; octx.beginPath(); octx.roundRect(lx, L.yAxis + 1, w, 15, 4); octx.fill();
    octx.fillStyle = '#fff'; octx.textBaseline = 'alphabetic'; octx.textAlign = 'left'; octx.fillText(lab, lx + 5, L.yAxis + 12);
    S.series.forEach((s, i) => {
      const v = valueAt(i, day); if (!v?.dot || v.dot.bar) return;
      const Y = L.scales[i];
      octx.fillStyle = PAPER; octx.beginPath(); octx.arc(L.X(v.dot.d), Y(v.dot.v), 4, 0, 7); octx.fill();
      octx.fillStyle = s.t.color; octx.beginPath(); octx.arc(L.X(v.dot.d), Y(v.dot.v), 2.8, 0, 7); octx.fill();
    });
    const hit = hitAt(hoverX, hoverY);
    if (hit) { octx.strokeStyle = '#111a24'; octx.lineWidth = 1.5; octx.beginPath(); octx.roundRect(hit.x0 - 1, hit.y0 - 1, hit.x1 - hit.x0 + 2, hit.y1 - hit.y0 + 2, 4); octx.stroke(); }
  }
  let hoverY = 0;
  const hitAt = (x, y) => hits.find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 - 1 && y <= h.y1 + 1);

  function showTip(clientX, clientY, touch) {
    if (hoverX == null || !L) { tip.hidden = true; return; }
    const day = dayAt(hoverX), el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    tip.replaceChildren();
    tip.append(el('b', '', dayStr(day)), el('div', 'm', `age ${ageString(S.birth, Math.floor(day))}${day > S.today ? ' · ahead' : ''}`));
    S.series.forEach((s, i) => {
      const v = valueAt(i, day); if (!v) return;
      const row = el('div', v.dim ? 'm' : '');
      const sw = el('span', 'sw'); sw.style.background = s.t.color;
      row.append(sw, el('b', '', s.t.name + ' '), document.createTextNode(v.text));
      if (v.small) row.append(el('span', 'm', ' · ' + v.small));
      tip.append(row);
    });
    const direct = hitAt(hoverX, hoverY)?.q;
    const near = new Map();
    for (const h of hits) if (h.q === direct || (!h.q.ev && day >= h.q.s && day < h.q.e + 1) || (h.q.ev && Math.abs(L.X(h.q.s) - hoverX) <= 6)) near.set(h.q.it.id, h.q);
    const lines = [...near.values()].sort((p, q) => (q === direct) - (p === direct) || p.s - q.s);
    for (const q of lines.slice(0, 8)) {
      const row = el('div'); const sw = el('span', 'sw'); sw.style.background = q.it.fill || q.t.color;
      row.append(sw, el('b', '', q.it.label || q.t.name), el('span', 'm', ` ${q.t.name} · ${q.ev ? prettyDate(q.it.start) : `${prettyDate(q.it.start)} – ${q.it.end ? prettyDate(q.it.end) : 'now'}`}`));
      tip.append(row);
      if (q === direct) { const extra = Object.entries(q.it.attrs || {}).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(' · '); if (extra) tip.append(el('div', 'm', extra)); }
    }
    if (lines.length > 8) tip.append(el('div', 'm', `+ ${lines.length - 8} more`));
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, touch ? clientX - w / 2 : clientX + 16)) + 'px';
    const above = touch && clientY - h - 18 > 8;
    tip.style.top = (above ? clientY - h - 18 : Math.max(8, Math.min(innerHeight - h - 8, clientY + 18))) + 'px';
  }

  /* ----- pointer: hover, drag to zoom, shift-drag to pan, overview drag, touch pan + pinch ----- */
  const pointers = new Map();
  let drag = null, pinch = null;
  const local = (e) => { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const inPlot = (x) => x >= L.x0 && x <= L.x1;

  ov.addEventListener('pointerdown', (e) => {
    if (!L) return;
    try { ov.setPointerCapture(e.pointerId); } catch {}
    const [x, y] = local(e); pointers.set(e.pointerId, { x, y });
    if (pointers.size === 2 && e.pointerType === 'touch') {
      const [p, q] = [...pointers.values()], [a, b] = win();
      pinch = { dist: Math.abs(p.x - q.x) || 1, a, b, mid: dayAt((p.x + q.x) / 2) }; drag = null; brush = null; return;
    }
    if (y < OVER_H) {   // overview: drag the window, drag its edges, or jump
      const [fa, fb] = S.full, fppd = L.pw / (fb - fa), [a, b] = win(), xa = L.x0 + (a - fa) * fppd, xb = L.x0 + (b - fa) * fppd;
      const mode = range && Math.abs(x - xa) < 7 ? 'left' : range && Math.abs(x - xb) < 7 ? 'right' : range && x > xa && x < xb ? 'move' : 'jump';
      drag = { kind: 'over', mode, x, a, b, fppd, fa };
      if (mode === 'jump') { const c = fa + (x - L.x0) / fppd, w = b - a; setRange(c - w / 2, c + w / 2); drag.mode = 'move'; drag.a = win()[0]; drag.b = win()[1]; }
      return;
    }
    if (e.pointerType !== 'touch' && !inPlot(x)) return;
    if (e.pointerType === 'touch' || e.shiftKey || e.button === 1) { drag = { kind: 'pan', x, a: win()[0], b: win()[1], moved: false }; return; }
    drag = { kind: 'brush', x, moved: false };
  });
  ov.addEventListener('pointermove', (e) => {
    if (!L) return;
    const [x, y] = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y });
    if (pinch && pointers.size === 2) {
      const [p, q] = [...pointers.values()], f = pinch.dist / (Math.abs(p.x - q.x) || 1);
      const mid = (p.x + q.x) / 2, anchor = pinch.mid;
      const w = (pinch.b - pinch.a) * f, frac = (mid - L.x0) / L.pw;
      setRange(anchor - frac * w, anchor + (1 - frac) * w); return;
    }
    if (drag?.kind === 'over') {
      const dd = (x - drag.x) / drag.fppd;
      if (drag.mode === 'move') setRange(drag.a + dd, drag.b + dd);
      else if (drag.mode === 'left') setRange(Math.min(drag.a + dd, drag.b - MIN_SPAN), drag.b);
      else setRange(drag.a, Math.max(drag.b + dd, drag.a + MIN_SPAN));
      return;
    }
    if (drag?.kind === 'pan') {
      if (Math.abs(x - drag.x) > 3) drag.moved = true;
      const dd = -(x - drag.x) / L.ppd; setRange(drag.a + dd, drag.b + dd); return;
    }
    if (drag?.kind === 'brush') {
      if (Math.abs(x - drag.x) > 4) drag.moved = true;
      if (drag.moved) { brush = { x0: clamp(drag.x, L.x0, L.x1), x1: clamp(x, L.x0, L.x1) }; tip.hidden = true; drawOverlay(); }
      return;
    }
    if (e.pointerType === 'touch') return;
    ov.style.cursor = y < OVER_H ? 'ew-resize' : x < L.x0 ? 'default' : 'crosshair';   // the label gutter is not part of the plot
    if (inPlot(x) && y >= L.yAxis) { hoverX = x; hoverY = y; drawOverlay(); showTip(e.clientX, e.clientY, false); }
    else { hoverX = null; drawOverlay(); tip.hidden = true; }
  });
  const end = (e) => {
    const [x, y] = local(e);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag?.kind === 'brush' && brush) {
      const xa = Math.min(brush.x0, brush.x1), xb = Math.max(brush.x0, brush.x1);
      brush = null;
      if (xb - xa >= 8) setRange(dayAt(xa), dayAt(xb)); else drawOverlay();
    } else if (drag?.kind === 'pan' && !drag.moved && e.pointerType === 'touch' && inPlot(x)) {
      hoverX = x; hoverY = y; drawOverlay(); showTip(e.clientX, e.clientY, true);
    }
    drag = null;
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', (e) => { brush = null; end(e); });
  ov.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !drag) { hoverX = null; drawOverlay(); tip.hidden = true; } });
  ov.addEventListener('dblclick', () => { if (S?.full) setRange(...S.full); });
  ov.addEventListener('wheel', (e) => {
    if (!L) return;
    const [x, y] = local(e);
    // Over the labels on the left, the wheel belongs to the page: let it scroll past the timeline.
    if (x < L.x0 && !e.ctrlKey && !e.metaKey) return;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); pan((e.deltaX || e.deltaY) / L.ppd); return; }
    // Already showing everything: zooming out can't do anything, so don't swallow the scroll either.
    if (!range && e.deltaY > 0 && !e.ctrlKey && !e.metaKey) return;
    // scrolling up zooms in (the date range shrinks), down zooms out; Ctrl/⌘ or a trackpad pinch is a little more sensitive
    e.preventDefault();
    const [a, b] = win(), anchor = y < OVER_H ? (a + b) / 2 : dayAt(clamp(x, L.x0, L.x1));
    zoomAt(anchor, Math.exp(e.deltaY * (e.ctrlKey || e.metaKey ? 0.0025 : 0.0015)));
  }, { passive: false });
  window.addEventListener('scroll', () => { if (hoverX != null) { hoverX = null; drawOverlay(); tip.hidden = true; } }, { passive: true });

  const ro = new ResizeObserver(() => { if (S?.full && Math.abs((wrap.clientWidth || 0) - W) > 0.5) { draw(); drawOverlay(); } });
  ro.observe(wrap);

  // getRange: the visible window as [first day, last day] (day numbers), or null when everything is showing
  return { update, resetRange: () => { range = null; }, getRange: () => (range ? [range[0], range[1]] : null) };
}
