/**
 * Financial Analysis — Intelligence Layer contributions.
 *
 * Registers crypto/finance entity resolution, market/on-chain/news data
 * sources, and specialist analysts (technical, sentiment, macro, on-chain
 * whale, market risk) into the domain-agnostic engine. The on-chain provider
 * is MOCK and always marked as such.
 */
import {
  adx,
  atr,
  bollinger,
  closes,
  lastValue,
  macd,
  rsi,
  sma,
  type Candle,
} from './lib/indicators.js';
import { BinanceMarketDataProvider } from './lib/market-data.js';
import { MockOnchainProvider } from './lib/onchain.js';
import { atrStopLoss, atrTakeProfit } from './lib/risk.js';
import { NewsProvider } from '../../src/market/news.js';
import { SynonymEntityResolver } from '../../src/intelligence/entities.js';
import { makeEvidence, makeFinding, nextId, pickSeries } from '../../src/intelligence/analysts.js';
import { columnValues, detectAnomalies, mean, pctChange, round2, trendDirection } from '../../src/intelligence/stats.js';
import type { Analyst, DataTable, EvidenceItem, Finding, PluginIntelligence } from './plugin-intel-types.js';

// ---------------------------------------------------------------------------
// Shared providers
// ---------------------------------------------------------------------------

const marketData = new BinanceMarketDataProvider();
const onchain = new MockOnchainProvider();
const news = new NewsProvider();

const TIMEFRAME_LABEL: Record<string, string> = { '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' };

function candlesToTable(symbol: string, timeframe: string, candles: Candle[], mock: boolean): DataTable {
  return {
    id: `ohlcv-${symbol}-${timeframe}`,
    sourceId: 'crypto-market',
    label: `${symbol} · ${TIMEFRAME_LABEL[timeframe] ?? timeframe}`,
    kind: 'ohlcv',
    entity: symbol,
    columns: [
      { key: 't', label: 'time', type: 'timestamp' },
      { key: 'open', label: 'open', type: 'number' },
      { key: 'high', label: 'high', type: 'number' },
      { key: 'low', label: 'low', type: 'number' },
      { key: 'close', label: 'close', type: 'number' },
      { key: 'volume', label: 'volume', type: 'number' },
    ],
    rows: candles.map((c) => ({ t: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    unit: 'USD',
    provenance: mock ? 'mock market data (offline fallback)' : 'binance public REST',
    quality: { completeness: 1, mock },
    meta: { period: TIMEFRAME_LABEL[timeframe] ?? timeframe, timeframe },
  };
}

// ---------------------------------------------------------------------------
// Entity resolution (crypto + macro assets)
// ---------------------------------------------------------------------------

const cryptoEntities = new SynonymEntityResolver('crypto-symbols', [
  { id: 'BTCUSDT', label: 'Bitcoin', kind: 'asset', domain: 'crypto', aliases: ['BTC', 'Bitcoin', 'BTCUSD', 'BTC/USD', 'BTCUSDT'] },
  { id: 'ETHUSDT', label: 'Ethereum', kind: 'asset', domain: 'crypto', aliases: ['ETH', 'Ethereum', 'ETHUSD'] },
  { id: 'SOLUSDT', label: 'Solana', kind: 'asset', domain: 'crypto', aliases: ['SOL', 'Solana'] },
  { id: 'BNBUSDT', label: 'BNB', kind: 'asset', domain: 'crypto', aliases: ['BNB'] },
  { id: 'XRPUSDT', label: 'XRP', kind: 'asset', domain: 'crypto', aliases: ['XRP'] },
  { id: 'DOGEUSDT', label: 'Dogecoin', kind: 'asset', domain: 'crypto', aliases: ['DOGE', 'Dogecoin'] },
  { id: 'ADAUSDT', label: 'Cardano', kind: 'asset', domain: 'crypto', aliases: ['ADA', 'Cardano'] },
  { id: 'AVAXUSDT', label: 'Avalanche', kind: 'asset', domain: 'crypto', aliases: ['AVAX', 'Avalanche'] },
  { id: 'LINKUSDT', label: 'Chainlink', kind: 'asset', domain: 'crypto', aliases: ['LINK', 'Chainlink'] },
  { id: 'DOTUSDT', label: 'Polkadot', kind: 'asset', domain: 'crypto', aliases: ['DOT', 'Polkadot'] },
  { id: 'XAUUSD', label: 'Gold', kind: 'asset', domain: 'finance', aliases: ['gold', 'emas', 'XAU', 'XAUUSD'] },
  { id: 'NASDAQ', label: 'Nasdaq', kind: 'index', domain: 'finance', aliases: ['nasdaq', 'NDX', 'QQQ'] },
  { id: 'DXY', label: 'Dollar Index', kind: 'index', domain: 'finance', aliases: ['DXY', 'dollar index'] },
]);

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

const cryptoMarketSource = {
  id: 'crypto-market',
  label: 'Crypto market (Binance)',
  kind: 'rest',
  domains: ['crypto', 'finance'],
  provides: { kinds: ['ohlcv', 'timeseries'] as Array<'ohlcv' | 'timeseries'>, metrics: ['price', 'volume'] },
  async fetch(req: { query: { depth: string; timeRange?: { kind: string }; intentCategory: string }; entities: Array<{ id: string; domain?: string }> }) {
    const entities = req.entities.filter((e) => e.domain === 'crypto' || e.domain === 'finance');
    if (!entities.length) return [] as DataTable[];
    const deep = req.query.depth === 'deep' || req.query.intentCategory === 'diagnose';
    const timeframes = req.query.timeRange?.kind === 'today' ? ['1h'] : deep ? ['1h', '4h', '1d', '1w'] : ['4h'];
    const tables: DataTable[] = [];
    let budget = 8;
    for (const entity of entities.slice(0, 2)) {
      for (const tf of timeframes) {
        if (budget-- <= 0) break;
        const candles = await marketData.getCandles(entity.id, tf, 200);
        tables.push(candlesToTable(entity.id, tf, candles, marketData.lastSource === 'mock'));
      }
    }
    return tables;
  },
};

const cryptoNewsSource = {
  id: 'crypto-news',
  label: 'Crypto news (RSS)',
  kind: 'rss',
  domains: ['crypto', 'finance'],
  provides: { kinds: ['text'] as Array<'text'>, metrics: ['sentiment'] },
  async fetch(req: { entities: Array<{ id: string }> }) {
    const symbol = req.entities[0]?.id ?? 'BTC';
    try {
      const items = await news.getHeadlines(symbol, 14);
      return [{
        id: `news-${symbol}`,
        sourceId: 'crypto-news',
        label: `headlines · ${symbol}`,
        kind: 'text',
        entity: symbol,
        columns: [
          { key: 'title', label: 'title', type: 'string' },
          { key: 'source', label: 'source', type: 'string' },
          { key: 'published', label: 'published', type: 'timestamp' },
        ],
        rows: items.map((it) => ({ title: it.title, source: it.source, published: it.published })),
        provenance: 'RSS (CoinDesk, CoinTelegraph, Decrypt, Bloomberg)',
        quality: { completeness: items.length ? 1 : 0.2, freshness: items[0]?.published },
      }] as DataTable[];
    } catch {
      return [] as DataTable[];
    }
  },
};

const onchainMockSource = {
  id: 'onchain-mock',
  label: 'On-chain (MOCK)',
  kind: 'mock',
  mock: true,
  domains: ['crypto'],
  provides: { kinds: ['timeseries', 'events'] as Array<'timeseries' | 'events'>, metrics: ['whale', 'onchain', 'flow'] },
  async fetch(req: { query: { analysisTypes: string[]; metrics: string[] }; entities: Array<{ id: string }> }) {
    const wants =
      req.query.metrics.includes('whale') ||
      req.query.metrics.includes('onchain') ||
      req.query.analysisTypes.some((t) => ['onchain', 'flow', 'accumulation_distribution'].includes(t));
    if (!wants) return [] as DataTable[];
    const symbol = req.entities[0]?.id ?? 'BTCUSDT';
    const [flows, balances, transfers] = await Promise.all([
      onchain.exchangeFlows(symbol, 72),
      onchain.whaleBalances(symbol, 72),
      onchain.whaleTransfers(symbol, 24),
    ]);
    return [
      {
        id: `netflow-${symbol}`,
        sourceId: 'onchain-mock',
        label: `exchange netflow · ${symbol}`,
        kind: 'timeseries',
        entity: symbol,
        columns: [
          { key: 't', label: 'time', type: 'timestamp' },
          { key: 'inflow', label: 'exchange inflow', type: 'number', unit: symbol.replace(/USDT$/, '') },
          { key: 'outflow', label: 'exchange outflow', type: 'number', unit: symbol.replace(/USDT$/, '') },
          { key: 'netflow', label: 'netflow', type: 'number' },
        ],
        rows: flows.map((f) => ({ t: f.timestamp, inflow: f.inflow, outflow: f.outflow, netflow: f.netflow })),
        provenance: 'MOCK on-chain provider (synthetic)',
        quality: { completeness: 1, mock: true },
      },
      {
        id: `whalebal-${symbol}`,
        sourceId: 'onchain-mock',
        label: `whale balances · ${symbol}`,
        kind: 'timeseries',
        entity: symbol,
        columns: [
          { key: 't', label: 'time', type: 'timestamp' },
          { key: 'balance', label: 'whale balance', type: 'number' },
        ],
        rows: balances.map((b) => ({ t: b.timestamp, balance: b.balance })),
        provenance: 'MOCK on-chain provider (synthetic)',
        quality: { completeness: 1, mock: true },
      },
      {
        id: `transfers-${symbol}`,
        sourceId: 'onchain-mock',
        label: `large transfers · ${symbol}`,
        kind: 'events',
        entity: symbol,
        columns: [
          { key: 't', label: 'time', type: 'timestamp' },
          { key: 'amount', label: 'amount', type: 'number' },
          { key: 'direction', label: 'direction', type: 'string' },
          { key: 'to', label: 'to', type: 'string' },
        ],
        rows: transfers.map((x) => ({ t: x.timestamp, amount: x.amount, direction: x.direction, to: x.to })),
        provenance: 'MOCK on-chain provider (synthetic)',
        quality: { completeness: 1, mock: true },
      },
    ] as DataTable[];
  },
};

// ---------------------------------------------------------------------------
// Specialist analysts
// ---------------------------------------------------------------------------

function primaryOhlcv(ctx: { query: { subject?: string }; tables: DataTable[] }): DataTable | undefined {
  const ohlcv = ctx.tables.filter((t) => t.kind === 'ohlcv');
  if (!ohlcv.length) return undefined;
  const subject = ctx.query.subject;
  const bySubject = subject ? ohlcv.filter((t) => t.entity === subject) : ohlcv;
  const pool = bySubject.length ? bySubject : ohlcv;
  return pool.find((t) => t.meta?.timeframe === '4h') ?? pool[0];
}

function tableToCandles(table: DataTable): Candle[] {
  return table.rows.map((r) => ({
    timestamp: Number(r.t),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

const technicalAnalyst: Analyst = {
  id: 'technical',
  name: 'Technical Analyst',
  description: 'Indicator-based read: RSI, MACD, Bollinger, SMA, ADX, Stochastic, ATR.',
  supportedIntents: ['analyze', 'trend', 'diagnose', 'evaluate', 'recommend', 'predict', 'compare', 'decide', 'understand', 'discover'],
  analysisTypes: ['technical', 'trend', 'momentum', 'pattern', 'forecast', 'comparison'],
  domains: ['crypto', 'finance'],
  requiredDataTypes: ['ohlcv'],
  reliability: 0.75,
  run(ctx) {
    const table = primaryOhlcv(ctx);
    if (!table) return { analystId: 'technical', ok: false, findings: [], evidence: [], error: 'no OHLCV data', headline: 'no market data' };
    const candles = tableToCandles(table);
    if (candles.length < 60) return { analystId: 'technical', ok: false, findings: [], evidence: [], error: 'not enough candles', headline: 'insufficient candles' };
    const close = closes(candles);
    const price = close[close.length - 1]!;
    const num = (v: number | undefined): number => (v ?? NaN);
    const rsiV = num(lastValue(rsi(close, 14)));
    const m = macd(close, 12, 26, 9);
    const a = adx(candles, 14);
    const s20 = num(lastValue(sma(close, 20)));
    const s50 = num(lastValue(sma(close, 50)));
    const b = bollinger(close, 20, 2);
    const atrV = num(lastValue(atr(candles, 14)));
    const macdHist = num(lastValue(m.histogram));
    const macdLine = num(lastValue(m.macd));
    const macdSignal = num(lastValue(m.signal));
    const adxV = num(lastValue(a.adx));

    const evidence: EvidenceItem[] = [
      makeEvidence({ sourceId: table.sourceId, analystId: 'technical', metric: 'rsi14', value: round2(rsiV), baseline: 50, reliability: 'high', label: `RSI(14) = ${round2(rsiV)}` }),
      makeEvidence({ sourceId: table.sourceId, analystId: 'technical', metric: 'macd_hist', value: round2(macdHist), baseline: 0, reliability: 'high', label: `MACD histogram ${round2(macdHist)}` }),
      makeEvidence({ sourceId: table.sourceId, analystId: 'technical', metric: 'adx14', value: round2(adxV), baseline: 25, reliability: 'high', label: `ADX(14) = ${round2(adxV)}` }),
      makeEvidence({ sourceId: table.sourceId, analystId: 'technical', metric: 'price_vs_sma', value: { price: round2(price), sma20: round2(s20), sma50: round2(s50) }, reliability: 'high', label: `price ${round2(price)} vs SMA20 ${round2(s20)} / SMA50 ${round2(s50)}` }),
    ];

    const rsiState = rsiV >= 70 ? 'overbought' : rsiV <= 30 ? 'oversold' : 'neutral';
    const macdState = macdHist > 0 ? 'positive' : 'negative';
    const trendStrong = adxV >= 25;
    const aboveSma = price > s20 && price > s50;

    const findings: Finding[] = [];
    const f1 = makeFinding({
      title: `RSI ${rsiState} (${round2(rsiV)}), MACD ${macdState}, trend ${trendStrong ? 'strong' : 'weak'} (ADX ${round2(adxV)})`,
      detail: `price ${aboveSma ? 'above' : 'below or mixed vs'} SMA20/SMA50; Bollinger [${round2(num(lastValue(b.lower)))} – ${round2(num(lastValue(b.upper)))}]; ATR ${round2(atrV)}.`,
      analystId: 'technical',
      confidence: trendStrong ? 0.75 : 0.55,
      evidenceIds: evidence.map((e) => e.id),
      tags: ['technical'],
    });
    for (const e of evidence) e.findingIds.push(f1.id);
    findings.push(f1);

    // Directional contribution for the decision synthesizer.
    const bullishSignals = [rsiV > 50 && rsiV < 70, macdState === 'positive', aboveSma, macdLine > macdSignal].filter(Boolean).length;
    const bearishSignals = 4 - bullishSignals;
    const confidence = 0.5 + Math.abs(bullishSignals - bearishSignals) * 0.1;

    return {
      analystId: 'technical',
      ok: true,
      findings,
      evidence,
      confidence: round2(confidence),
      headline: `${bullishSignals > bearishSignals ? 'constructive' : bullishSignals < bearishSignals ? 'bearish-leaning' : 'mixed'} (${bullishSignals}/4 bullish signals)`,
    };
  },
};

const onchainWhaleAnalyst: Analyst = {
  id: 'onchain-whale',
  name: 'On-chain / Whale Analyst',
  description: 'Whale transfers, exchange flows, whale balances, accumulation/distribution. (MOCK data in this deployment.)',
  supportedIntents: ['analyze', 'diagnose', 'discover', 'evaluate'],
  analysisTypes: ['onchain', 'flow', 'accumulation_distribution', 'anomaly'],
  domains: ['crypto'],
  requiredDataTypes: ['timeseries', 'events'],
  reliability: 0.5, // mock data — down-weighted
  run(ctx) {
    const netflowTable = ctx.tables.find((t) => t.sourceId === 'onchain-mock' && t.id.startsWith('netflow'));
    const balanceTable = ctx.tables.find((t) => t.sourceId === 'onchain-mock' && t.id.startsWith('whalebal'));
    const transfersTable = ctx.tables.find((t) => t.sourceId === 'onchain-mock' && t.id.startsWith('transfers'));
    if (!netflowTable && !balanceTable && !transfersTable) {
      return { analystId: 'onchain-whale', ok: false, findings: [], evidence: [], error: 'no on-chain data', headline: 'no on-chain data' };
    }

    const evidence: EvidenceItem[] = [];
    const findings: Finding[] = [];
    let anomalies: import('../../src/intelligence/types.js').Anomaly[] = [];

    if (netflowTable) {
      const outflows = columnValues(netflowTable.rows, 'outflow');
      const netflows = columnValues(netflowTable.rows, 'netflow');
      const ts = netflowTable.rows.map((r) => Number(r.t));
      anomalies = detectAnomalies(outflows, { method: 'zscore', threshold: 2.5, metric: 'exchange outflow', timestamps: ts, idPrefix: 'onchain' });
      const recent = netflows.slice(-24);
      const prior = netflows.slice(-48, -24);
      const recentSum = recent.reduce((s, x) => s + x, 0);
      const priorSum = prior.length ? prior.reduce((s, x) => s + x, 0) : 0;
      const accumulating = recentSum < 0 && recentSum < priorSum; // net outflow = coins leaving exchanges
      const ev = makeEvidence({
        sourceId: 'onchain-mock',
        analystId: 'onchain-whale',
        metric: 'exchange_netflow_24h',
        value: round2(recentSum),
        baseline: round2(priorSum),
        transformation: 'sum(netflow) recent 24h vs prior 24h',
        reliability: 'low',
        label: `netflow 24h ${round2(recentSum)} vs prior ${round2(priorSum)} (negative = outflow)`,
      });
      evidence.push(ev);
      const f = makeFinding({
        title: accumulating
          ? 'Exchange net outflow increased — accumulation pattern'
          : recentSum > 0
            ? 'Exchange net inflow dominant — distribution pattern'
            : 'Exchange flows near neutral',
        detail: `${anomalies.length} abnormal outflow spike(s) detected.`,
        analystId: 'onchain-whale',
        confidence: 0.5,
        evidenceIds: [ev.id],
        tags: ['onchain', 'flow'],
      });
      ev.findingIds.push(f.id);
      findings.push(f);
    }

    if (balanceTable) {
      const balances = columnValues(balanceTable.rows, 'balance');
      const t = trendDirection(balances);
      const change = pctChange(balances);
      const ev = makeEvidence({
        sourceId: 'onchain-mock',
        analystId: 'onchain-whale',
        metric: 'whale_balance_change_pct',
        value: round2(change),
        transformation: 'pctChange over 72h',
        reliability: 'low',
        label: `whale balance ${change >= 0 ? '+' : ''}${round2(change)}% (72h)`,
      });
      evidence.push(ev);
      const f = makeFinding({
        title: `Whale balances ${t.direction === 'up' ? 'growing' : t.direction === 'down' ? 'shrinking' : 'flat'} (${round2(change)}%)`,
        analystId: 'onchain-whale',
        confidence: 0.5,
        evidenceIds: [ev.id],
        tags: ['onchain', 'whale'],
      });
      ev.findingIds.push(f.id);
      findings.push(f);
    }

    if (transfersTable) {
      const amounts = columnValues(transfersTable.rows, 'amount');
      const avg = mean(amounts);
      const large = transfersTable.rows.filter((r) => Number(r.amount) > avg * 2);
      const toExchange = transfersTable.rows.filter((r) => r.direction === 'to-exchange').length;
      const fromExchange = transfersTable.rows.filter((r) => r.direction === 'from-exchange').length;
      const ev = makeEvidence({
        sourceId: 'onchain-mock',
        analystId: 'onchain-whale',
        metric: 'large_transfers_24h',
        value: { count: transfersTable.rows.length, large: large.length, toExchange, fromExchange, avgSize: round2(avg) },
        reliability: 'low',
        label: `${transfersTable.rows.length} transfers (${large.length} large); ${toExchange}→exchanges, ${fromExchange}←exchanges`,
      });
      evidence.push(ev);
      const f = makeFinding({
        title: `${large.length} unusually large transfers in 24h (${toExchange > fromExchange ? 'toward' : 'away from'} exchanges)`,
        analystId: 'onchain-whale',
        confidence: 0.45,
        evidenceIds: [ev.id],
        tags: ['onchain', 'whale'],
      });
      ev.findingIds.push(f.id);
      findings.push(f);
    }

    return {
      analystId: 'onchain-whale',
      ok: findings.length > 0,
      findings,
      evidence,
      anomalies,
      confidence: 0.5,
      headline: findings[0]?.title ?? 'no signal',
    };
  },
};

const sentimentAnalyst: Analyst = {
  id: 'sentiment',
  name: 'Sentiment Analyst',
  description: 'News-based sentiment read from live RSS headlines.',
  supportedIntents: ['analyze', 'diagnose', 'evaluate'],
  analysisTypes: ['sentiment', 'causal'],
  domains: ['crypto', 'finance'],
  requiredDataTypes: ['text'],
  reliability: 0.6,
  async run(ctx) {
    const symbol = ctx.query.subject ?? ctx.query.entities[0]?.id;
    if (!symbol) return { analystId: 'sentiment', ok: false, findings: [], evidence: [], error: 'no subject', headline: 'no subject' };
    try {
      const read = await news.sentiment(symbol);
      if (!read.headlineCount) return { analystId: 'sentiment', ok: false, findings: [], evidence: [], error: 'no headlines', headline: 'no headlines' };
      const ev = makeEvidence({
        sourceId: 'crypto-news',
        analystId: 'sentiment',
        metric: 'news_sentiment',
        value: { label: read.label, score: round2(read.score), bullish: read.bullish, bearish: read.bearish, neutral: read.neutral, n: read.headlineCount },
        reliability: 'medium',
        label: `news sentiment ${read.label} (score ${round2(read.score)}, n=${read.headlineCount})`,
      });
      const f = makeFinding({
        title: `News sentiment is ${read.label} (score ${round2(read.score)}, ${read.headlineCount} headlines)`,
        detail: read.headlines.slice(0, 3).map((h) => `• ${h.title} — ${h.source}`).join('\n'),
        analystId: 'sentiment',
        confidence: round2(read.confidence),
        evidenceIds: [ev.id],
        tags: ['sentiment'],
      });
      ev.findingIds.push(f.id);
      return { analystId: 'sentiment', ok: true, findings: [f], evidence: [ev], confidence: round2(read.confidence), headline: `${read.label} (${round2(read.score)})` };
    } catch (err) {
      return { analystId: 'sentiment', ok: false, findings: [], evidence: [], error: (err as Error).message, headline: 'news unavailable' };
    }
  },
};

const macroAnalyst: Analyst = {
  id: 'macro',
  name: 'Macro Analyst',
  description: 'Macro stance read from market headlines (rates, inflation, central banks).',
  supportedIntents: ['analyze', 'diagnose', 'evaluate'],
  analysisTypes: ['macro', 'causal'],
  domains: ['crypto', 'finance'],
  requiredDataTypes: ['text'],
  reliability: 0.5,
  async run(ctx) {
    try {
      const headlines = await news.macroHeadlines(8);
      if (!headlines.length) return { analystId: 'macro', ok: false, findings: [], evidence: [], error: 'no macro headlines', headline: 'unavailable' };
      const read = await news.sentiment('BTC');
      const stance = read.label === 'bullish' ? 'risk-on' : read.label === 'bearish' ? 'risk-off' : 'mixed';
      const ev = makeEvidence({
        sourceId: 'crypto-news',
        analystId: 'macro',
        metric: 'macro_stance',
        value: { stance, tone: read.label, score: round2(read.score) },
        reliability: 'low',
        label: `macro stance ${stance} (headline-derived)`,
      });
      const f = makeFinding({
        title: `Macro backdrop reads ${stance}`,
        detail: headlines.slice(0, 3).map((h) => `• ${h.title} — ${h.source}`).join('\n'),
        analystId: 'macro',
        confidence: 0.45,
        evidenceIds: [ev.id],
        tags: ['macro'],
      });
      ev.findingIds.push(f.id);
      return { analystId: 'macro', ok: true, findings: [f], evidence: [ev], confidence: 0.45, headline: stance };
    } catch (err) {
      return { analystId: 'macro', ok: false, findings: [], evidence: [], error: (err as Error).message, headline: 'unavailable' };
    }
  },
};

const marketRiskAnalyst: Analyst = {
  id: 'market-risk',
  name: 'Market Risk Analyst',
  description: 'ATR-based risk levels: stop, target, invalidation. Analytical only — not advice.',
  supportedIntents: ['risk', 'evaluate', 'recommend', 'decide', 'analyze'],
  analysisTypes: ['risk', 'recommendation', 'technical'],
  domains: ['crypto', 'finance'],
  requiredDataTypes: ['ohlcv'],
  reliability: 0.7,
  run(ctx) {
    const table = primaryOhlcv(ctx);
    if (!table) return { analystId: 'market-risk', ok: false, findings: [], evidence: [], error: 'no OHLCV data', headline: 'no data' };
    const candles = tableToCandles(table);
    if (candles.length < 20) return { analystId: 'market-risk', ok: false, findings: [], evidence: [], error: 'not enough candles', headline: 'insufficient candles' };
    const price = closes(candles)[candles.length - 1]!;
    const atrV = lastValue(atr(candles, 14)) ?? NaN;
    const stop = atrStopLoss(price, atrV, 2);
    const target = atrTakeProfit(price, atrV, 2, 2);
    const rr = (target - price) / Math.max(price - stop, 1e-9);
    const levels = [
      { id: nextId('lvl'), label: 'ATR stop', value: round2(stop), kind: 'invalidation', reason: '2×ATR(14) below current price', consequence: 'the bullish structure is invalidated', evidenceIds: [] as string[] },
      { id: nextId('lvl'), label: 'ATR target', value: round2(target), kind: 'target', reason: '2×ATR(14) above current price', evidenceIds: [] as string[] },
    ];
    const ev = makeEvidence({
      sourceId: table.sourceId,
      analystId: 'market-risk',
      metric: 'atr_risk',
      value: { price: round2(price), atr: round2(atrV), stop: round2(stop), target: round2(target), rr: round2(rr) },
      reliability: 'medium',
      label: `ATR ${round2(atrV)} → stop ${round2(stop)}, target ${round2(target)}, R:R ${round2(rr)}`,
    });
    for (const l of levels) l.evidenceIds.push(ev.id);
    const f = makeFinding({
      title: `Risk frame: stop ${round2(stop)} / target ${round2(target)} (R:R ${round2(rr)})`,
      detail: 'ATR-based analytical levels only — not trade advice.',
      analystId: 'market-risk',
      evidenceIds: [ev.id],
      tags: ['risk'],
    });
    ev.findingIds.push(f.id);
    return { analystId: 'market-risk', ok: true, findings: [f], evidence: [ev], levels, headline: `R:R ${round2(rr)}` };
  },
};

// ---------------------------------------------------------------------------
// Intelligence registration
// ---------------------------------------------------------------------------

export const financialIntelligence: PluginIntelligence = {
  entityResolvers: [cryptoEntities],
  dataSources: [cryptoMarketSource, cryptoNewsSource, onchainMockSource],
  analysts: [technicalAnalyst, onchainWhaleAnalyst, sentimentAnalyst, macroAnalyst, marketRiskAnalyst],
  workflows: [
    {
      id: 'whale-onchain',
      label: 'Whale / on-chain workflow',
      match: (q) => (q.metrics.includes('whale') || q.analysisTypes.includes('onchain') ? 20 : 0),
      addAnalysisTypes: ['onchain', 'flow', 'accumulation_distribution', 'anomaly'],
    },
    {
      id: 'sentiment',
      label: 'Sentiment workflow',
      match: (q) => (q.metrics.includes('sentiment') && !q.analysisTypes.includes('onchain') ? 15 : 0),
      addAnalysisTypes: ['sentiment'],
    },
    {
      id: 'macro',
      label: 'Macro workflow',
      match: (q) => (q.metrics.includes('macro') ? 15 : 0),
      addAnalysisTypes: ['macro'],
    },
    {
      id: 'technical',
      label: 'Technical workflow',
      match: (q) => (q.metrics.includes('technical') ? 15 : 0),
      addAnalysisTypes: ['technical', 'trend'],
    },
    {
      id: 'cross-asset',
      label: 'Cross-asset comparison',
      match: (q) => (q.intentCategory === 'compare' && q.entities.some((e) => e.domain === 'crypto' || e.domain === 'finance') ? 16 : 0),
      addAnalysisTypes: ['comparison', 'correlation'],
    },
  ],
};
