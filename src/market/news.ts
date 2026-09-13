/**
 * Real news provider: pulls the latest headlines from public RSS feeds
 * (CoinDesk, CoinTelegraph, Decrypt, Bloomberg Markets) so analysts can base
 * sentiment/macro reads on current news instead of mock data.
 *
 * No API key required. Results are cached briefly to avoid hammering feeds.
 */

export interface NewsItem {
  title: string;
  url?: string;
  published?: string; // ISO
  source: string;
}

export interface SentimentRead {
  score: number; // -1..1
  label: 'bullish' | 'bearish' | 'neutral';
  confidence: number; // 0..1
  bullish: number;
  bearish: number;
  neutral: number;
  headlineCount: number;
  headlines: NewsItem[];
}

interface FeedSource {
  name: string;
  url: string;
}

const FEEDS: FeedSource[] = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss' },
];

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const FETCH_TIMEOUT_MS = 12000;

// Symbol base → keywords used to match relevant headlines.
const SYMBOL_KEYWORDS: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc'],
  ETH: ['ethereum', 'ether', 'eth'],
  SOL: ['solana', 'sol'],
  BNB: ['binance', 'bnb'],
  XRP: ['xrp', 'ripple'],
  ADA: ['cardano', 'ada'],
  DOGE: ['dogecoin', 'doge'],
  AVAX: ['avalanche', 'avax'],
  LINK: ['chainlink', 'link'],
  TON: ['toncoin', 'ton'],
  TRX: ['tron', 'trx'],
  DOT: ['polkadot', 'dot'],
};

const BULLISH_WORDS = [
  'surge', 'rally', 'rallies', 'gain', 'gains', 'soar', 'soars', 'jump', 'jumps', 'climb', 'climbs',
  'bullish', 'record high', 'all-time high', 'ath', 'breakout', 'adoption', 'approval', 'approve', 'approved',
  'inflow', 'inflows', 'accumulate', 'accumulation', 'upgrade', 'beats', 'beat', 'growth', 'recovery', 'recover',
  'rise', 'rises', 'rebound', 'outperform', 'higher', 'green', 'boost', 'boosts', 'etf', 'buy the dip',
];
const BEARISH_WORDS = [
  'crash', 'plunge', 'plunges', 'drop', 'drops', 'fall', 'falls', 'tumble', 'tumbles', 'slump',
  'bearish', 'dump', 'selloff', 'sell-off', 'hack', 'hacked', 'exploit', 'ban', 'lawsuit', 'sue', 'sued',
  'fine', 'fined', 'fraud', 'scam', 'liquidation', 'liquidated', 'outflow', 'outflows', 'below', 'warning',
  'fear', 'down', 'lower', 'risk', 'crisis', 'collapse', 'bankrupt', 'below', 'sends', 'probe',
];

// Macro-relevant keywords for filtering macro headlines.
const MACRO_WORDS = [
  'fed', 'fomc', 'ecb', 'rate', 'rates', 'inflation', 'cpi', 'pce', 'payroll', 'jobs', 'nonfarm',
  'treasury', 'yield', 'yields', 'dollar', 'dxy', 'central bank', 'powell', 'gdp', 'recession', 'tariff',
];

export class NewsProvider {
  private cache: { ts: number; items: NewsItem[] } | undefined;

  /** Fetch and combine headlines from all feeds (cached). */
  async getAllHeadlines(limit = 30): Promise<NewsItem[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.ts < CACHE_TTL_MS) {
      return this.cache.items.slice(0, limit);
    }
    const results = await Promise.allSettled(FEEDS.map((f) => this.fetchFeed(f)));
    const items: NewsItem[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') items.push(...r.value);
    }
    items.sort((a, b) => dateMs(b.published) - dateMs(a.published));
    this.cache = { ts: now, items };
    return items.slice(0, limit);
  }

  /** Headlines relevant to a symbol (falls back to all if few matches). */
  async getHeadlines(symbol: string, limit = 12): Promise<NewsItem[]> {
    const all = await this.getAllHeadlines(60);
    const kw = symbolKeywords(symbol);
    if (!kw.length) return all.slice(0, limit);
    const matched = all.filter((it) => matchesAny(it.title, kw));
    const combined = matched.length >= 3 ? matched : matched.concat(all.filter((it) => !matched.includes(it)));
    return combined.slice(0, limit);
  }

  /** Score sentiment from recent headlines (keyword-based, recency-weighted). */
  async sentiment(symbol: string): Promise<SentimentRead> {
    const headlines = await this.getHeadlines(symbol, 14);
    return scoreSentiment(headlines);
  }

  /** Macro-flavored headlines (rates/inflation/central banks) for the macro analyst. */
  async macroHeadlines(limit = 10): Promise<NewsItem[]> {
    const all = await this.getAllHeadlines(60);
    const matched = all.filter((it) => matchesAny(it.title, MACRO_WORDS));
    return (matched.length ? matched : all).slice(0, limit);
  }

  private async fetchFeed(source: FeedSource): Promise<NewsItem[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(source.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; news-reader)', accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return parseRss(xml, source.name);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

export function scoreSentiment(headlines: NewsItem[]): SentimentRead {
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  let weighted = 0;
  let weightTotal = 0;
  const now = Date.now();
  for (const it of headlines) {
    const text = it.title.toLowerCase();
    const b = countMatches(text, BULLISH_WORDS);
    const s = countMatches(text, BEARISH_WORDS);
    let dir = 0;
    if (b > s) { bullish++; dir = 1; } else if (s > b) { bearish++; dir = -1; } else neutral++;
    // Recency weight: newer headlines weigh more (half-life ~12h).
    const ageH = Math.max(0, (now - dateMs(it.published)) / 3600000);
    const w = 1 / (1 + ageH / 12);
    weighted += dir * w * Math.min(1, (b + s) / 2 + 0.5);
    weightTotal += w;
  }
  const total = headlines.length || 1;
  const score = weightTotal ? clamp(weighted / weightTotal, -1, 1) : 0;
  const label = score > 0.12 ? 'bullish' : score < -0.12 ? 'bearish' : 'neutral';
  // Confidence grows with headline volume and decisiveness.
  const decisiveness = Math.abs(score);
  const confidence = clamp(0.35 + decisiveness * 0.4 + Math.min(0.25, total / 40), 0.3, 0.9);
  return { score: round(score, 3), label, confidence: round(confidence, 2), bullish, bearish, neutral, headlineCount: headlines.length, headlines };
}

// --- RSS parsing (tolerant, handles <item>/<entry>, CDATA, common date tags) ---

function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const re = /<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const title = extractTag(block, 'title');
    if (!title) continue;
    const link = extractTag(block, 'link') || extractLinkHref(block);
    const date = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated') || extractTag(block, 'dc:date');
    items.push({
      title,
      url: link,
      published: date ? toIso(date) : undefined,
      source,
    });
  }
  return items;
}

function extractTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m || m[1] === undefined) return undefined;
  return clean(m[1]);
}

function extractLinkHref(block: string): string | undefined {
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m && m[1] ? m[1].trim() : undefined;
}

function clean(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toIso(date: string): string | undefined {
  const t = Date.parse(date);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function dateMs(published?: string): number {
  if (!published) return 0;
  const t = Date.parse(published);
  return Number.isFinite(t) ? t : 0;
}

function symbolKeywords(symbol: string): string[] {
  const s = symbol.toUpperCase().replace(/(USDT|USD|USDC|PERP|-PERP)$/i, '');
  for (const [base, words] of Object.entries(SYMBOL_KEYWORDS)) {
    if (s === base || s.startsWith(base)) return words;
  }
  return s.length >= 2 && s.length <= 6 ? [s.toLowerCase()] : [];
}

function matchesAny(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w));
}

function countMatches(text: string, words: string[]): number {
  let n = 0;
  for (const w of words) if (text.includes(w)) n++;
  return n;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
