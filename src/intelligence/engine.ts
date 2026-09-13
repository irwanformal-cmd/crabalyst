/**
 * Intelligence Engine — orchestrates the full pipeline:
 *
 *   understand → resolve → plan → collect data → run analysts →
 *   evidence → decision → scenarios/what-if → forecast → visualizations →
 *   AnalysisResult (persisted + streamed as structured events)
 *
 * The Agent Runtime remains responsible for LLM execution; this layer decides
 * WHAT should be executed. Everything here is deterministic and
 * provider-agnostic.
 */
import { randomUUID } from 'node:crypto';
import { CORE_ANALYSTS, nextId } from './analysts.js';
import type { AnalystRegistry } from './analysts.js';
import type { DataSourceRegistry } from './datasources.js';
import { collectEvidence, buildEvidenceGraph } from './evidence.js';
import { synthesizeDecision } from './decision.js';
import { generateScenarios, runWhatIf } from './scenarios.js';
import { recommendVisualizations } from './visualization.js';
import { predictionsFromAnalysis } from './predictions.js';
import { trendDirection, volatilityPct, pctChange, columnValues, round2 } from './stats.js';
import type { AnalysisPlanner } from './planner.js';
import type { QueryUnderstanding } from './query.js';
import type { AgentEventBus } from '../core/event-emitter.js';
import type {
  AnalysisResult,
  AnalystContext,
  AnalystOutput,
  DataTable,
  MultiPeriodAnalysis,
  PlanStep,
  StructuredQuery,
} from './types.js';

/** Persistence boundary for analyses (implemented by the session repository). */
export interface AnalysisStore {
  recordAnalysis(entry: { id: string; sessionId?: string; result: AnalysisResult }): Promise<void>;
  getAnalysis(id: string): Promise<AnalysisResult | undefined>;
  listAnalyses(limit?: number): Promise<Array<{ id: string; query: string; subject?: string; intent: string; timestamp: string; classification?: string }>>;
  /** Optional: persist predictions produced by an analysis for later evaluation. */
  recordPrediction?(entry: {
    asset: string;
    timestamp: string;
    timeframe?: string;
    prediction: string;
    confidence?: number;
    reasoning: unknown;
    indicators: unknown;
    plugin?: string;
  }): Promise<void>;
}

export interface IntelligenceEngineDeps {
  query: QueryUnderstanding;
  planner: AnalysisPlanner;
  analysts: AnalystRegistry;
  dataSources: DataSourceRegistry;
  events: AgentEventBus;
  store?: AnalysisStore;
}

export interface AnalyzeOptions {
  sessionId?: string;
  workspacePath: string;
  runtime?: unknown;
}

export class IntelligenceEngine {
  /** Last analysis per session — powers conversational follow-ups. */
  private lastBySession = new Map<string, AnalysisResult>();

  constructor(private deps: IntelligenceEngineDeps) {}

  /** Read-only access to query understanding (intent probing, e.g. routing). */
  get query(): IntelligenceEngineDeps['query'] {
    return this.deps.query;
  }

  lastAnalysis(sessionId?: string): AnalysisResult | undefined {
    return sessionId ? this.lastBySession.get(sessionId) : undefined;
  }

  async analyze(raw: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
    const analysisId = nextId('ana');
    const bus = this.deps.events;
    const emitStep = (step: PlanStep, status: PlanStep['status'], detail?: string, started?: number) => {
      step.status = status;
      if (detail) step.detail = detail;
      if (started !== undefined && (status === 'done' || status === 'failed')) step.durationMs = Date.now() - started;
      bus.emit({ type: 'analysis_step', analysisId, step: { ...step }, sessionId: opts.sessionId });
    };

    // 1. Understand.
    const query = this.deps.query.understand(raw);
    // Follow-up / intervention context inheritance: a query without its own
    // subject (e.g. "focus on whales only") continues the session's previous
    // subject instead of falling into insufficient-evidence. Only analytic /
    // steering phrasings inherit — conceptual questions ("what is X") must not
    // be force-fed the previous subject.
    const prev = this.lastAnalysis(opts.sessionId);
    const looksLikeSteering = /\b(fokus|fokuskan|abaikan|skip|hanya|saja|lebih (dalam|detail|besar|kecil)|coba|sekarang|lanjut|ulangi?|ganti|bandingkan|prediksi|forecast|what-?if|kalau|bagaimana kalau|zoom|timeframe)\b/i.test(raw);
    if (prev && !query.subject && query.intent !== 'explain' && looksLikeSteering) {
      if (prev.subject) {
        query.subject = prev.subject;
        query.subjectLabel = prev.subjectLabel;
        if (!query.entities.some((e) => e.id === prev.subject)) {
          query.entities.push({ id: prev.subject, label: prev.subjectLabel ?? prev.subject, kind: 'asset', resolverId: 'session-memory', mention: prev.subject });
        }
      }
      if (!query.domain && prev.domain) query.domain = prev.domain;
    }
    bus.emit({ type: 'analysis_start', analysisId, query, sessionId: opts.sessionId });

    // 2. Plan.
    const plan = this.deps.planner.plan(query);
    const steps = plan.steps;
    // Publish the step skeleton so observers (office rail) can render the plan.
    bus.emit({ type: 'analysis_plan', analysisId, steps: steps.map((s) => ({ id: s.id, label: s.label, status: s.status })), sessionId: opts.sessionId });
    emitStep(steps[0]!, 'done', `intent=${query.intent}, types=[${query.analysisTypes.join(', ')}]`);
    let cursor = 0;
    if (query.entities.length) emitStep(steps[++cursor]!, 'done', query.entities.map((e) => `${e.id} (${e.resolverId})`).join(', '));
    emitStep(steps[++cursor]!, 'done', plan.rationale);

    // 3. Collect data.
    const dataStep = steps[++cursor]!;
    const t0 = Date.now();
    emitStep(dataStep, 'running');
    const { tables, errors: sourceErrors } = await this.deps.dataSources.fetchFrom(plan.sourceIds, {
      query,
      entities: query.entities,
      timeRange: query.timeRange,
      metrics: query.metrics,
      workspacePath: opts.workspacePath,
    });
    if (tables.length) {
      emitStep(dataStep, 'done', `${tables.length} table(s): ${tables.map((t) => `${t.label} (${t.rows.length} rows)`).join(', ')}`, t0);
    } else {
      emitStep(dataStep, sourceErrors.length ? 'failed' : 'skipped', sourceErrors.map((e) => `${e.sourceId}: ${e.error}`).join('; ') || 'no data available', t0);
    }

    // 4. Run selected analysts.
    const outputs: AnalystOutput[] = [];
    for (const analystId of plan.analystIds) {
      const step = steps[++cursor];
      const analyst = this.deps.analysts.get(analystId);
      if (!step || !analyst) continue;
      const started = Date.now();
      emitStep(step, 'running');
      const ctx: AnalystContext = {
        query,
        tables,
        sources: this.deps.dataSources.list().filter((s) => plan.sourceIds.includes(s.id)),
        workspacePath: opts.workspacePath,
        sessionId: opts.sessionId,
        runtime: opts.runtime,
        emit: (label, detail) => bus.emit({ type: 'analysis_step', analysisId, step: { id: nextId('sub'), label, status: 'done', detail }, sessionId: opts.sessionId }),
      };
      try {
        const out = await analyst.run(ctx);
        out.durationMs = Date.now() - started;
        out.confidenceWeight = analyst.reliability ?? 1;
        outputs.push(out);
        emitStep(step, out.ok ? 'done' : 'failed', out.headline ?? out.error, started);
        bus.emit({
          type: 'analyst_result', analysisId, analystId, ok: out.ok, headline: out.headline, confidence: out.confidence,
          // The analyst's real work products, so observers can narrate what it actually computed.
          evidenceLabels: out.evidence.slice(0, 5).map((e) => e.label),
          sessionId: opts.sessionId,
        });
      } catch (err) {
        outputs.push({ analystId, ok: false, findings: [], evidence: [], error: (err as Error).message, durationMs: Date.now() - started });
        emitStep(step, 'failed', (err as Error).message, started);
      }
    }

    // 5. Evidence synthesis.
    const synthStep = steps[++cursor];
    const ts0 = Date.now();
    if (synthStep) emitStep(synthStep, 'running');
    const { evidence, findings } = collectEvidence(outputs);
    const decision = synthesizeDecision({ query, outputs, tables, sourceErrors });
    const anomalies = outputs.flatMap((o) => o.anomalies ?? []);
    const relationships = outputs.flatMap((o) => o.relationships ?? []);
    const importantLevels = outputs.flatMap((o) => o.levels ?? []);
    const regimes = outputs.flatMap((o) => o.regimes ?? []);
    const forecast = outputs.find((o) => o.forecast)?.forecast;
    if (synthStep) emitStep(synthStep, 'done', `${findings.length} findings, ${evidence.length} evidence items`, ts0);

    // 6. Scenarios / what-if.
    const whatIfResult = query.whatIf ? runWhatIf(query.whatIf, tables) : undefined;
    let scenarios = generateScenarios({ query, tables });
    if (whatIfResult) scenarios = [...(scenarios ?? []), whatIfResult.scenario];

    // 7. Visualizations.
    const vizStep = steps[++cursor];
    const tv0 = Date.now();
    if (vizStep) emitStep(vizStep, 'running');
    const visualizations = recommendVisualizations({ query, tables, outputs, levels: importantLevels });
    if (vizStep) emitStep(vizStep, visualizations.length ? 'done' : 'skipped', `${visualizations.length} visualization(s)`, tv0);

    // 8. Decision step + multi-period + graph.
    const decStep = steps[++cursor];
    const td0 = Date.now();
    if (decStep) emitStep(decStep, 'running');
    const multiPeriod = buildMultiPeriod(tables);
    const assumptions = buildAssumptions(query, tables);
    const limitations = buildLimitations(tables, sourceErrors);
    const uncertainty = buildUncertainty(forecast, whatIfResult !== undefined);
    const evidenceGraph = buildEvidenceGraph({
      decisionSummary: decision?.decision,
      outputs,
      sources: this.deps.dataSources.list().filter((s) => plan.sourceIds.includes(s.id)).map((s) => ({ id: s.id, label: s.label })),
      assumptions,
      scenarioNames: scenarios?.map((s) => s.name),
      forecastPresent: !!forecast,
    });
    if (decStep) emitStep(decStep, decision ? 'done' : 'skipped', decision?.classification, td0);

    const status: AnalysisResult['status'] = !tables.length
      ? sourceErrors.length ? 'unavailable' : 'insufficient-evidence'
      : decision?.classification === 'insufficient-evidence'
        ? 'insufficient-evidence'
        : sourceErrors.length ? 'partial' : 'success';

    const result: AnalysisResult = {
      id: analysisId,
      query,
      subject: query.subject,
      subjectLabel: query.subjectLabel,
      domain: query.domain,
      intent: query.intent,
      timestamp: new Date().toISOString(),
      status,
      dataSources: this.deps.dataSources.list().filter((s) => plan.sourceIds.includes(s.id)),
      analysts: outputs,
      visualizations,
      findings,
      evidence,
      anomalies,
      relationships,
      decision,
      scenarios,
      forecast,
      uncertainty,
      assumptions,
      limitations,
      importantLevels,
      regimes,
      multiPeriod,
      evidenceGraph,
      plan: { ...plan, steps },
      executionTrace: steps,
    };

    // 9. Persist + emit.
    if (opts.sessionId) this.lastBySession.set(opts.sessionId, result);
    if (this.deps.store) {
      try {
        await this.deps.store.recordAnalysis({ id: analysisId, sessionId: opts.sessionId, result });
        // Prediction tracking: journal the prediction (when any) for later evaluation.
        const prediction = predictionsFromAnalysis(result);
        if (prediction && this.deps.store.recordPrediction) {
          await this.deps.store.recordPrediction({
            asset: prediction.subject,
            timestamp: prediction.timestamp,
            timeframe: prediction.horizon,
            prediction: prediction.prediction,
            confidence: prediction.confidence,
            reasoning: { analysisId: prediction.analysisId, assumptions: prediction.assumptions },
            indicators: { evidenceIds: prediction.evidenceIds, target: prediction.target },
            plugin: 'intelligence',
          });
        }
      } catch {
        /* persistence is best-effort */
      }
    }
    bus.emit({ type: 'analysis_result', analysisId, result, sessionId: opts.sessionId });
    return result;
  }

  /**
   * Conversational follow-up control ("why?", "show evidence", "what if…").
   * Returns a follow-up descriptor, or undefined when the text is a fresh
   * analysis request.
   */
  detectFollowUp(text: string, sessionId?: string): { kind: 'explain' | 'evidence' | 'repeat'; result: AnalysisResult } | undefined {
    const last = this.lastAnalysis(sessionId);
    if (!last) return undefined;
    const t = text.trim().toLowerCase();
    if (/^(why|kenapa|mengapa|kok bisa|how come)\??$/.test(t)) return { kind: 'explain', result: last };
    if (/^(show |lihat |tampilkan )?(the )?(evidence|bukti|graph|grafik bukti)\??$/.test(t)) return { kind: 'evidence', result: last };
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Multi-period matrix: generic — one column per table timeframe/period label.
// ---------------------------------------------------------------------------

export function buildMultiPeriod(tables: DataTable[]): MultiPeriodAnalysis | undefined {
  const periodTables = tables.filter((t) => t.meta?.period && (t.kind === 'timeseries' || t.kind === 'ohlcv'));
  if (periodTables.length < 2) return undefined;

  const periods = periodTables.map((t) => String(t.meta!.period));
  const dimensions = ['trend', 'momentum', 'volatility'];
  const cells: MultiPeriodAnalysis['cells'] = dimensions.map(() => []);

  let agree = 0;
  let total = 0;
  const trendStates: string[] = [];
  for (const t of periodTables) {
    const key = t.columns.find((c) => c.key === 'close' || c.key === 'value')?.key ?? t.columns.find((c) => c.type === 'number')?.key!;
    const values = columnValues(t.rows, key);
    const trend = trendDirection(values);
    const third = Math.floor(values.length / 3);
    const momentum = third > 0 ? pctChange(values.slice(-third)) : 0;
    const vol = volatilityPct(values);
    trendStates.push(trend.direction);
    cells[0]!.push({ state: trend.direction === 'up' ? 'up' : trend.direction === 'down' ? 'down' : 'flat', value: round2(trend.slope), confidence: round2(trend.r2) });
    cells[1]!.push({ state: momentum > 2 ? 'up' : momentum < -2 ? 'down' : 'flat', value: round2(momentum) });
    cells[2]!.push({ state: vol < 1 ? 'flat' : 'up', value: round2(vol) });
  }
  // Confluence only when there is genuine cross-period agreement.
  total = trendStates.length;
  const ups = trendStates.filter((s) => s === 'up').length;
  const downs = trendStates.filter((s) => s === 'down').length;
  agree = Math.max(ups, downs);
  const confluence = total >= 3 && agree / total >= 0.75 ? round2(agree / total) : undefined;

  return { periods, dimensions, cells, confluence };
}

function buildAssumptions(query: StructuredQuery, tables: DataTable[]): string[] {
  const out: string[] = [];
  if (tables.some((t) => t.quality?.mock)) out.push('Some inputs come from a mock provider (clearly marked) — values are synthetic.');
  if (query.timeRange === undefined && tables.length) out.push('No explicit time range requested; the data source default window was used.');
  return out;
}

function buildLimitations(tables: DataTable[], errors: Array<{ sourceId: string; error: string }>): string[] {
  const out: string[] = [];
  for (const e of errors) out.push(`Data source "${e.sourceId}" unavailable: ${e.error}`);
  for (const t of tables) {
    if ((t.quality?.completeness ?? 1) < 0.7) out.push(`Dataset "${t.label}" is partially complete (${Math.round((t.quality?.completeness ?? 1) * 100)}%).`);
  }
  return out;
}

function buildUncertainty(forecast: unknown, whatIf: boolean): string[] {
  const out: string[] = [];
  if (forecast) out.push('Forecast intervals are residual-based model estimates; uncertainty grows with horizon.');
  if (whatIf) out.push('What-if outputs are hypothetical — no validated causal model.');
  return out;
}

export { CORE_ANALYSTS };
