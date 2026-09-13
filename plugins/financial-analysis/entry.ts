import {
  adx,
  atr,
  bollinger,
  closes,
  lastValue,
  macd,
  round,
  rsi,
  sma,
  stochastic,
  type Candle,
} from './lib/indicators.js';
import { backtest, type BacktestParams, type StrategyName } from './lib/backtest.js';
import { atrStopLoss, atrTakeProfit, positionSize, riskReward } from './lib/risk.js';
import { BinanceMarketDataProvider, type MarketDataProvider } from './lib/market-data.js';
import { NewsProvider } from '../../src/market/news.js';
import { financialIntelligence } from './intelligence.js';
import type { PluginModule } from '../../src/types/plugin.js';
import type { ToolContext, ToolResult } from '../../src/types/tool.js';

// ---------------------------------------------------------------------------
// Market data provider — live Binance feed with mock fallback for offline use.
// ---------------------------------------------------------------------------
const marketData: MarketDataProvider = new BinanceMarketDataProvider();

// Real news provider — RSS headlines (CoinDesk, CoinTelegraph, Decrypt, Bloomberg).
const news = new NewsProvider();

function toolResult(ok: boolean, output: string, data?: unknown, error?: string): { ok: boolean; output: string; data?: unknown; error?: string } {
  return { ok, output, data, error };
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

async function getCandles(symbol: string, timeframe: string, limit = 200): Promise<Candle[]> {
  return marketData.getCandles(symbol, timeframe, Math.min(Math.max(limit, 20), 1000));
}

function computeIndicatorSnapshot(candles: Candle[]): Record<string, unknown> {
  const close = closes(candles);
  const rsiSeries = rsi(close, 14);
  const m = macd(close, 12, 26, 9);
  const b = bollinger(close, 20, 2);
  const s = sma(close, 20);
  const e = sma(close, 50);
  const a = adx(candles, 14);
  const st = stochastic(candles, 14, 3, 3);
  const atrSeries = atr(candles, 14);
  const price = close[close.length - 1];

  return {
    price: round(price, 6),
    rsi: round(lastValue(rsiSeries), 2),
    macd: round(lastValue(m.macd), 6),
    macd_signal: round(lastValue(m.signal), 6),
    macd_histogram: round(lastValue(m.histogram), 6),
    bollinger_upper: round(lastValue(b.upper), 6),
    bollinger_middle: round(lastValue(b.middle), 6),
    bollinger_lower: round(lastValue(b.lower), 6),
    sma_20: round(lastValue(s), 6),
    sma_50: round(lastValue(e), 6),
    adx: round(lastValue(a.adx), 2),
    plus_di: round(lastValue(a.plusDi), 2),
    minus_di: round(lastValue(a.minusDi), 2),
    stochastic_k: round(lastValue(st.k), 2),
    stochastic_d: round(lastValue(st.d), 2),
    atr: round(lastValue(atrSeries), 6),
  };
}

const entry: PluginModule = {
  intelligence: financialIntelligence,
  tools: {
    market_data: {
      description: 'Fetch OHLCV market data for a symbol (crypto, stock, or forex). Returns the most recent candles.',
      permissions: ['network'],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol, e.g. BTCUSDT, AAPL, EURUSD.' },
          timeframe: { type: 'string', enum: ['1h', '4h', '1d', '1w'], description: 'Candle timeframe.' },
          asset_class: { type: 'string', enum: ['crypto', 'stock', 'forex'], description: 'Asset class.' },
          limit: { type: 'integer', description: 'Number of candles (default 200).' },
        },
        required: ['symbol', 'timeframe'],
      },
      async execute(input) {
        const candles = await getCandles(String(input.symbol), String(input.timeframe), Number(input.limit ?? 200));
        return toolResult(true, json({ symbol: input.symbol, timeframe: input.timeframe, candles: candles.slice(-10) }), {
          count: candles.length,
          latest: candles[candles.length - 1],
        });
      },
    },

    technical_indicators: {
      description: 'Compute technical indicators (RSI, MACD, Bollinger Bands, SMA, EMA, ADX, Stochastic, ATR) for a symbol/timeframe.',
      permissions: ['network'],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          timeframe: { type: 'string', enum: ['1h', '4h', '1d', '1w'] },
          asset_class: { type: 'string', enum: ['crypto', 'stock', 'forex'] },
        },
        required: ['symbol', 'timeframe'],
      },
      async execute(input) {
        const candles = await getCandles(String(input.symbol), String(input.timeframe));
        const snapshot = computeIndicatorSnapshot(candles);
        return toolResult(true, json({ symbol: input.symbol, timeframe: input.timeframe, indicators: snapshot }), snapshot);
      },
    },

    multi_timeframe_analysis: {
      description: 'Compute technical indicators across multiple timeframes (1h/4h/1d/1w) and return a combined read.',
      permissions: ['network'],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          asset_class: { type: 'string', enum: ['crypto', 'stock', 'forex'] },
          timeframes: { type: 'array', items: { type: 'string' }, description: 'Defaults to 1h, 4h, 1d, 1w.' },
        },
        required: ['symbol'],
      },
      async execute(input) {
        const timeframes = (input.timeframes as string[] | undefined) ?? ['1h', '4h', '1d', '1w'];
        const frames: Record<string, unknown> = {};
        for (const tf of timeframes) {
          const candles = await getCandles(String(input.symbol), tf);
          frames[tf] = computeIndicatorSnapshot(candles);
        }
        return toolResult(true, json({ symbol: input.symbol, timeframes: frames }), frames);
      },
    },

    news_feed: {
      description: 'Fetch the latest real news headlines (CoinDesk, CoinTelegraph, Decrypt, Bloomberg Markets), optionally filtered by symbol.',
      permissions: ['network'],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Optional symbol to filter by, e.g. BTCUSDT.' },
          limit: { type: 'integer', description: 'Max headlines (default 10).' },
        },
        required: [],
      },
      async execute(input) {
        const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 25);
        const items = input.symbol
          ? await news.getHeadlines(String(input.symbol), limit)
          : await news.getAllHeadlines(limit);
        const simplified = items.map((it) => ({ title: it.title, source: it.source, published: it.published }));
        return toolResult(true, json({ count: simplified.length, headlines: simplified }), { headlines: simplified });
      },
    },

    sentiment_analysis: {
      description: 'Score market sentiment from the LATEST real news headlines (CoinDesk, CoinTelegraph, Decrypt, Bloomberg) for a symbol. Returns sentiment, score, confidence, and the headlines used.',
      permissions: ['network'],
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
      async execute(input) {
        const symbol = String(input.symbol);
        const read = await news.sentiment(symbol);
        const output = {
          symbol,
          provider: 'rss-news (CoinDesk, CoinTelegraph, Decrypt, Bloomberg)',
          sentiment: read.label,
          score: read.score,
          confidence: read.confidence,
          counts: { bullish: read.bullish, bearish: read.bearish, neutral: read.neutral },
          headlineCount: read.headlineCount,
          headlines: read.headlines.slice(0, 8).map((h) => `${h.title} — ${h.source}`),
        };
        return toolResult(true, json(output), { symbol, sentiment: read.label, score: read.score, confidence: read.confidence });
      },
    },

    macro_analysis: {
      description: 'Macro snapshot built from the LATEST real market news (Bloomberg Markets + crypto feeds): rate/inflation/central-bank headlines plus a macro stance read.',
      permissions: ['network'],
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute() {
        const headlines = await news.macroHeadlines(10);
        const read = await news.sentiment('BTC'); // broad market tone as a proxy
        const stance = read.label === 'bullish' ? 'risk-on' : read.label === 'bearish' ? 'risk-off' : 'mixed';
        const snapshot = {
          provider: 'rss-news (Bloomberg Markets + crypto feeds)',
          macro_stance: stance,
          market_tone: read.label,
          tone_score: read.score,
          key_headlines: headlines.map((h) => `${h.title} — ${h.source}${h.published ? ` (${h.published.slice(0, 10)})` : ''}`),
          note: 'macro read derived from current news headlines (rates, inflation, central banks)',
        };
        return toolResult(true, json(snapshot), { stance, tone: read.label });
      },
    },

    backtest: {
      description: 'Run a basic backtest of a strategy (sma_cross, macd_cross, rsi_reversion, bollinger_reversion) on a symbol/timeframe.',
      permissions: ['network'],
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          timeframe: { type: 'string', enum: ['1h', '4h', '1d', '1w'] },
          strategy: { type: 'string', enum: ['sma_cross', 'macd_cross', 'rsi_reversion', 'bollinger_reversion'] },
          fast: { type: 'integer' },
          slow: { type: 'integer' },
          rsi_period: { type: 'integer' },
          rsi_oversold: { type: 'integer' },
          rsi_overbought: { type: 'integer' },
          initial_capital: { type: 'number' },
        },
        required: ['symbol', 'timeframe', 'strategy'],
      },
      async execute(input) {
        const candles = await getCandles(String(input.symbol), String(input.timeframe), 400);
        const params: BacktestParams = {
          strategy: String(input.strategy) as StrategyName,
          fast: input.fast ? Number(input.fast) : undefined,
          slow: input.slow ? Number(input.slow) : undefined,
          rsiPeriod: input.rsi_period ? Number(input.rsi_period) : undefined,
          rsiOversold: input.rsi_oversold ? Number(input.rsi_oversold) : undefined,
          rsiOverbought: input.rsi_overbought ? Number(input.rsi_overbought) : undefined,
          initialCapital: input.initial_capital ? Number(input.initial_capital) : undefined,
        };
        const result = backtest(candles, params);
        return toolResult(true, json({ symbol: input.symbol, timeframe: input.timeframe, ...result }), result);
      },
    },

    risk_calculator: {
      description: 'Calculate position size, stop loss, take profit, ATR-based risk and risk/reward ratio. Analytical only — no execution.',
      inputSchema: {
        type: 'object',
        properties: {
          account_equity: { type: 'number', description: 'Total account equity.' },
          entry_price: { type: 'number' },
          stop_loss: { type: 'number', description: 'Optional explicit stop; use ATR if omitted.' },
          take_profit: { type: 'number', description: 'Optional explicit target.' },
          risk_percent: { type: 'number', description: 'Fraction of equity to risk, e.g. 0.01 for 1%.' },
          atr_multiplier: { type: 'number', description: 'ATR multiplier for stop (default 2).' },
          symbol: { type: 'string', description: 'For ATR-based stop.' },
          timeframe: { type: 'string', enum: ['1h', '4h', '1d', '1w'] },
        },
        required: ['account_equity', 'entry_price'],
      },
      async execute(input) {
        const equity = Number(input.account_equity);
        const entry = Number(input.entry_price);
        const riskPercent = input.risk_percent !== undefined ? Number(input.risk_percent) : 0.01;

        let stop = input.stop_loss !== undefined ? Number(input.stop_loss) : undefined;
        let atrValue: number | undefined;
        if (stop === undefined && input.symbol) {
          const candles = await getCandles(String(input.symbol), String(input.timeframe ?? '1d'));
          atrValue = lastValue(atr(candles, 14)) ?? undefined;
          stop = atrValue !== undefined ? atrStopLoss(entry, atrValue, Number(input.atr_multiplier ?? 2)) : entry * 0.95;
        }
        stop = stop ?? entry * 0.95;
        const tp = input.take_profit !== undefined ? Number(input.take_profit) : atrTakeProfit(entry, atrValue ?? stop * 0.5, 2, Number(input.atr_multiplier ?? 2));

        const size = positionSize({ accountEquity: equity, entryPrice: entry, stopLoss: stop, riskPercent });
        const rr = riskReward({ entryPrice: entry, stopLoss: stop, takeProfit: tp });

        const result = {
          position_size: round(size.positionSize, 6),
          risk_amount: round(size.riskAmount, 2),
          stop_loss: round(stop, 6),
          take_profit: round(tp, 6),
          stop_distance_pct: round(size.stopDistancePct * 100, 2),
          risk_reward_ratio: round(rr.riskRewardRatio, 2),
          breakeven_win_rate: round(rr.breakevenWinRate * 100, 2),
          atr: round(atrValue ?? NaN, 6),
          note: 'analytical sizing only — not trade execution',
        };
        return toolResult(true, json(result), result);
      },
    },

    journal_prediction: {
      description: 'Store a prediction in the journal (asset, timeframe, prediction, confidence, reasoning, indicators). Later evaluated for correctness.',
      inputSchema: {
        type: 'object',
        properties: {
          asset: { type: 'string' },
          timeframe: { type: 'string', enum: ['1h', '4h', '1d', '1w'] },
          prediction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
          confidence: { type: 'number', description: '0..1' },
          reasoning: { type: 'object' },
          indicators: { type: 'object' },
        },
        required: ['asset', 'prediction'],
      },
      async execute(input, ctx: unknown) {
        const context = ctx as ToolContext;
        const repository = (context.runtime as { repository?: { recordPrediction(e: Record<string, unknown>): Promise<void> } } | undefined)?.repository;
        const prediction = {
          asset: String(input.asset),
          timeframe: input.timeframe ? String(input.timeframe) : undefined,
          prediction: String(input.prediction),
          confidence: input.confidence !== undefined ? Number(input.confidence) : undefined,
          reasoning: input.reasoning ?? {},
          indicators: input.indicators ?? {},
          plugin: 'financial-analysis',
          timestamp: new Date().toISOString(),
        };
        if (repository) {
          await repository.recordPrediction(prediction);
          return toolResult(true, `prediction journaled for ${prediction.asset} (${prediction.prediction})`, prediction);
        }
        return toolResult(false, 'journal repository unavailable', undefined, 'no repository');
      },
    },
  },

  hooks: {
    'prediction-log': async (context) => {
      // Journal every tool result that carries a prediction payload.
      const payload = context as {
        sessionId?: string;
        result?: { data?: { prediction?: string; asset?: string; confidence?: number; timeframe?: string } };
        runtime?: { repository?: { recordJournal(e: { sessionId?: string; eventType: string; payload: unknown }): Promise<void> } };
      };
      const data = payload.result?.data;
      if (data?.prediction && data?.asset) {
        const repo = payload.runtime?.repository;
        if (repo) {
          await repo.recordJournal({
            sessionId: payload.sessionId,
            eventType: 'prediction',
            payload: { asset: data.asset, prediction: data.prediction, confidence: data.confidence, timeframe: data.timeframe, ts: new Date().toISOString() },
          });
        }
      }
    },
  },

  commands: {
    scan: async (args) => {
      const symbol = args.trim().split(/\s+/)[0] || 'BTCUSDT';
      const candles = await getCandles(symbol, '4h');
      const snapshot = computeIndicatorSnapshot(candles);
      return `scan ${symbol} (4h): price=${snapshot.price} rsi=${snapshot.rsi} adx=${snapshot.adx} macd_hist=${snapshot.macd_histogram}`;
    },
    analyze: async (args) => {
      const symbol = args.trim().split(/\s+/)[0] || 'AAPL';
      const candles = await getCandles(symbol, '1d');
      const snapshot = computeIndicatorSnapshot(candles);
      return `analyze ${symbol} (1d):\n${json(snapshot)}`;
    },
  },
};

export default entry;
