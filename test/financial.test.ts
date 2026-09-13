import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, adx, stochastic, atr, closes, lastValue } from '../plugins/financial-analysis/lib/indicators.js';
import { backtest } from '../plugins/financial-analysis/lib/backtest.js';
import { positionSize, riskReward } from '../plugins/financial-analysis/lib/risk.js';
import { MockMarketDataProvider } from '../plugins/financial-analysis/lib/market-data.js';
import type { Candle } from '../plugins/financial-analysis/lib/indicators.js';

const closes1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function candlesFromCloses(values: number[]): Candle[] {
  return values.map((c, i) => ({ timestamp: i, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));
}

test('SMA computes rolling mean', () => {
  const out = sma(closes1, 3);
  assert.ok(Number.isNaN(out[0]));
  assert.ok(Number.isNaN(out[1]));
  assert.equal(out[2], 2);
  assert.equal(out[9], 9);
});

test('EMA is within input bounds', () => {
  const out = ema(closes1, 5);
  assert.equal(out[0], 1);
  assert.ok(out.every((v) => v >= 1 && v <= 10));
});

test('RSI stays within 0..100 and converges to 100 on monotonic rise', () => {
  const out = rsi(closes1, 5);
  const last = lastValue(out);
  assert.ok(last !== undefined && last <= 100 && last >= 0);
  assert.equal(last, 100); // pure uptrend → RSI 100
});

test('MACD produces aligned series', () => {
  const m = macd(closes1);
  assert.equal(m.macd.length, closes1.length);
  assert.equal(m.signal.length, closes1.length);
  assert.equal(m.histogram.length, closes1.length);
});

test('Bollinger bands straddle the price', () => {
  const b = bollinger(closes1, 5);
  assert.equal(b.upper.length, closes1.length);
  assert.ok(lastValue(b.upper)! >= lastValue(b.lower)!);
});

test('ADX and ATR and Stochastic produce finite values', () => {
  const candles = candlesFromCloses(closes1.concat([11, 12, 11, 12, 13, 12, 13, 14]));
  const a = adx(candles, 5);
  assert.ok(Number.isFinite(lastValue(a.adx)));
  const atrSeries = atr(candles, 5);
  assert.ok(Number.isFinite(lastValue(atrSeries)));
  const st = stochastic(candles, 5);
  assert.ok(lastValue(st.k)! >= 0 && lastValue(st.k)! <= 100);
});

test('backtest produces trades for sma_cross strategy', async () => {
  const provider = new MockMarketDataProvider({ seed: 7, startPrice: 100, volatility: 0.03 });
  const candles = await provider.getCandles('BTCUSDT', '1h', 300);
  const result = backtest(candles, { strategy: 'sma_cross', fast: 10, slow: 30, initialCapital: 10_000 });
  assert.equal(result.initialCapital, 10_000);
  assert.equal(result.totalTrades, result.trades.length);
  assert.ok(result.wins + result.losses <= result.totalTrades);
  assert.ok(result.finalEquity > 0);
});

test('position sizing respects risk percent', () => {
  const r = positionSize({ accountEquity: 10_000, entryPrice: 100, stopLoss: 95, riskPercent: 0.01 });
  assert.equal(r.riskAmount, 100);
  assert.equal(r.stopDistance, 5);
  assert.equal(r.positionSize, 20);
});

test('risk/reward ratio computes correctly', () => {
  const rr = riskReward({ entryPrice: 100, stopLoss: 95, takeProfit: 110 });
  assert.equal(rr.riskRewardRatio, 2);
  assert.equal(rr.breakevenWinRate, 1 / 3);
});

test('market data provider is deterministic per symbol', async () => {
  const p = new MockMarketDataProvider({ seed: 42 });
  const a = await p.getCandles('BTCUSDT', '4h', 100);
  const b = await p.getCandles('BTCUSDT', '4h', 100);
  assert.deepEqual(a, b);
  assert.equal(a.length, 100);
  assert.ok(a.every((c) => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)));
});
