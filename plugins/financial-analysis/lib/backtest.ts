import { atr, bollinger, closes, macd, rsi, sma, type Candle } from './indicators.js';

export type StrategyName = 'sma_cross' | 'rsi_reversion' | 'macd_cross' | 'bollinger_reversion';

export interface BacktestParams {
  strategy: StrategyName;
  fast?: number;
  slow?: number;
  rsiPeriod?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  initialCapital?: number;
}

export interface Trade {
  entryTime: string | number | undefined;
  exitTime: string | number | undefined;
  entryPrice: number;
  exitPrice: number;
  side: 'long' | 'short';
  pnl: number;
  pnlPct: number;
  bars: number;
}

export interface BacktestResult {
  strategy: string;
  trades: Trade[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalReturnPct: number;
  finalEquity: number;
  initialCapital: number;
  maxDrawdownPct: number;
  profitFactor: number;
  averagePnl: number;
}

type Signal = 'buy' | 'sell' | 'hold';

function signals(candles: Candle[], params: BacktestParams): Signal[] {
  const out: Signal[] = new Array(candles.length).fill('hold');
  const close = closes(candles);

  if (params.strategy === 'sma_cross') {
    const fast = sma(close, params.fast ?? 20);
    const slow = sma(close, params.slow ?? 50);
    for (let i = 1; i < candles.length; i++) {
      if (Number.isFinite(fast[i]) && Number.isFinite(slow[i]) && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1])) {
        if (fast[i - 1]! <= slow[i - 1]! && fast[i]! > slow[i]!) out[i] = 'buy';
        else if (fast[i - 1]! >= slow[i - 1]! && fast[i]! < slow[i]!) out[i] = 'sell';
      }
    }
  } else if (params.strategy === 'macd_cross') {
    const m = macd(close, 12, 26, 9);
    for (let i = 1; i < candles.length; i++) {
      if (Number.isFinite(m.histogram[i]) && Number.isFinite(m.histogram[i - 1])) {
        if (m.histogram[i - 1]! <= 0 && m.histogram[i]! > 0) out[i] = 'buy';
        else if (m.histogram[i - 1]! >= 0 && m.histogram[i]! < 0) out[i] = 'sell';
      }
    }
  } else if (params.strategy === 'rsi_reversion') {
    const r = rsi(close, params.rsiPeriod ?? 14);
    for (let i = 0; i < candles.length; i++) {
      if (Number.isFinite(r[i])) {
        if (r[i]! < (params.rsiOversold ?? 30)) out[i] = 'buy';
        else if (r[i]! > (params.rsiOverbought ?? 70)) out[i] = 'sell';
      }
    }
  } else if (params.strategy === 'bollinger_reversion') {
    const b = bollinger(close, 20, 2);
    for (let i = 0; i < candles.length; i++) {
      if (!Number.isFinite(b.lower[i])) continue;
      if (close[i]! < b.lower[i]!) out[i] = 'buy';
      else if (close[i]! > b.upper[i]!) out[i] = 'sell';
    }
  }
  return out;
}

/**
 * Basic long-only backtester. Executes signals at the close of the bar they
 * appear on. This is an analytical engine — not an execution engine.
 */
export function backtest(candles: Candle[], params: BacktestParams): BacktestResult {
  const initialCapital = params.initialCapital ?? 10_000;
  const sigs = signals(candles, params);
  const trades: Trade[] = [];
  let equity = initialCapital;
  let position: { entry: Candle; index: number } | null = null;
  let peak = initialCapital;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const sig = sigs[i];

    if (position && sig === 'sell') {
      const pnl = candle.close - position.entry.close;
      const pnlPct = pnl / position.entry.close;
      equity += pnl;
      trades.push({
        entryTime: position.entry.timestamp,
        exitTime: candle.timestamp,
        entryPrice: position.entry.close,
        exitPrice: candle.close,
        side: 'long',
        pnl,
        pnlPct,
        bars: i - position.index,
      });
      position = null;
    } else if (!position && sig === 'buy') {
      position = { entry: candle, index: i };
    }
    peak = Math.max(peak, equity);
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  const totalReturnPct = (equity / initialCapital - 1) * 100;
  const maxDrawdownPct = peak > 0 ? ((equity - peak) / peak) * 100 : 0;

  return {
    strategy: params.strategy,
    trades,
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    totalReturnPct,
    finalEquity: equity,
    initialCapital,
    maxDrawdownPct,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    averagePnl: trades.length ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length : 0,
  };
}

export function atrStop(entry: number, atrValue: number, multiplier = 2): number {
  return entry - atrValue * multiplier;
}
