/**
 * On-chain / whale data provider — MOCK.
 *
 * Deterministic seeded synthetic data for offline development and demos.
 * It is ALWAYS marked as mock; a real provider (Glassnode, CryptoQuant,
 * Whale Alert, …) implements the same interface and is registered alongside.
 *
 * Nothing here is live blockchain data.
 */

export interface WhaleTransfer {
  id: string;
  timestamp: number;
  symbol: string;
  amount: number;
  amountUsd: number;
  from: string;
  to: string;
  direction: 'to-exchange' | 'from-exchange' | 'wallet-to-wallet';
}

export interface ExchangeFlow {
  timestamp: number;
  inflow: number;
  outflow: number;
  netflow: number;
}

export interface WhaleBalancePoint {
  timestamp: number;
  balance: number;
}

export interface OnchainProvider {
  readonly id: string;
  readonly mock: boolean;
  whaleTransfers(symbol: string, hours?: number): Promise<WhaleTransfer[]>;
  exchangeFlows(symbol: string, hours?: number): Promise<ExchangeFlow[]>;
  whaleBalances(symbol: string, hours?: number): Promise<WhaleBalancePoint[]>;
  fundingRate(symbol: string): Promise<number>;
  openInterest(symbol: string): Promise<number>;
  liquidations(symbol: string, hours?: number): Promise<Array<{ timestamp: number; long: number; short: number }>>;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministic PRNG (LCG) for reproducible synthetic series. */
function lcg(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const HOUR_MS = 3600_000;
const ANCHOR = 1_800_000_000_000; // fixed epoch anchor → deterministic timestamps

export class MockOnchainProvider implements OnchainProvider {
  readonly id = 'mock-onchain';
  readonly mock = true as const;

  constructor(private seed = 99) {}

  async whaleTransfers(symbol: string, hours = 24): Promise<WhaleTransfer[]> {
    const rnd = lcg(this.seed + hashString(symbol));
    const transfers: WhaleTransfer[] = [];
    const count = 8 + Math.floor(rnd() * 18);
    const wallets = ['0x3f5a…c21', '0x9b77…e08', '0x1de4…9f3', '0x77aa…b42', '0x0c19…77d'];
    const exchanges = ['binance', 'coinbase', 'kraken', 'okx'];
    for (let i = 0; i < count; i++) {
      const amount = 50 + rnd() * 2000;
      const roll = rnd();
      const direction: WhaleTransfer['direction'] = roll < 0.35 ? 'to-exchange' : roll < 0.7 ? 'from-exchange' : 'wallet-to-wallet';
      transfers.push({
        id: `wt-${hashString(symbol)}-${i}`,
        timestamp: ANCHOR - Math.floor(rnd() * hours) * HOUR_MS - Math.floor(rnd() * HOUR_MS),
        symbol,
        amount: Math.round(amount * 100) / 100,
        amountUsd: Math.round(amount * (30000 + rnd() * 50000)),
        from: direction === 'to-exchange' ? wallets[Math.floor(rnd() * wallets.length)]! : exchanges[Math.floor(rnd() * exchanges.length)]!,
        to: direction === 'to-exchange' ? exchanges[Math.floor(rnd() * exchanges.length)]! : wallets[Math.floor(rnd() * wallets.length)]!,
        direction,
      });
    }
    return transfers.sort((a, b) => a.timestamp - b.timestamp);
  }

  async exchangeFlows(symbol: string, hours = 72): Promise<ExchangeFlow[]> {
    const rnd = lcg(this.seed + hashString(symbol) + 7);
    const flows: ExchangeFlow[] = [];
    for (let i = 0; i < hours; i++) {
      const base = 800 + rnd() * 400;
      // Occasional deterministic outflow spikes (accumulation signal).
      const spike = i === Math.floor(hours * 0.6) || i === Math.floor(hours * 0.62) ? 2.8 + rnd() : 1;
      const inflow = base * (0.7 + rnd() * 0.6);
      const outflow = base * (0.7 + rnd() * 0.6) * spike;
      flows.push({
        timestamp: ANCHOR - (hours - i) * HOUR_MS,
        inflow: Math.round(inflow),
        outflow: Math.round(outflow),
        netflow: Math.round(inflow - outflow),
      });
    }
    return flows;
  }

  async whaleBalances(symbol: string, hours = 72): Promise<WhaleBalancePoint[]> {
    const rnd = lcg(this.seed + hashString(symbol) + 13);
    const points: WhaleBalancePoint[] = [];
    let balance = 420_000 + rnd() * 40_000;
    for (let i = 0; i < hours; i++) {
      balance += (rnd() - 0.48) * 400; // slight upward drift
      points.push({ timestamp: ANCHOR - (hours - i) * HOUR_MS, balance: Math.round(balance) });
    }
    return points;
  }

  async fundingRate(symbol: string): Promise<number> {
    const rnd = lcg(this.seed + hashString(symbol) + 21);
    return Math.round(((rnd() - 0.5) * 0.06 + 0.01) * 100000) / 100000;
  }

  async openInterest(symbol: string): Promise<number> {
    const rnd = lcg(this.seed + hashString(symbol) + 33);
    return Math.round(1e9 + rnd() * 8e9);
  }

  async liquidations(symbol: string, hours = 24): Promise<Array<{ timestamp: number; long: number; short: number }>> {
    const rnd = lcg(this.seed + hashString(symbol) + 51);
    return Array.from({ length: hours }, (_, i) => ({
      timestamp: ANCHOR - (hours - i) * HOUR_MS,
      long: Math.round(rnd() * 5e6),
      short: Math.round(rnd() * 5e6),
    }));
  }
}
