import type { Candle } from './indicators.js';

/** Provider abstraction so data sources (crypto/stocks/forex) can be swapped. */
export interface MarketDataProvider {
  readonly id: string;
  getCandles(symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
}

export type AssetClass = 'crypto' | 'stock' | 'forex';

export interface MockMarketDataOptions {
  seed?: number;
  startPrice?: number;
  volatility?: number;
}

/**
 * Deterministic mock data provider. Generates a seeded geometric random walk
 * of OHLCV candles. Used for offline development and tests; a real provider
 * (e.g. Binance/Yahoo) implements the same interface.
 */
export class MockMarketDataProvider implements MarketDataProvider {
  readonly id = 'mock-market-data';
  private seed: number;
  private startPrice: number;
  private volatility: number;

  constructor(options: MockMarketDataOptions = {}) {
    this.seed = options.seed ?? 42;
    this.startPrice = options.startPrice ?? 100;
    this.volatility = options.volatility ?? 0.02;
  }

  async getCandles(symbol: string, timeframe: string, limit = 200): Promise<Candle[]> {
    const candles: Candle[] = [];
    let price = this.startPrice;
    const seedForSymbol = this.seed + hashString(symbol) + hashString(timeframe);
    let state = seedForSymbol || 1;

    const stepMs = timeframeToMs(timeframe);
    // Fixed epoch anchor keeps the series deterministic across calls.
    const end = 1_800_000_000_000;
    const start = end - stepMs * limit;

    for (let i = 0; i < limit; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const drift = (state / 0xffffffff - 0.5) * 0.002;
      state = (state * 1664525 + 1013904223) >>> 0;
      const shock = (state / 0xffffffff - 0.5) * 2 * this.volatility;
      const open = price;
      const close = Math.max(0.000001, open * (1 + drift + shock));
      const high = Math.max(open, close) * (1 + Math.abs(shock) * 0.4);
      const low = Math.min(open, close) * (1 - Math.abs(shock) * 0.4);
      const volume = 1000 + (state % 10000);
      candles.push({ timestamp: start + stepMs * i, open, high, low, close, volume });
      price = close;
    }
    return candles;
  }
}

/** Deterministic symbol hash for reproducible series. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function timeframeToMs(tf: string): number {
  const m = tf.match(/^(\d+)([mhdw])$/);
  if (!m) return 3600_000;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'm': return n * 60_000;
    case 'h': return n * 3600_000;
    case 'd': return n * 86400_000;
    case 'w': return n * 7 * 86400_000;
    default: return 3600_000;
  }
}

// ---------------------------------------------------------------------------
// Real market data: Binance public REST (no API key). Falls back to mock when
// the network is unavailable so offline development still works.
// ---------------------------------------------------------------------------

// Binance public market-data host (see the explanation in src/market/feed.ts).
const BINANCE_KLINES = 'https://data-api.binance.vision/api/v3/klines';

const TIMEFRAME_TO_INTERVAL: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
  '1d': '1d', '3d': '3d', '1w': '1w',
};

/** Normalize a user-facing symbol ("btcusd", "BTC", "ETHUSD") to a Binance pair. */
export function normalizeBinanceSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return 'BTCUSDT';
  if (/USDT$/.test(s)) return s;
  if (/USD$/.test(s)) return s.slice(0, -3) + 'USDT';
  const known = /^(BTC|ETH|SOL|BNB|XRP|ADA|DOGE|AVAX|LINK|DOT|LTC|POL|MATIC|TRX|TON|NEAR|APT|ARB|OP|SUI|PEPE|SHIB|UNI|AAVE|ATOM|XLM|FIL|ICP|ETC|BCH)(USDC|BUSD|EUR|GBP)?$/;
  const base = known.exec(s)?.[1];
  if (base) return base + 'USDT';
  return s + 'USDT';
}

export class BinanceMarketDataProvider implements MarketDataProvider {
  readonly id = 'binance';
  private fallback = new MockMarketDataProvider({ seed: 7, startPrice: 100, volatility: 0.02 });
  /** Where the last getCandles response actually came from (honesty marker). */
  lastSource: 'binance' | 'mock' = 'binance';

  async getCandles(symbol: string, timeframe: string, limit = 200): Promise<Candle[]> {
    const pair = normalizeBinanceSymbol(symbol);
    const interval = TIMEFRAME_TO_INTERVAL[timeframe] ?? '1h';
    try {
      const res = await fetch(`${BINANCE_KLINES}?symbol=${pair}&interval=${interval}&limit=${Math.min(Math.max(limit, 1), 1000)}`);
      if (!res.ok) throw new Error(`binance responded ${res.status}`);
      const rows = (await res.json()) as unknown[][];
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty klines');
      this.lastSource = 'binance';
      return rows.map((k) => ({
        timestamp: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }));
    } catch {
      this.lastSource = 'mock';
      return this.fallback.getCandles(symbol, timeframe, limit);
    }
  }
}
