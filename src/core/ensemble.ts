import type { SubagentResult } from '../agents/runner.js';

/**
 * Analyst ensemble: runs several "senior analyst" subagents concurrently and
 * aggregates their verdicts into one definitive prediction.
 *
 * The analyst roles (and their tools) are contributed by plugins; this module
 * only orchestrates the parallel runs and the consensus math.
 */

export type Direction = 'bullish' | 'bearish' | 'neutral';

export interface AnalystVote {
  agent: string;
  direction: Direction;
  confidence: number;
  rationale: string;
  ok: boolean;
}

export interface EnsembleResult {
  symbol: string;
  votes: AnalystVote[];
  direction: Direction;
  confidence: number;
  summary: string;
}

export interface EnsembleOptions {
  symbol: string;
  agents: string[];
  sessionId?: string;
  workspacePath: string;
}

/** Minimal runtime surface the ensemble needs (avoids a circular import). */
interface EnsembleRuntimeLike {
  agents: { get(name: string): { name: string } | undefined };
  events: { emit(event: unknown): void };
  subagents: {
    run(name: string, task: string, opts: { sessionId?: string; workspacePath: string; signal?: AbortSignal }): Promise<SubagentResult>;
  };
}

export async function runAnalystEnsemble(rt: EnsembleRuntimeLike, opts: EnsembleOptions): Promise<EnsembleResult> {
  const { symbol, agents, sessionId, workspacePath } = opts;

  rt.events.emit({ type: 'ensemble_start', symbol, agents, sessionId });

  const tasks = agents.map(async (name): Promise<SubagentResult> => {
    const def = rt.agents.get(name);
    if (!def) {
      return { id: name, name, ok: false, result: `agent "${name}" not found`, provider: '', model: '' };
    }
    const task = `Analyze ${symbol} now as a senior "${name}" analyst. ` +
      `Give one definitive verdict (bullish, bearish, or neutral) with a confidence 0..1. ` +
      `Use your available tools if helpful, then end your answer with exactly this line (nothing after it):\n` +
      `VERDICT: bullish|0.72| one-line rationale`;
    // Retry once on transient failure (concurrent provider load / rate limits).
    let result = await rt.subagents.run(name, task, { sessionId, workspacePath });
    if (!result.ok) {
      await sleep(1500);
      result = await rt.subagents.run(name, task, { sessionId, workspacePath });
    }
    return result;
  });

  const results = await Promise.all(tasks);

  const votes: AnalystVote[] = results.map((r) => {
    const parsed = parseVerdict(r.result);
    if (parsed && r.ok) {
      return { agent: r.name, direction: parsed.direction, confidence: parsed.confidence, rationale: parsed.rationale, ok: true };
    }
    return { agent: r.name, direction: 'neutral', confidence: 0.5, rationale: r.ok ? truncate(r.result) : 'failed', ok: r.ok };
  });

  const okVotes = votes.filter((v) => v.ok);
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const v of okVotes) counts[v.direction] += 1;

  const direction = resolveDirection(okVotes, counts);
  const sideVotes = okVotes.filter((v) => v.direction === direction);
  const confidence = sideVotes.length
    ? round2(sideVotes.reduce((s, v) => s + v.confidence, 0) / sideVotes.length)
    : 0.5;

  const summary = buildSummary(symbol, direction, confidence, votes, counts);

  rt.events.emit({ type: 'ensemble_result', symbol, direction, confidence, votes, sessionId });

  return { symbol, votes, direction, confidence, summary };
}

function resolveDirection(votes: AnalystVote[], counts: Record<Direction, number>): Direction {
  const { bullish, bearish, neutral } = counts;
  if (bullish > bearish && bullish > neutral) return 'bullish';
  if (bearish > bullish && bearish > neutral) return 'bearish';
  // Tie → highest summed confidence wins.
  const score = (d: Direction) => votes.filter((v) => v.direction === d).reduce((s, v) => s + v.confidence, 0);
  const b = score('bullish');
  const s = score('bearish');
  const n = score('neutral');
  if (b >= s && b >= n) return 'bullish';
  if (s >= n) return 'bearish';
  return 'neutral';
}

function buildSummary(
  symbol: string,
  direction: Direction,
  confidence: number,
  votes: AnalystVote[],
  counts: Record<Direction, number>,
): string {
  const dir = direction.toUpperCase();
  const lines = [
    `PREDIKSI ${symbol}: ${dir} (confidence ${confidence.toFixed(2)})`,
    '',
  ];
  for (const v of votes) {
    const mark = v.ok ? '✓' : '✗';
    lines.push(`  ${mark} ${v.agent}: ${v.direction.toUpperCase()} (${v.confidence.toFixed(2)}) — ${v.rationale}`);
  }
  lines.push('');
  lines.push(`Konsensus: ${counts.bullish} bullish / ${counts.bearish} bearish / ${counts.neutral} neutral.`);
  return lines.join('\n');
}

function parseVerdict(text: string): { direction: Direction; confidence: number; rationale: string } | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/VERDICT:\s*(bullish|bearish|neutral)\s*[|,]\s*([0-9.]+)\s*[|,-]\s*(.*)/i);
    if (m) {
      const confidence = Number(m[2]);
      return {
        direction: (m[1] ?? 'neutral').toLowerCase() as Direction,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
        rationale: (m[3] ?? '').trim(),
      };
    }
  }
  return undefined;
}

function truncate(text: string, n = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
