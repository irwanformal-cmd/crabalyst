/**
 * Statistical primitives used by the built-in analysts.
 * Pure functions over numeric series — domain-agnostic, fully deterministic.
 */
import type { Anomaly, ForecastPoint } from './types.js';

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function min(xs: number[]): number {
  return xs.length ? Math.min(...xs) : NaN;
}

export function max(xs: number[]): number {
  return xs.length ? Math.max(...xs) : NaN;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Percentage change from first to last (0 when |first| is ~0). */
export function pctChange(series: number[]): number {
  if (series.length < 2) return 0;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  if (Math.abs(first) < 1e-12) return 0;
  return ((last - first) / Math.abs(first)) * 100;
}

export function rollingMean(series: number[], window: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const start = Math.max(0, i - window + 1);
    out.push(mean(series.slice(start, i + 1)));
  }
  return out;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
}

/** Ordinary least squares over index positions. */
export function linearRegression(series: number[]): LinearFit {
  const n = series.length;
  if (n < 2) return { slope: 0, intercept: series[0] ?? 0, r2: 0 };
  const xs = series.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(series);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (series[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  // R²
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fit = intercept + slope * xs[i]!;
    ssRes += (series[i]! - fit) ** 2;
    ssTot += (series[i]! - my) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

/** Pearson correlation coefficient between two aligned series. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom === 0 ? 0 : sxy / denom;
}

export type TrendDirection = 'up' | 'down' | 'flat';

/** Classify trend direction from slope relative to series scale. */
export function trendDirection(series: number[]): { direction: TrendDirection; slope: number; r2: number; strength: 'strong' | 'moderate' | 'weak' } {
  const fit = linearRegression(series);
  const scale = Math.abs(mean(series)) || 1;
  const slopePct = (fit.slope * series.length) / scale; // total drift over the window
  let direction: TrendDirection = 'flat';
  if (slopePct > 0.02) direction = 'up';
  else if (slopePct < -0.02) direction = 'down';
  const strength = fit.r2 > 0.6 && Math.abs(slopePct) > 0.05 ? 'strong' : fit.r2 > 0.25 ? 'moderate' : 'weak';
  return { direction, slope: fit.slope, r2: fit.r2, strength };
}

/** Normalized volatility: stdev of period-over-period returns, in percent. */
export function volatilityPct(series: number[]): number {
  if (series.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    if (Math.abs(prev) < 1e-12) continue;
    returns.push(((series[i]! - prev) / Math.abs(prev)) * 100);
  }
  return returns.length ? stdev(returns) : 0;
}

export interface DetectAnomaliesOptions {
  method?: 'zscore' | 'rolling';
  threshold?: number;
  window?: number;
  metric: string;
  timestamps?: Array<number | string>;
  idPrefix: string;
}

/** Z-score / rolling-baseline anomaly detection with severity ranking. */
export function detectAnomalies(series: number[], opts: DetectAnomaliesOptions): Anomaly[] {
  const method = opts.method ?? 'zscore';
  const threshold = opts.threshold ?? 3;
  const out: Anomaly[] = [];
  if (series.length < 5) return out;

  if (method === 'zscore') {
    const m = mean(series);
    const sd = stdev(series);
    if (sd === 0) return out;
    for (let i = 0; i < series.length; i++) {
      const z = (series[i]! - m) / sd;
      if (Math.abs(z) >= threshold) {
        out.push(makeAnomaly(opts, i, series[i]!, m, z, 'zscore'));
      }
    }
  } else {
    const window = opts.window ?? 20;
    for (let i = window; i < series.length; i++) {
      const base = series.slice(i - window, i);
      const m = mean(base);
      const sd = stdev(base);
      if (sd === 0) {
        // A flat baseline makes any deviation an extreme outlier.
        if (series[i] !== m) {
          const z = series[i]! > m ? threshold + 5 : -(threshold + 5);
          out.push(makeAnomaly(opts, i, series[i]!, m, z, 'rolling'));
        }
        continue;
      }
      const z = (series[i]! - m) / sd;
      if (Math.abs(z) >= threshold) {
        out.push(makeAnomaly(opts, i, series[i]!, m, z, 'rolling'));
      }
    }
  }
  return out.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
}

function makeAnomaly(
  opts: DetectAnomaliesOptions,
  index: number,
  value: number,
  baseline: number,
  deviation: number,
  method: Anomaly['method'],
): Anomaly {
  const abs = Math.abs(deviation);
  const ts = opts.timestamps?.[index];
  return {
    id: `${opts.idPrefix}-anom-${index}`,
    metric: opts.metric,
    index,
    timestamp: ts !== undefined ? new Date(ts).toISOString() : undefined,
    value,
    baseline,
    deviation: Math.round(deviation * 100) / 100,
    method,
    severity: abs >= 5 ? 'high' : abs >= 3.5 ? 'medium' : 'low',
    evidenceIds: [],
  };
}

/** Simple change-point: largest shift between rolling means of two halves. */
export function detectChangePoint(series: number[]): { index: number; magnitude: number } | undefined {
  const n = series.length;
  if (n < 10) return undefined;
  let best: { index: number; magnitude: number } | undefined;
  const w = Math.max(3, Math.floor(n / 10));
  for (let i = w; i < n - w; i++) {
    const before = mean(series.slice(i - w, i));
    const after = mean(series.slice(i, i + w));
    const magnitude = after - before;
    if (!best || Math.abs(magnitude) > Math.abs(best.magnitude)) best = { index: i, magnitude };
  }
  return best;
}

/** Linear/naive forecast with a simple residual-based interval. */
export function forecastSeries(series: number[], horizon: number, timestamps?: number[], stepMs?: number): { points: ForecastPoint[]; method: string; residualStd: number } {
  const n = series.length;
  const fit = linearRegression(series);
  const residuals = series.map((v, i) => v - (fit.intercept + fit.slope * i));
  const residualStd = stdev(residuals);
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const idx = n - 1 + h;
    const y = fit.intercept + fit.slope * idx;
    const spread = residualStd * Math.sqrt(h) * 1.5;
    const x = timestamps && stepMs ? timestamps[n - 1]! + h * stepMs : idx;
    points.push({ x, y: round2(y), lower: round2(y - spread), upper: round2(y + spread) });
  }
  return { points, method: 'linear-regression', residualStd };
}

/** Inter-quartile-range fences for outlier detection. */
export function iqrOutliers(series: number[]): { lower: number; upper: number; outliers: number[] } {
  const s = [...series].sort((a, b) => a - b);
  const q1 = percentile(s, 25);
  const q3 = percentile(s, 75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return { lower, upper, outliers: series.filter((v) => v < lower || v > upper) };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Extract a numeric series from a table column, skipping non-finite values. */
export function columnValues(rows: Array<Record<string, unknown>>, key: string): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const v = Number(row[key]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}
