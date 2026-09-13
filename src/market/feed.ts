import { WebSocket } from 'ws';

/**
 * Live 1-minute candlestick feed for the web UI. Backed by Binance's public
 * streams (no API key). Each symbol keeps one upstream WebSocket that combines:
 *   - @kline_1m  → authoritative OHLC + candle close events
 *   - @aggTrade  → high-frequency last-price ticks so the forming candle moves
 *                  tick-by-tick, like a broker chart
 */

export interface CandleTick {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  closed: boolean;
}

// Binance public market-data host reachable without ISP interference on this network.
// data-api/data-stream.binance.vision is Binance's official market-data-only host
// (spot, read-only): paths, queries, and message formats are identical to
// api.binance.com / stream.binance.com.
const BINANCE_STREAM = 'wss://data-stream.binance.vision/stream?streams=';
const BINANCE_KLINES = 'https://data-api.binance.vision/api/v3/klines';
const MINUTE_MS = 60_000;

const KNOWN_BASES = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT',
  'LTC', 'POL', 'MATIC', 'TRX', 'TON', 'NEAR', 'APT', 'ARB', 'OP', 'SUI',
  'PEPE', 'SHIB', 'UNI', 'AAVE', 'ATOM', 'XLM', 'FIL', 'ICP', 'ETC', 'BCH',
];

/** Normalize a user-facing symbol to a Binance USDT pair. */
export function normalizeBinanceSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return 'BTCUSDT';
  if (/USDT$/.test(s)) return s;
  if (/USDC$|BUSD$/.test(s)) return s.replace(/USDC$|BUSD$/, 'USDT');
  if (/USD$/.test(s)) return s.slice(0, -3) + 'USDT';
  if (/BTC$|ETH$/.test(s) && s.length > 3) return s; // cross pair like ETHBTC
  return s + 'USDT';
}

/** Extract the first market symbol from free text ("btcusd market" → BTCUSDT). */
export function detectMarketSymbol(text: string): string | undefined {
  const up = text.toUpperCase();
  const pair = up.match(/\b([A-Z]{2,8})[\/\-_.]?(USDT|USDC|BUSD|USD|EUR|GBP|BTC|ETH)\b/);
  if (pair) return normalizeBinanceSymbol((pair[1] ?? '') + (pair[2] ?? ''));
  for (const base of KNOWN_BASES) {
    if (new RegExp(`\\b${base}\\b`).test(up)) return base + 'USDT';
  }
  return undefined;
}

export interface TradeTick {
  symbol: string;
  price: number;
  qty: number;
  /** USD value of the trade (price × qty). */
  value: number;
  /** 'buy' = taker bought (aggressive buy), 'sell' = taker sold. */
  side: 'buy' | 'sell';
  t: number;
}

type Listener = (tick: CandleTick) => void;
type TradeListener = (trade: TradeTick) => void;

interface SymbolFeed {
  listeners: Set<Listener>;
  tradeListeners: Set<TradeListener>;
  ws?: WebSocket;
  current?: CandleTick;
  lastEmit?: number;
}

export class MarketFeed {
  private feeds = new Map<string, SymbolFeed>();

  /** Recent closed candles for the initial chart render. */
  async history(symbol: string, limit = 60, interval = '1m'): Promise<CandleTick[]> {
    const pair = normalizeBinanceSymbol(symbol);
    try {
      const res = await fetch(`${BINANCE_KLINES}?symbol=${pair}&interval=${interval}&limit=${Math.min(Math.max(limit, 1), 1000)}`);
      if (!res.ok) throw new Error(`binance ${res.status}`);
      const rows = (await res.json()) as unknown[][];
      return rows.map((k) => ({
        t: Number(k[0]),
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        v: Number(k[5]),
        closed: true,
      }));
    } catch {
      return [];
    }
  }

  /** Subscribe to live 1m candles; returns an unsubscribe function. */
  subscribe(symbol: string, listener: Listener): () => void {
    const pair = normalizeBinanceSymbol(symbol);
    let feed = this.feeds.get(pair);
    if (!feed) {
      feed = { listeners: new Set(), tradeListeners: new Set() };
      this.feeds.set(pair, feed);
    }
    feed.listeners.add(listener);
    if (!feed.ws) this.open(pair, feed);
    // Send the current forming candle immediately if we already have one.
    if (feed.current) listener({ ...feed.current });
    return () => {
      feed!.listeners.delete(listener);
      if (feed!.listeners.size === 0 && feed!.tradeListeners.size === 0) this.close(pair, feed!);
    };
  }

  /** Subscribe to the raw aggregated-trade stream (for the whale radar). */
  subscribeTrades(symbol: string, listener: TradeListener): () => void {
    const pair = normalizeBinanceSymbol(symbol);
    let feed = this.feeds.get(pair);
    if (!feed) {
      feed = { listeners: new Set(), tradeListeners: new Set() };
      this.feeds.set(pair, feed);
    }
    feed.tradeListeners.add(listener);
    if (!feed.ws) this.open(pair, feed);
    return () => {
      feed!.tradeListeners.delete(listener);
      if (feed!.listeners.size === 0 && feed!.tradeListeners.size === 0) this.close(pair, feed!);
    };
  }

  private open(pair: string, feed: SymbolFeed): void {
    const streams = `${pair.toLowerCase()}@kline_1m/${pair.toLowerCase()}@aggTrade`;
    const ws = new WebSocket(`${BINANCE_STREAM}${streams}`);
    feed.ws = ws;
    ws.on('message', (data) => {
      try {
        const raw = JSON.parse(String(data)) as { data?: unknown; stream?: string };
        const msg = (raw.data ?? raw) as Record<string, unknown>;
        this.handleMessage(pair, feed, msg);
      } catch {
        // Ignore malformed frames; the feed self-heals on the next message.
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      feed.ws = undefined;
      // Reconnect automatically if clients are still attached.
      if (feed.listeners.size > 0 || feed.tradeListeners.size > 0) setTimeout(() => this.open(pair, feed), 3000);
    });
  }

  private handleMessage(pair: string, feed: SymbolFeed, msg: Record<string, unknown>): void {
    if (msg.e === 'kline') {
      const k = msg.k as Record<string, unknown>;
      const tick: CandleTick = {
        t: Number(k.t),
        o: Number(k.o),
        h: Number(k.h),
        l: Number(k.l),
        c: Number(k.c),
        v: Number(k.v),
        closed: Boolean(k.x),
      };
      feed.current = tick;
      this.emit(feed, tick, true);
      return;
    }

    if (msg.e === 'aggTrade') {
      const price = Number(msg.p);
      const qty = Number(msg.q);
      const time = Number(msg.T ?? msg.E);
      if (!Number.isFinite(price) || !Number.isFinite(time)) return;
      // Fan the raw trade out to whale-radar listeners.
      if (feed.tradeListeners.size > 0 && Number.isFinite(qty)) {
        const trade: TradeTick = {
          symbol: pair,
          price,
          qty,
          value: price * qty,
          side: msg.m ? 'sell' : 'buy', // m=true → maker is buyer → taker SOLD
          t: time,
        };
        for (const listener of feed.tradeListeners) listener(trade);
      }
      const minute = Math.floor(time / MINUTE_MS) * MINUTE_MS;
      let tick = feed.current;
      if (!tick || minute > tick.t) {
        tick = { t: minute, o: price, h: price, l: price, c: price, v: 0, closed: false };
      } else if (minute === tick.t) {
        tick = { ...tick, c: price, h: Math.max(tick.h, price), l: Math.min(tick.l, price), closed: false };
      } else {
        return; // stale trade from a previous candle
      }
      feed.current = tick;
      // Throttle the high-frequency trade stream so the browser redraws ~13fps.
      const now = Date.now();
      if (!feed.lastEmit || now - feed.lastEmit >= 75) {
        feed.lastEmit = now;
        this.emit(feed, tick, false);
      }
    }
  }

  private emit(feed: SymbolFeed, tick: CandleTick, force: boolean): void {
    if (!force && feed.listeners.size === 0) return;
    for (const listener of feed.listeners) listener({ ...tick });
  }

  private close(pair: string, feed: SymbolFeed): void {
    if (feed.ws) {
      feed.ws.close();
      feed.ws = undefined;
    }
    this.feeds.delete(pair);
  }
}
