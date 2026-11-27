// Analysis mode: how every number series relates to every other one, over the time range selected on the timeline.
//   - a correlation matrix (Pearson r) of all number series, paired by day, week or month;
//   - click a cell for an x/y scatter plot of that pair with a dotted straight-line fit and its r.
// Display only: it reads the same points the timeline draws and computes in the browser. Nothing is stored.
//
// How the numbers are made (kept deliberately plain):
//   - each series is folded into buckets: a day, one of the calendar's week squares (Jan 1 + 7n, the same weeks the
//     poster draws), or a calendar month. Counts (bars / agg "sum") are summed per bucket, everything else averaged.
//   - two series are paired on the buckets where both have a value, inside the selected range. A bucket must fit
//     entirely inside the range, and the day in progress is never counted.
//   - counts only store the days/weeks something happened, so by default the gaps between a count series' first and
//     last entry are read as 0 (a switch turns this off).

import { dn, dnToStr, prettyDate, FONT } from './poster.js';

const MS = 864e5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const NOUN = { day: 'days', week: 'weeks', month: 'months' };
const MIN_PAIRS = 3, FADE_BELOW = 10;

const utc = (y, m, d = 1) => Date.UTC(y, m, d) / MS;
const ymd = (n) => { const t = new Date(n * MS); return [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()]; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const fmtSig = (n) => Number(n.toPrecision(2)).toLocaleString('en-US', { maximumSignificantDigits: 2 });
const fmtR = (r) => { const t = Math.abs(r).toFixed(2); return r < 0 && t !== '0.00' ? '−' + t : t; };
const fmtNum = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100));
const fmtVal = (n, unit) => (unit === '$' ? (n < 0 ? '-$' : '$') + fmtNum(Math.abs(n)) : fmtNum(n) + (unit ? ' ' + unit : ''));

/* ---------- folding a series into buckets ---------- */
const isCount = (t) => t.config.chart === 'bars' || t.config.agg === 'sum';
const aggOf = (t) => (t.config.agg === 'avg' || t.config.agg === 'max' || t.config.agg === 'sum' ? t.config.agg : isCount(t) ? 'sum' : 'avg');
const weekly = (t) => t.config.grain === 'week';   // stored as one number per week square, so it can't be split into days

/* [start, end) day numbers of the bucket holding day d */
function bucketOf(d, res) {
  if (res === 'day') return [d, d + 1];
  const [y, m] = ymd(d);
  if (res === 'month') return [utc(y, m), utc(y, m + 1)];
  const j1 = utc(y, 0), n = Math.min(51, Math.floor((d - j1) / 7));      // 52 squares a year; the last holds the 1–2 leftover days
  return [j1 + n * 7, n === 51 ? utc(y + 1, 0) : j1 + n * 7 + 7];
}

const cache = new WeakMap();   // points array -> "res+fill" -> folded series
function fold(t, pts, res, fill) {
  let byId = cache.get(pts); if (!byId) cache.set(pts, (byId = new Map()));
  const id = res + (fill ? '+' : '-');
  let out = byId.get(id); if (out) return out;
  const agg = aggOf(t);
  let list = [], cur = null;
  const rows = [...pts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [date, val] of rows) {
    const [s, e] = bucketOf(dn(date), res);
    if (!cur || cur.s !== s) { cur = { s, e, sum: 0, n: 0, max: -Infinity }; list.push(cur); }
    cur.sum += val; cur.n++; if (val > cur.max) cur.max = val;
  }
  for (const q of list) q.v = agg === 'sum' ? q.sum : agg === 'max' ? q.max : q.sum / q.n;
  // A total over a bucket the series only partly covers isn't comparable: drop the first/last bucket if the data starts
  // after it begins or stops before it ends. (An average of what exists is fine, and a weekly-stored value is a whole week.)
  if (agg === 'sum' && !weekly(t) && res !== 'day' && list.length) {
    if (dn(rows[0][0]) > list[0].s) list.shift();
    if (list.length && dn(rows[rows.length - 1][0]) < list[list.length - 1].e - 1) list.pop();
  }
  if (fill && isCount(t) && list.length) {
    const filled = []; let i = 0;
    for (let s = list[0].s; s <= list[list.length - 1].s;) {
      const [bs, be] = bucketOf(s, res);
      if (list[i] && list[i].s === bs) filled.push(list[i++]); else filled.push({ s: bs, e: be, v: 0 });
      s = be;
    }
    list = filled;
  }
  out = { k: Float64Array.from(list, (q) => q.s), e: Float64Array.from(list, (q) => q.e), v: Float64Array.from(list, (q) => q.v) };
  byId.set(id, out);
  return out;
}

/* the buckets both series have a value for, that lie fully inside [lo, hi] */
function pairUp(A, B, lo, hi) {
  const xs = [], ys = [], ks = [];
  let i = lowerBound(A.k, lo), j = lowerBound(B.k, lo);
  while (i < A.k.length && j < B.k.length) {
    if (A.e[i] - 1 > hi || B.e[j] - 1 > hi) break;
    if (A.k[i] === B.k[j]) { xs.push(A.v[i]); ys.push(B.v[j]); ks.push(A.k[i]); i++; j++; }
    else if (A.k[i] < B.k[j]) i++; else j++;
  }
  return { xs, ys, ks };
}
function countIn(A, lo, hi) { let n = 0; for (let i = lowerBound(A.k, lo); i < A.k.length && A.e[i] - 1 <= hi; i++) n++; return n; }

function stats(xs, ys) {
  const n = xs.length;
  if (n < MIN_PAIRS) return { n, r: null };
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  if (!(sxx > 0) || !(syy > 0)) return { n, r: null, constant: true };
  const slope = sxy / sxx;
  return { n, r: clamp(sxy / Math.sqrt(sxx * syy), -1, 1), slope, icpt: my - slope * mx };
}

/* ---------- axis helpers ---------- */
function niceTicks(lo, hi, want) {
  const raw = (hi - lo) / Math.max(1, want), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p, out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks: out, step };
}
const tickText = (v, step) => v.toLocaleString('en-US', { maximumFractionDigits: Math.max(0, 1 - Math.floor(Math.log10(step))) });
function fitText(ctx, s, w) {
  if (ctx.measureText(s).width <= w) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m) + '…').width <= w) lo = m; else hi = m - 1; }
  return lo > 0 ? s.slice(0, lo) + '…' : '';
}

/* ---------- histogram ---------- */
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
/* Bins of a nice width (1, 2, 2.5, 5 × a power of ten) lined up on multiples of it, about √n of them. Whole-number data never gets bins narrower than 1. */
function histogram(vals) {
  const n = vals.length;
  let mn = Infinity, mx = -Infinity, whole = true;
  for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; if (!Number.isInteger(v)) whole = false; }
  let step = niceStep(((mx - mn) || Math.abs(mn) * 0.1 || 1) / clamp(Math.ceil(Math.sqrt(n)), 6, 30));
  if (whole) step = Math.max(1, step);
  const start = Math.floor(mn / step + 1e-9) * step, bins = Math.max(1, Math.floor((mx - start) / step + 1e-9) + 1);
  const edges = Array.from({ length: bins + 1 }, (_, i) => Number((start + i * step).toPrecision(12))), counts = new Array(bins).fill(0);
  for (const v of vals) counts[clamp(Math.floor((v - start) / step + 1e-9), 0, bins - 1)]++;
  return { edges, counts, max: Math.max(...counts), step };
}
function describe(vals) {
  const n = vals.length, sorted = [...vals].sort((a, b) => a - b), mean = vals.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const sd = n > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, median, sd, min: sorted[0], max: sorted[n - 1] };
}
/* the values of a folded series that lie fully inside [lo, hi] */
function valuesIn(B, lo, hi) {
  const v = [], k = [];
  for (let i = lowerBound(B.k, lo); i < B.k.length && B.e[i] - 1 <= hi; i++) { v.push(B.v[i]); k.push(B.k[i]); }
  return { v, k };
}

/* ---------- the component ---------- */
export function createAnalysis(host, { tip, st, save, getRange }) {
  host.classList.add('an');
  let data = null, today = 0, sel = null, plot = null, raf = 0, K = 1, PW = 0, PH = 0, hoverIdx = -1;

  const rangeLine = el('div', { className: 'an-range' });
  const seg = el('div', { className: 'seg' }); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Compare by');
  const segBtns = RES.map(([k, label]) => {
    const b = el('button', { type: 'button', textContent: label });
    b.onclick = () => { st.an.res = k; save(); render(); };
    seg.append(b); return [k, b];
  });
  const fillBox = el('input', { type: 'checkbox', id: 'an-fill' });
  fillBox.onchange = () => { st.an.fill = fillBox.checked; save(); render(); };
  const fillLabel = el('label', { htmlFor: 'an-fill', title: 'GitHub-style counts only store the days or weeks something happened. When on, the gaps between a count series’ first and last entry are read as 0, so quiet weeks count.' }, fillBox, document.createTextNode(' Count series: no entry means 0'));
  const head = el('div', { className: 'an-head' }, rangeLine, el('div', { className: 'an-ctl' }, el('span', { className: 'an-lab', textContent: 'Compare by' }), seg, fillLabel));
  const mxBox = el('div', { className: 'an-mx' });
  const note = el('p', { className: 'mini an-note' });
  const cv = el('canvas', { className: 'an-cv' });
  cv.setAttribute('role', 'img');
  const plTitle = el('div', { className: 'an-pt' });
  const plCap = el('div', { className: 'mini an-cap' });
  const plHold = el('div', { className: 'an-ph' });
  const pl = el('div', { className: 'an-pl' }, plTitle, cv, plHold, plCap);
  host.append(head, el('div', { className: 'an-body' }, el('div', { className: 'an-left' }, mxBox, note), pl));
  const ctx = cv.getContext('2d');

  function update(d) { data = d; today = dn(d.today); refresh(); }
  function refresh() { if (host.hidden || !data) return; cancelAnimationFrame(raf); raf = requestAnimationFrame(render); }

  /* ----- compute + draw the matrix ----- */
  function render() {
    if (host.hidden || !data) return;
    const { res, fill } = st.an;
    hoverIdx = -1;
    for (const [k, b] of segBtns) b.setAttribute('aria-pressed', k === res);
    fillBox.checked = fill;
    const rg = getRange();
    const lo = rg ? Math.ceil(rg[0]) : -Infinity, hi = Math.min(rg ? Math.floor(rg[1]) : Infinity, today - 1);   // the day in progress is never counted
    rangeLine.textContent = rg ? `${prettyDate(dnToStr(Math.ceil(rg[0])))} – ${prettyDate(dnToStr(Math.floor(rg[1])))} · set by the range selected on the timeline above` : 'All time · drag across the timeline above to pick a range';

    const rows = data.tracks.filter((t) => t.kind === 'series' && (data.points[t.key] || []).length)
      .map((t) => { const off = res === 'day' && weekly(t); return { t, off, B: off ? null : fold(t, data.points[t.key], res, fill) }; });
    sel = sel && rows.some((r) => r.t.key === sel.x) && rows.some((r) => r.t.key === sel.y) ? sel : null;
    mxBox.replaceChildren();
    if (rows.length < 2) { mxBox.append(el('p', { className: 'mini', textContent: 'Needs at least two number series. Add them by talking to your AI app.' })); plot = null; drawPlot(); return; }

    const cell = rows.map(() => rows.map(() => null));
    rows.forEach((a, i) => rows.forEach((b, j) => {
      if (j <= i || a.off || b.off) return;
      const p = pairUp(a.B, b.B, lo, hi), s = stats(p.xs, p.ys);
      cell[i][j] = cell[j][i] = s;
    }));

    const table = el('table', { className: 'mx' });
    table.append(el('caption', { className: 'sr', textContent: 'Correlation matrix of number series' }));
    const thead = el('tr', {}, el('td'));
    for (const { t } of rows) { const th = el('th', { scope: 'col', className: 'col', title: t.name }); th.append(el('span', { textContent: t.name })); th.style.setProperty('--c', t.color); thead.append(th); }
    table.append(thead);
    rows.forEach((a, i) => {
      const tr = el('tr');
      const th = el('th', { scope: 'row', className: 'row', title: a.t.name }, el('i'), el('span', { textContent: a.t.name }));
      th.firstChild.style.background = a.t.color; tr.append(th);
      rows.forEach((b, j) => {
        const td = el('td');
        const pair = `${b.t.name} (x) vs ${a.t.name} (y)`;
        if (i === j) {
          td.className = 'diag';
          if (a.off) { td.textContent = 'n/a'; td.title = `${a.t.name} is stored weekly, so it can’t be compared by day. Choose Week or Month.`; }
          else {
            const btn = el('button', { type: 'button', textContent: String(countIn(a.B, lo, hi)) });
            if (sel && sel.x === a.t.key && sel.y === a.t.key) btn.className = 'sel';
            btn.title = `${a.t.name}: ${btn.textContent} ${NOUN[res]} with a value in this range. Click for its histogram.`;
            btn.setAttribute('aria-label', btn.title);
            btn.onclick = () => { sel = { x: a.t.key, y: a.t.key }; render(); };
            td.append(btn);
          }
        } else if (a.off || b.off) {
          td.className = 'na'; td.textContent = 'n/a'; td.title = `${(a.off ? a : b).t.name} is stored weekly, so it can’t be compared by day. Choose Week or Month.`;
        } else {
          const s = cell[i][j];
          if (s.r == null) {
            td.className = 'nil'; td.textContent = '·';
            td.title = s.constant ? `${pair}: one of them doesn’t change over these ${s.n} ${NOUN[res]}, so there is no correlation` : `${pair}: only ${s.n} ${NOUN[res]} where both have a value in this range (needs ${MIN_PAIRS})`;
          } else {
            const btn = el('button', { type: 'button', textContent: fmtR(s.r) });
            const a100 = Math.abs(s.r);
            btn.style.setProperty('--a', (a100 * 100).toFixed(0) + '%');
            btn.className = 'c ' + (s.r >= 0 ? 'pos' : 'neg') + (s.n < FADE_BELOW ? ' lo' : '') + (a100 > 0.55 ? ' hi' : '') + (sel && sel.x === b.t.key && sel.y === a.t.key ? ' sel' : '');
            btn.title = `${pair}: r = ${fmtR(s.r)} over ${s.n} ${NOUN[res]}${s.n < FADE_BELOW ? ' (few, so treat with care)' : ''}. Click for the plot.`;
            btn.setAttribute('aria-label', btn.title);
            btn.onclick = () => { sel = { x: b.t.key, y: a.t.key }; render(); };
            td.append(btn);
          }
        }
        tr.append(td);
      });
      table.append(tr);
    });
    mxBox.append(table);
    note.textContent = `Pearson r between each pair, ${res === 'day' ? 'day by day' : `${res} by ${res}`}: counts are summed per ${res}, everything else averaged. Only ${NOUN[res]} that fit inside the range count, and the day in progress is left out. Faded cells have fewer than ${FADE_BELOW} pairs. Click a cell for a scatter plot (x is the column, y is the row; the mirrored cell swaps them), or a diagonal cell for that series’ histogram.`;

    /* the plot for the selected cell */
    plot = null;
    if (sel) {
      const A = rows.find((r) => r.t.key === sel.x), B = rows.find((r) => r.t.key === sel.y);
      if (A && B && A === B && !A.off) {
        const { v, k } = valuesIn(A.B, lo, hi);
        plot = { hist: true, A: A.t, res, vals: v, ks: k, h: v.length ? histogram(v) : null, d: v.length ? describe(v) : null };
      } else if (A && B && !A.off && !B.off) {
        const p = pairUp(A.B, B.B, lo, hi), s = stats(p.xs, p.ys);
        plot = { A: A.t, B: B.t, res, ...p, s };
      }
    }
    drawPlot();
  }

  /* ----- the scatter plot ----- */
  function sizePlot() {
    const w = Math.floor(Math.max(260, Math.min(680, pl.clientWidth || 420)));
    const h = Math.round(clamp(w * 0.8, 260, 520));
    K = window.devicePixelRatio || 1;
    if (w !== PW || h !== PH || cv.width !== Math.round(w * K)) {
      PW = w; PH = h; cv.width = Math.round(w * K); cv.height = Math.round(h * K); cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
  }
  function axisName(t, res) {
    const unit = t.config.unit || '';
    if (res === 'day') return unit ? `${t.name} (${unit})` : t.name;
    return `${t.name} (${isCount(t) ? 'total' : 'avg'}${unit ? ' ' + unit : ''} per ${res})`;
  }
  /* axes, grid and titles shared by the scatter plot and the histogram; returns the colors and the data-to-pixel maps */
  function frame({ xlo, xhi, ylo, yhi, xTitle, yTitle, intY }) {
    sizePlot();
    const css = getComputedStyle(document.documentElement), c = (n) => css.getPropertyValue(n).trim();
    const INK = c('--ink'), SOFT = c('--soft'), LINE = c('--line'), PANEL = c('--panel'), ACC = c('--accent');
    const m = { l: 60, r: 14, t: 14, b: 46 }, x0 = m.l, x1 = PW - m.r, y0 = m.t, y1 = PH - m.b;
    const sx = (v) => x0 + ((v - xlo) / (xhi - xlo)) * (x1 - x0), sy = (v) => y1 - ((v - ylo) / (yhi - ylo)) * (y1 - y0);
    ctx.setTransform(K, 0, 0, K, 0, 0); ctx.clearRect(0, 0, PW, PH);
    ctx.fillStyle = PANEL; ctx.fillRect(0, 0, PW, PH);
    ctx.font = `400 10.5px ${FONT}`; ctx.lineWidth = 1;
    const xt = niceTicks(xlo, xhi, Math.max(3, Math.floor((x1 - x0) / 70))), yt = niceTicks(ylo, yhi, Math.max(3, Math.floor((y1 - y0) / 38)));
    const yticks = intY ? yt.ticks.filter(Number.isInteger) : yt.ticks;
    ctx.strokeStyle = LINE; ctx.fillStyle = SOFT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt.ticks) { const x = Math.round(sx(v)) + .5; ctx.globalAlpha = .55; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillText(tickText(v, xt.step), x, y1 + 6); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yticks) { const y = Math.round(sy(v)) + .5; ctx.globalAlpha = .55; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillText(tickText(v, yt.step), x0 - 6, y); }
    ctx.strokeStyle = SOFT; ctx.beginPath(); ctx.moveTo(x0 + .5, y0); ctx.lineTo(x0 + .5, y1 + .5); ctx.lineTo(x1, y1 + .5); ctx.stroke();
    ctx.fillStyle = INK; ctx.font = `600 11.5px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(fitText(ctx, xTitle, x1 - x0), (x0 + x1) / 2, PH - 8);
    ctx.save(); ctx.translate(13, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(fitText(ctx, yTitle, y1 - y0), 0, 0); ctx.restore();
    return { INK, SOFT, LINE, PANEL, ACC, x0, x1, y0, y1, sx, sy };
  }
  /* a rounded box of text over the plot */
  function statBox(F, left, big, lines) {
    ctx.font = `700 17px ${FONT}`; let w = ctx.measureText(big).width; ctx.font = `500 11px ${FONT}`;
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    const bw = w + 18, bh = 29 + lines.length * 17 - 9, bx = left ? F.x0 + 8 : F.x1 - bw - 8, by = F.y0 + 8;
    ctx.fillStyle = F.PANEL; ctx.globalAlpha = .9; ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = F.LINE; ctx.lineWidth = 1; ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = F.INK; ctx.font = `700 17px ${FONT}`; ctx.fillText(big, bx + 9, by + 20);
    ctx.fillStyle = F.SOFT; ctx.font = `500 11px ${FONT}`; lines.forEach((l, i) => ctx.fillText(l, bx + 9, by + 37 + i * 15));
  }

  function drawPlot(hi = -1) {
    plHold.replaceChildren();
    if (!plot) {
      cv.hidden = true; plTitle.textContent = ''; plCap.textContent = '';
      plHold.append(el('p', { className: 'mini', textContent: sel ? 'No data to plot for this pair.' : 'Click a cell in the matrix to see that pair as a scatter plot, or a diagonal cell for one series’ histogram.' }));
      return;
    }
    if (plot.hist) return drawHist(hi);
    cv.hidden = false;
    const { A, B, xs, ys, s, res } = plot;
    plTitle.replaceChildren();
    for (const [t, tail] of [[A, ' (x)'], [B, ' (y)']]) { const i = el('i'); i.style.background = t.color; plTitle.append(i, el('b', { textContent: t.name }), document.createTextNode(tail + (t === A ? '  vs  ' : ''))); }
    if (xs.length < MIN_PAIRS) {
      cv.hidden = true; plCap.textContent = '';
      plHold.append(el('p', { className: 'mini', textContent: `Only ${xs.length} ${NOUN[res]} where both have a value in this range. Widen the range on the timeline, or compare by week or month.` }));
      return;
    }
    cv.setAttribute('aria-label', `Scatter plot of ${A.name} against ${B.name}${s.r != null ? `, r = ${fmtR(s.r)}` : ''}, ${xs.length} ${NOUN[res]}`);
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const pad = (a, b) => { const d = (b - a) || Math.abs(a) * 0.1 || 1; return [a - d * 0.06, b + d * 0.06]; };
    const [px0, px1] = pad(xmin, xmax), [py0, py1] = pad(ymin, ymax);
    const F = frame({ xlo: px0, xhi: px1, ylo: py0, yhi: py1, xTitle: axisName(A, res), yTitle: axisName(B, res) });
    const { INK, ACC, x0, x1, y0, y1, sx, sy } = F;

    // dots
    const dense = xs.length > 400;
    ctx.fillStyle = ACC; ctx.globalAlpha = dense ? 0.4 : 0.7;
    const rad = dense ? 2.3 : 3.3;
    for (let i = 0; i < xs.length; i++) { ctx.beginPath(); ctx.arc(sx(xs[i]), sy(ys[i]), rad, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;

    // dotted least-squares line across the data's x extent
    if (s.r != null) {
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      ctx.strokeStyle = INK; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.setLineDash([0.1, 6]);
      ctx.beginPath(); ctx.moveTo(sx(xmin), sy(s.icpt + s.slope * xmin)); ctx.lineTo(sx(xmax), sy(s.icpt + s.slope * xmax)); ctx.stroke();
      ctx.restore();
    }

    // r, n and R², out of the way of the dots: top-left when the fit rises, top-right when it falls
    statBox(F, !(s.r != null && s.r < 0), s.r == null ? 'r undefined' : `r = ${fmtR(s.r)}`, [s.r == null ? `${xs.length} ${NOUN[res]}` : `n = ${xs.length} ${NOUN[res]} · R² = ${(s.r * s.r).toFixed(2)}`]);

    if (hi >= 0) {
      ctx.fillStyle = F.PANEL; ctx.beginPath(); ctx.arc(sx(xs[hi]), sy(ys[hi]), 6, 0, 7); ctx.fill();
      ctx.fillStyle = ACC; ctx.beginPath(); ctx.arc(sx(xs[hi]), sy(ys[hi]), 4.2, 0, 7); ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 1.2; ctx.stroke();
    }
    plot.sx = sx; plot.sy = sy;
    const rg = getRange();
    const fitTxt = s.r != null ? ` Fit: y = ${fmtSig(s.icpt)} ${s.slope < 0 ? '−' : '+'} ${fmtSig(Math.abs(s.slope))}·x.` : '';
    plCap.textContent = `Each dot is one ${res} ${rg ? 'in the selected range' : 'of all time'}. The dotted line is the straight-line fit.${fitTxt} Hover a dot for its ${res}.`;
  }

  /* the histogram of one series: how many days/weeks/months fall in each band of values */
  function drawHist(hi) {
    const { A, vals, res, h, d } = plot;
    plTitle.replaceChildren();
    const sw = el('i'); sw.style.background = A.color;
    plTitle.append(sw, el('b', { textContent: A.name }), document.createTextNode('  ·  distribution'));
    if (vals.length < MIN_PAIRS) {
      cv.hidden = true; plCap.textContent = '';
      plHold.append(el('p', { className: 'mini', textContent: `Only ${vals.length} ${NOUN[res]} with a value in this range. Widen the range on the timeline, or compare by week or month.` }));
      return;
    }
    cv.hidden = false;
    cv.setAttribute('aria-label', `Histogram of ${A.name}, ${d.n} ${NOUN[res]}, mean ${fmtNum(d.mean)}`);
    sizePlot();
    const yhi = h.max / Math.max(0.5, 1 - (46 + 16) / (PH - 60));   // enough room above the tallest bar for the two-line stats box (46px) in either corner
    const F = frame({ xlo: h.edges[0], xhi: h.edges[h.edges.length - 1], ylo: 0, yhi, xTitle: axisName(A, res), yTitle: `Number of ${NOUN[res]}`, intY: true });
    const { INK, x0, x1, y0, y1, sx, sy } = F;
    plot.bars = h.counts.map((n, i) => ({ x0: sx(h.edges[i]), x1: sx(h.edges[i + 1]), top: sy(n), lo: h.edges[i], hi: h.edges[i + 1], n }));
    plot.sx = sx; plot.sy = sy; plot.y0 = y0; plot.y1 = y1;
    ctx.fillStyle = A.color;
    plot.bars.forEach((b, i) => { ctx.globalAlpha = i === hi ? 1 : 0.82; ctx.fillRect(b.x0 + 0.5, b.top, Math.max(1, b.x1 - b.x0 - 1), y1 - b.top); });
    ctx.globalAlpha = 1;
    if (hi >= 0) { const b = plot.bars[hi]; ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.strokeRect(b.x0 + 1, b.top + .5, Math.max(1, b.x1 - b.x0 - 2), y1 - b.top - .5); }
    // dotted line at the mean, like the fit line on a scatter plot
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    ctx.strokeStyle = INK; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.setLineDash([0.1, 6]);
    ctx.beginPath(); ctx.moveTo(sx(d.mean), y0); ctx.lineTo(sx(d.mean), y1); ctx.stroke();
    ctx.restore();
    // the numbers, over whichever side the bars leave free
    const unit = A.config.unit ? ' ' + A.config.unit : '';
    statBox(F, d.mean >= (h.edges[0] + h.edges[h.edges.length - 1]) / 2, `mean ${fmtNum(d.mean)}${unit}`, [`median ${fmtNum(d.median)} · sd ${fmtNum(d.sd)} · n = ${d.n}`]);
    const rg = getRange();
    plCap.textContent = `Each bar counts the ${NOUN[res]} ${rg ? 'in the selected range ' : ''}whose value falls in that band, ${fmtNum(h.step)}${A.config.unit ? ' ' + A.config.unit : ''} wide. The dotted line is the mean. ${d.n} ${NOUN[res]}, from ${fmtNum(d.min)} to ${fmtNum(d.max)}${A.config.unit ? ' ' + A.config.unit : ''}. Hover a bar for its count.`;
  }

  /* hover: the nearest dot says which day/week/month it is */
  const bucketText = (k, res) => (res === 'day' ? prettyDate(dnToStr(k)) : res === 'week' ? `Week of ${prettyDate(dnToStr(k))}` : `${MON[ymd(k)[1]]} ${ymd(k)[0]}`);
  const placeTip = (e) => {
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 14)) + 'px';
    tip.style.top = Math.max(8, Math.min(innerHeight - h - 8, e.clientY + 16)) + 'px';
  };
  cv.addEventListener('pointermove', (e) => {
    if (!plot?.sx) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (plot.hist) {   // histogram: the bar whose column the pointer is in
      const best = y >= plot.y0 && y <= plot.y1 ? plot.bars.findIndex((b) => x >= b.x0 && x < b.x1) : -1;
      if (best !== hoverIdx) { hoverIdx = best; drawPlot(best); }
      if (best < 0) { tip.hidden = true; return; }
      const b = plot.bars[best], u = plot.A.config.unit;
      tip.replaceChildren(el('b', { textContent: `${fmtNum(b.lo)} to ${fmtNum(b.hi)}${u ? ' ' + u : ''}` }), el('div', {}, document.createTextNode(`${b.n} ${b.n === 1 ? plot.res : NOUN[plot.res]} · ${(100 * b.n / plot.vals.length).toFixed(0)}%`)));
      placeTip(e); return;
    }
    let best = -1, bd = 12 * 12;
    for (let i = 0; i < plot.xs.length; i++) { const dx = plot.sx(plot.xs[i]) - x, dy = plot.sy(plot.ys[i]) - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    if (best !== hoverIdx) { hoverIdx = best; drawPlot(best); }
    if (best < 0) { tip.hidden = true; return; }
    tip.replaceChildren(el('b', { textContent: bucketText(plot.ks[best], plot.res) }));
    for (const [t, v] of [[plot.A, plot.xs[best]], [plot.B, plot.ys[best]]]) {
      const sw = el('span', { className: 'sw' }); sw.style.background = t.color;
      tip.append(el('div', {}, sw, el('b', { textContent: t.name + ' ' }), document.createTextNode(fmtVal(v, t.config.unit))));
    }
    placeTip(e);
  });
  cv.addEventListener('pointerleave', () => { tip.hidden = true; if (hoverIdx >= 0) { hoverIdx = -1; drawPlot(); } });

  new ResizeObserver(() => { if (!host.hidden && plot && Math.abs((pl.clientWidth || 0) - PW) > 40) drawPlot(); }).observe(pl);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!host.hidden) drawPlot(); });

  return { update, refresh };
}
