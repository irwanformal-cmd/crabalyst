/**
 * Technical indicator math. Pure functions, no I/O, provider-agnostic.
 * All functions accept an array of numbers (typically closes) or OHLCV candles.
 */

export interface Candle {
  timestamp?: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface IndicatorSeries {
  values: number[];
  /** Aligned with input; leading entries where the indicator is undefined are NaN. */
}

function nanPrefix(n: number): number[] {
  return new Array(n).fill(NaN);
}

/** Simple Moving Average over the last `period` finite values (NaN-aware). */
export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  const window: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isFinite(v)) {
      window.push(v);
      if (window.length > period) window.shift();
    }
    out.push(window.length === period ? window.reduce((a, b) => a + b, 0) / period : NaN);
  }
  return out;
}

/** Exponential Moving Average (seeded with the first value). */
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  }
  return out;
}

/** Relative Strength Index (Wilder smoothing). */
export function rsi(values: number[], period = 14): number[] {
  if (values.length <= period) return nanPrefix(values.length);
  const out: number[] = nanPrefix(period);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = computeRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push(computeRsi(avgGain, avgLoss));
  }
  return out;
}

function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

/** Moving Average Convergence Divergence. */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => emaFast[i]! - emaSlow[i]!);
  const signal = ema(macdLine, signalPeriod);
  const histogram = macdLine.map((v, i) => v - signal[i]!);
  return { macd: macdLine, signal, histogram };
}

export interface BollingerResult {
  middle: number[];
  upper: number[];
  lower: number[];
}

/** Bollinger Bands. */
export function bollinger(values: number[], period = 20, stdDev = 2): BollingerResult {
  const middle = sma(values, period);
  const upper: number[] = nanPrefix(period - 1);
  const lower: number[] = nanPrefix(period - 1);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push(mean + stdDev * sd);
    lower.push(mean - stdDev * sd);
  }
  return { middle, upper, lower };
}

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

/** Average Directional Index (Wilder smoothing). */
export function adx(candles: Candle[], period = 14): AdxResult {
  const n = candles.length;
  const plusDi: number[] = nanPrefix(period);
  const minusDi: number[] = nanPrefix(period);
  const adxOut: number[] = nanPrefix(period * 2 - 1);

  let atr = 0;
  let plusDm = 0;
  let minusDm = 0;

  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const upMove = c.high - prev.high;
    const downMove = prev.low - c.low;
    const pdm = upMove > downMove && upMove > 0 ? upMove : 0;
    const mdm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));

    if (i === 1) {
      atr = tr;
      plusDm = pdm;
      minusDm = mdm;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      plusDm = (plusDm * (period - 1) + pdm) / period;
      minusDm = (minusDm * (period - 1) + mdm) / period;
    }

    if (i >= period) {
      const pdi = atr === 0 ? 0 : 100 * plusDm / atr;
      const mdi = atr === 0 ? 0 : 100 * minusDm / atr;
      plusDi.push(pdi);
      minusDi.push(mdi);
    }
  }

  // ADX is the smoothed DX.
  let adxSum = 0;
  const diValues = plusDi.slice(period).map((p, idx) => ({ p, m: minusDi[period + idx]! }));
  for (let i = 0; i < diValues.length; i++) {
    const { p, m } = diValues[i]!;
    const denom = p + m;
    const dx = denom === 0 ? 0 : 100 * Math.abs(p - m) / denom;
    if (i === 0) adxSum = dx;
    else adxSum = (adxSum * (period - 1) + dx) / period;
    adxOut.push(adxSum);
  }

  return { adx: adxOut, plusDi, minusDi };
}

export interface StochasticResult {
  k: number[];
  d: number[];
}

/** Stochastic oscillator. */
export function stochastic(candles: Candle[], period = 14, kSmooth = 3, dSmooth = 3): StochasticResult {
  const rawK: number[] = nanPrefix(period - 1);
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const highest = Math.max(...window.map((c) => c.high));
    const lowest = Math.min(...window.map((c) => c.low));
    const close = candles[i]!.close;
    rawK.push(highest === lowest ? 50 : 100 * (close - lowest) / (highest - lowest));
  }
  const k = sma(rawK, kSmooth);
  const d = sma(k, dSmooth);
  return { k, d };
}

/** Average True Range (Wilder smoothing). */
export function atr(candles: Candle[], period = 14): number[] {
  const out: number[] = nanPrefix(period);
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      sum += trs[i]!;
      if (i === period - 1) out.push(sum / period);
    } else {
      sum = (sum * (period - 1) + trs[i]!) / period;
      out.push(sum);
    }
  }
  // Align ATR with candles (ATR at index i corresponds to candles[i]).
  return [NaN, ...out.slice(0, candles.length - 1)];
}

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

/** Last defined value in a series, scanning backwards. */
export function lastValue(series: number[]): number | undefined {
  for (let i = series.length - 1; i >= 0; i--) {
    if (Number.isFinite(series[i])) return series[i];
  }
  return undefined;
}

export function round(v: number | undefined, digits = 4): number | null {
  if (v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
