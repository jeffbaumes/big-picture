// Life expectancy, kept deliberately simple. Two numbers describe it:
//   expectancy — expected age at death, from birth (default 80)
//   spread     — roughly how many years either side the fade covers (default 10)
// Mortality is Gompertz: hazard h(x) = (1/b)·exp((x − M)/b); M is chosen so the mean age at death equals `expectancy`.
// The page uses the resulting survival curve to fade days out smoothly instead of cutting off at one date.

export const DEFAULT_LIFE = { expectancy: 80, spread: 10 };
const MAXAGE = 125, STEP = 0.5;

export function cleanLife(l) {
  const n = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  return { expectancy: n(l?.expectancy, 20, 110, DEFAULT_LIFE.expectancy), spread: n(l?.spread, 3, 25, DEFAULT_LIFE.spread) };
}

const surv = (x, M, b) => Math.exp(-Math.exp(-M / b) * (Math.exp(x / b) - 1));

function meanAge(M, b) {
  let s = 0;
  for (let x = 0; x < MAXAGE; x += 0.25) s += surv(x + 0.125, M, b) * 0.25;
  return s;
}

/* Survival curve from birth (one number per half year) for the client to fade days with. */
export function lifeModel(lifeIn) {
  const life = cleanLife(lifeIn);
  const b = life.spread;
  let lo = 20, hi = 130;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (meanAge(mid, b) < life.expectancy) lo = mid; else hi = mid; }
  const M = (lo + hi) / 2;
  const curve = [];
  for (let x = 0; x <= MAXAGE; x += STEP) curve.push(Math.round(surv(x, M, b) * 10000) / 10000);
  return { life, step: STEP, curve };
}
