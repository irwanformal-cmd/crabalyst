import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { AgentRuntime } from '../core/runtime.js';
import { MarketFeed, detectMarketSymbol } from '../market/feed.js';
import { NewsProvider } from '../market/news.js';
import type { AgentEvent } from '../types/events.js';
import type { Approver } from '../types/permissions.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_DIR = join(PACKAGE_ROOT, 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

export interface ServeOptions {
  port?: number;
  host?: string;
}

interface ClientMessage {
  type:
    | 'prompt'
    | 'command'
    | 'session_resume'
    | 'provider_use'
    | 'permission_response'
    | 'market_subscribe'
    | 'market_unsubscribe'
    | 'analysis_list'
    | 'analysis_get';
  text?: string;
  sessionId?: string;
  providerId?: string;
  id?: string;
  allowed?: boolean;
  symbol?: string;
  range?: string;
  interval?: string;
  limit?: number;
  analysisId?: string;
}

interface PendingApproval {
  resolve: (decision: { allowed: boolean; reason?: string }) => void;
  socket: WebSocket;
}

/**
 * WebSocket gateway: the browser workspace is one client of the Agent Runtime
 * + Intelligence Layer. Analysis events stream as structured JSON envelopes;
 * the frontend consumes AnalysisResult, never raw tool text.
 */
export async function serve(options: ServeOptions = {}): Promise<void> {
  const port = options.port ?? 8080;
  const host = options.host ?? '127.0.0.1';

  const runtime = new AgentRuntime();
  await runtime.start();

  const market = new MarketFeed();
  const newsProvider = new NewsProvider();
  // Per-socket market subscriptions: symbol -> unsubscribe fn.
  const marketSubs = new Map<WebSocket, Map<string, () => void>>();

  let currentSocket: WebSocket | undefined;
  const pendingApprovals = new Map<string, PendingApproval>();
  let approvalSeq = 0;

  // Chart range helpers: mirror web/chart.js RANGE_CFG.
  function rangeToInterval(range: string): string {
    if (range === '1h') return '1m';
    if (range === '7d') return '1h';
    if (range === '14d') return '2h';
    if (range === '30d') return '4h';
    if (/^\d+[mhd]$/.test(range)) return range; // custom interval passthrough
    return '15m'; // '24h'
  }

  function rangeToLimit(range: string): number {
    if (range === '1h') return 60;
    if (range === '7d' || range === '14d') return 168;
    if (range === '30d') return 180;
    if (/^\d+[mhd]$/.test(range)) return 168;
    return 96; // '24h'
  }

  /** Subscribe a socket to live candles (per-range interval) and seed history. */
  function subscribeMarket(socket: WebSocket, symbol: string, range?: string, interval?: string, limit?: number): void {
    let subs = marketSubs.get(socket);
    if (!subs) {
      subs = new Map();
      marketSubs.set(socket, subs);
    }
    // Custom interval (from the 1m/5m/15m/1H/4H/1D picker) overrides the preset range.
    const iv = interval && /^\d+[mhd]$/.test(interval) ? interval : rangeToInterval(range ?? '24h');
    const lim = limit && Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 1000) : rangeToLimit(range ?? '24h');
    const activeRange = interval ? `custom:${iv}` : (range ?? '24h');
    // Key per symbol+range so switching range always triggers a fresh history fetch.
    const key = `${symbol}::${activeRange}`;
    if (subs.has(key)) return;
    send(socket, { type: 'market_subscribed', symbol, interval: iv });
    market.history(symbol, lim, iv).then((candles) => {
      send(socket, { type: 'candles', symbol, range: activeRange, candles });
    });
    const unsubscribe = market.subscribe(symbol, (candle) => {
      send(socket, { type: 'candle', symbol, candle });
    });
    // Whale radar: batch raw trades every 250ms; mock (marked) when offline.
    let tradeBuf: Array<{ p: number; q: number; v: number; s: 'buy' | 'sell' }> = [];
    let sawRealTrade = false;
    let mockSeed = Date.now() % 100000;
    const mockRand = () => (mockSeed = (mockSeed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const flushTrades = setInterval(() => {
      if (tradeBuf.length) {
        sawRealTrade = true;
        send(socket, { type: 'trades', symbol, mock: false, trades: tradeBuf });
        tradeBuf = [];
      }
    }, 250);
    flushTrades.unref();
    // If nothing real arrives within 8s (offline), simulate honestly-marked trades.
    const mockTimer = setInterval(() => {
      if (sawRealTrade) return;
      const n = 1 + Math.floor(mockRand() * 3);
      const base = 70000 + mockRand() * 20000;
      const trades = Array.from({ length: n }, () => {
        const v = mockRand() < 0.06 ? 120000 + mockRand() * 2000000 : 100 + mockRand() * 40000;
        return { p: Math.round(base * 100) / 100, q: Math.round((v / base) * 100000) / 100000, v: Math.round(v), s: (mockRand() < 0.5 ? 'buy' : 'sell') as 'buy' | 'sell' };
      });
      send(socket, { type: 'trades', symbol, mock: true, trades });
    }, 900);
    mockTimer.unref();
    const unsubTrades = market.subscribeTrades(symbol, (t) => {
      if (tradeBuf.length < 60) tradeBuf.push({ p: t.price, q: t.qty, v: Math.round(t.value), s: t.side });
    });
    subs.set(key, () => {
      clearInterval(flushTrades);
      clearInterval(mockTimer);
      unsubscribe();
      unsubTrades();
    });
  }

  /** Send the latest news headlines for a symbol to the news panel. */
  function sendNews(socket: WebSocket, symbol: string): void {
    newsProvider.getHeadlines(symbol, 14).then((items) => {
      send(socket, {
        type: 'news',
        symbol,
        headlines: items.map((it) => ({ title: it.title, source: it.source, published: it.published })),
      });
    }).catch(() => { /* news is best-effort */ });
  }

  // Permission approver for the browser client: read-only defaults are
  // pre-granted in config; anything else is relayed to the page as a prompt.
  const approver: Approver = (request) =>
    new Promise((resolveApproval) => {
      const id = `perm-${++approvalSeq}`;
      pendingApprovals.set(id, { resolve: resolveApproval, socket: currentSocket! });
      send(currentSocket!, {
        type: 'permission_request',
        id,
        request: {
          permission: request.permission,
          description: request.description,
          toolName: request.toolName,
        },
      });
    });
  runtime.setApprover(approver);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  // Market movers: refresh every 60s, cache, and broadcast to all clients.
  let moversSnapshot: MoversSnapshot | null = null;
  const refreshMovers = async (): Promise<void> => {
    moversSnapshot = await fetchMovers();
    for (const client of wss.clients) {
      send(client, { type: 'movers', ...moversSnapshot });
    }
  };
  void refreshMovers();
  const moversTimer = setInterval(() => void refreshMovers(), 60_000);
  moversTimer.unref();

  wss.on('connection', async (socket: WebSocket) => {
    const unsubscribe = runtime.events.subscribe((event: AgentEvent) => {
      send(socket, { type: 'event', event });
    });

    socket.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send(socket, { type: 'error', message: 'invalid JSON' });
        return;
      }
      try {
        switch (msg.type) {
          case 'prompt':
          case 'command': {
            currentSocket = socket;
            const text = msg.text ?? '';
            const sessionId = msg.sessionId;

            // Slash commands go to the command/agent path untouched.
            if (text.startsWith('/')) {
              const res = await runtime.dispatch(text, { sessionId });
              send(socket, { type: 'result', ...res });
              break;
            }

            // Market watch command: "pasar PEPE" / "pantau SOL" switches the
            // live chart + whale radar WITHOUT running a full analysis.
            const watchMatch = /^\s*(?:pasar|market|watch|pantau)\s+(.+?)\??\s*$/i.exec(text.trim());
            if (watchMatch) {
              const sym = detectMarketSymbol(watchMatch[1] ?? '');
              if (sym) {
                subscribeMarket(socket, sym);
                sendNews(socket, sym);
                send(socket, { type: 'result', ok: true, summary: `memantau pasar ${sym} — live chart & whale radar berpindah`, sessionId });
                break;
              }
            }

            // Conversational follow-ups control the current analysis.
            const followUp = runtime.intelligence.detectFollowUp(text, sessionId);
            if (followUp) {
              if (followUp.kind === 'explain') {
                const d = followUp.result.decision;
                send(socket, {
                  type: 'followup',
                  kind: 'explain',
                  analysisId: followUp.result.id,
                  summary: d
                    ? `${d.decision}\n\nWhy:\n${d.rationale.map((r) => `• ${r}`).join('\n') || '• (no rationale recorded)'}`
                    : 'No decision recorded for the last analysis.',
                  sessionId,
                });
              } else {
                send(socket, { type: 'followup', kind: 'evidence', analysisId: followUp.result.id, result: followUp.result, sessionId });
              }
              break;
            }

            // Conceptual questions ("what is middle-class crypto") are not data
            // analyses — answer them honestly via the LLM instead of forcing
            // the analyst pipeline into a fake insufficient-evidence. Detect by
            // QUESTION PHRASING (plugins can hijack the 'explain' intent), and
            // never when a concrete market symbol is present.
            const conceptual = /^(?:apa(?:kah)? (?:itu|sih|yang dimaksud)|what(?:'s| is| are)|jelaskan|jelasin|jels?in|explain|definisi|arti(?:nya)?|maksud(?:nya)?|kenapa (?:harus|penting)|bagaimana cara kerja)\b/i.test(text.trim());
            if (conceptual && !detectMarketSymbol(text)) {
              // Fresh session: the analysis history in the user's session would
              // otherwise steer the model back to the previous subject.
              const res = await runtime.run(
                // The nonce defeats upstream response caching (some proxies
                // return a cached answer for repeated prompts).
                `This is a general conceptual question, NOT about any data analysis or market ever discussed. Answer the concept briefly and clearly in the user's language (max 3 short paragraphs), without inventing data: ${text} [ref:${Date.now().toString(36)}]`,
                { skipSkills: true, freshSession: true, maxIterations: 2 },
              );
              send(socket, { type: 'result', ok: res.ok, summary: res.summary, sessionId });
              break;
            }

            // Everything else goes through the Intelligence Layer.
            const result = await runtime.analyze(text, { sessionId });
            // Live market feed only when the subject is a crypto asset.
            if (result.domain === 'crypto' && result.subject) {
              subscribeMarket(socket, result.subject);
              sendNews(socket, result.subject);
            }
            // The full structured result streams via the 'analysis_result'
            // event; send a compact summary for the chat strip.
            send(socket, {
              type: 'result',
              ok: result.status !== 'error',
              summary: result.decision?.decision ?? `analysis ${result.status}`,
              sessionId,
              analysisId: result.id,
            });
            break;
          }
          case 'market_subscribe': {
            if (msg.symbol) subscribeMarket(socket, msg.symbol, msg.range, msg.interval, msg.limit);
            break;
          }
          case 'market_unsubscribe': {
            const subs = marketSubs.get(socket);
            if (subs && msg.symbol) {
              // Without range+interval → drop all ranges for this symbol (e.g. switching range/symbol).
              const keys = (msg.range || msg.interval)
                ? [`${msg.symbol}::${msg.interval ? `custom:${msg.interval}` : msg.range}`]
                : [...subs.keys()].filter((k) => k === msg.symbol || k.startsWith(`${msg.symbol}::`));
              for (const k of keys) {
                const unsub = subs.get(k);
                if (unsub) { unsub(); subs.delete(k); }
              }
              send(socket, { type: 'ok', message: `unsubscribed ${msg.symbol}` });
            }
            break;
          }
          case 'analysis_list': {
            const analyses = await runtime.repository.listAnalyses(50);
            send(socket, { type: 'analysis_list', analyses });
            break;
          }
          case 'analysis_get': {
            const result = await runtime.repository.getAnalysis(msg.analysisId ?? '');
            if (result) {
              runtime.events.emit({ type: 'analysis_result', analysisId: result.id, result, sessionId: msg.sessionId });
            } else {
              send(socket, { type: 'error', message: `analysis ${msg.analysisId} not found` });
            }
            break;
          }
          case 'session_resume': {
            const session = await runtime.resumeSession(msg.sessionId ?? '');
            send(socket, { type: 'session', session });
            break;
          }
          case 'provider_use': {
            runtime.useProvider(msg.providerId ?? '');
            send(socket, { type: 'ok', message: `using ${msg.providerId}` });
            break;
          }
          case 'permission_response': {
            const entry = pendingApprovals.get(msg.id ?? '');
            if (entry) {
              pendingApprovals.delete(msg.id!);
              entry.resolve({ allowed: msg.allowed === true, reason: msg.allowed ? undefined : 'denied by user' });
            }
            break;
          }
          default:
            send(socket, { type: 'error', message: `unknown message type ${(msg as { type: string }).type}` });
        }
      } catch (err) {
        send(socket, { type: 'error', message: (err as Error).message });
      }
    });

    socket.on('close', () => {
      unsubscribe();
      // Tear down any live market subscriptions owned by this connection.
      const subs = marketSubs.get(socket);
      if (subs) {
        for (const unsub of subs.values()) unsub();
        marketSubs.delete(socket);
      }
      // Fail closed for any approvals still owned by this connection.
      for (const [id, entry] of pendingApprovals) {
        if (entry.socket === socket) {
          pendingApprovals.delete(id);
          entry.resolve({ allowed: false, reason: 'connection closed' });
        }
      }
    });
    send(socket, {
      type: 'boot',
      providers: runtime.listProviders(),
      plugins: runtime.plugins.list().map((p) => ({ id: p.id, version: p.manifest.version, description: p.manifest.description })),
      tools: runtime.tools.list().map((t) => t.name),
      skills: runtime.skills.list().map((s) => s.name),
      agents: runtime.agents.list().map((a) => a.name),
      sessions: await runtime.listSessions(),
      dataSources: runtime.dataSources.list(),
      analysts: runtime.analystRegistry.list().map((a) => ({ id: a.id, name: a.name, description: a.description, pluginId: a.pluginId })),
      analyses: await runtime.repository.listAnalyses(50),
      movers: moversSnapshot,
    });
    // The radar and live chart must be alive from the first paint.
    // Default 1H (1m): candle tick-nya kelihatan bergerak tiap detik.
    subscribeMarket(socket, 'BTCUSDT', '1h');
  });

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`agent gateway listening on http://${host}:${port}`);
  });
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

// -- Market movers (24h) ------------------------------------------------------
const MOVERS_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'TRXUSDT', 'LTCUSDT'];

export interface Mover {
  symbol: string;
  price: number;
  changePct: number;
}

export interface MoversSnapshot {
  movers: Mover[];
  mock: boolean;
  fetchedAt: string;
}

/**
 * Fetch 24h movers from Binance public ticker. Offline fallback: deterministic
 * pseudo-movers (seeded daily) clearly flagged mock=true — never presented as real.
 */
async function fetchMovers(): Promise<MoversSnapshot> {
  const fetchedAt = new Date().toISOString();
  try {
    const url = `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(MOVERS_WATCHLIST))}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ticker http ${res.status}`);
    const rows = (await res.json()) as Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>;
    const movers = rows
      .filter((r) => MOVERS_WATCHLIST.includes(r.symbol))
      .map((r) => ({ symbol: r.symbol, price: Number(r.lastPrice), changePct: Number(r.priceChangePercent) }))
      .filter((m) => Number.isFinite(m.price) && Number.isFinite(m.changePct));
    if (!movers.length) throw new Error('empty ticker response');
    return { movers, mock: false, fetchedAt };
  } catch {
    // Deterministic daily-seeded fallback so "today's" mock movers are stable.
    let seed = Math.floor(Date.now() / 86_400_000) ^ 0x9e3779b9;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const movers = MOVERS_WATCHLIST.map((symbol) => ({
      symbol,
      price: round4(10 + rand() * 1000),
      changePct: round4(rand() * 16 - 8),
    }));
    return { movers, mock: true, fetchedAt };
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = (req.url ?? '/').split('?')[0]!;
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = resolve(join(WEB_DIR, requested));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Dev console: never serve a stale mix of HTML/CSS/JS from heuristic browser cache.
    'cache-control': 'no-store',
  });
  res.end(readFileSync(filePath));
}
