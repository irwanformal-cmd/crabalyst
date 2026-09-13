/**
 * Analyst Registry + built-in domain-agnostic analysts.
 *
 * Analysts are deterministic analytic functions over DataTables. They are
 * selected dynamically by the Analysis Planner — never hard-coded per query.
 * Plugins register domain specialists (technical, sentiment, on-chain, …)
 * through the same interface.
 */
import {
  columnValues,
  detectAnomalies,
  detectChangePoint,
  forecastSeries,
  linearRegression,
  mean,
  min as arrMin,
  max as arrMax,
  pctChange,
  pearson,
  round2,
  stdev,
  trendDirection,
  volatilityPct,
} from './stats.js';
import type {
  Analyst,
  AnalystContext,
  AnalystOutput,
  DataTable,
  EvidenceItem,
  Finding,
  Reliability,
} from './types.js';

let idSeq = 0;
export function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class AnalystRegistry {
  private analysts = new Map<string, Analyst>();

  register(analyst: Analyst): void {
    this.analysts.set(analyst.id, analyst);
  }

  unregister(id: string): boolean {
    return this.analysts.delete(id);
  }

  get(id: string): Analyst | undefined {
    return this.analysts.get(id);
  }

  list(): Analyst[] {
    return [...this.analysts.values()];
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TIME_KEYS = ['t', 'timestamp', 'time', 'date', 'ts'];

export interface SeriesPick {
  table: DataTable;
  key: string;
  label: string;
  values: number[];
  timestamps?: Array<number | string>;
}

/** Pick the primary numeric series from a table (close > value > first numeric). */
export function pickSeries(table: DataTable, metricHint?: string): SeriesPick | undefined {
  const numeric = table.columns.filter((c) => c.type === 'number');
  if (!numeric.length) return undefined;
  let col = numeric[0]!;
  const preferred = ['close', 'c', 'value', 'y', metricHint ?? ''];
  for (const p of preferred) {
    if (!p) continue;
    const hit = numeric.find((c) => c.key === p || c.label.toLowerCase() === p || c.key.includes(p));
    if (hit) {
      col = hit;
      break;
    }
  }
  const values = columnValues(table.rows, col.key);
  if (values.length < 2) return undefined;
  const timeCol = table.columns.find((c) => c.type === 'timestamp' || TIME_KEYS.includes(c.key));
  const timestamps = timeCol
    ? table.rows.map((r) => {
        const v = r[timeCol.key];
        const n = typeof v === 'number' ? v : Date.parse(String(v));
        return Number.isFinite(n) ? (n as number) : String(v);
      })
    : undefined;
  return { table, key: col.key, label: col.label, values, timestamps };
}

/** Pick one series per table (for cross-entity comparison/correlation). */
export function pickSeriesPerTable(tables: DataTable[], metricHint?: string): SeriesPick[] {
  const picks: SeriesPick[] = [];
  for (const t of tables) {
    const p = pickSeries(t, metricHint);
    if (p) picks.push(p);
  }
  return picks;
}

export function makeEvidence(partial: Omit<EvidenceItem, 'id' | 'findingIds'> & { findingIds?: string[] }): EvidenceItem {
  return { id: nextId('ev'), findingIds: partial.findingIds ?? [], ...partial };
}

export function makeFinding(partial: Omit<Finding, 'id'>): Finding {
  return { id: nextId('f'), ...partial };
}

function output(analystId: string, partial: Partial<AnalystOutput> & { findings: Finding[]; evidence: EvidenceItem[] }): AnalystOutput {
  return { analystId, ok: true, ...partial };
}

function insufficient(analystId: string, reason: string): AnalystOutput {
  return { analystId, ok: false, findings: [], evidence: [], error: reason, headline: 'insufficient data' };
}

function reliabilityFor(values: number[]): Reliability {
  if (values.length >= 60) return 'high';
  if (values.length >= 20) return 'medium';
  return 'low';
}

/** Choose the "main" series: prefer the table matching the query subject. */
function primarySeries(ctx: AnalystContext): SeriesPick | undefined {
  const candidates = ctx.tables.filter((t) => t.kind === 'timeseries' || t.kind === 'ohlcv');
  if (!candidates.length) return undefined;
  const metric = ctx.query.metrics[0];
  const subjectTable = ctx.query.subject
    ? candidates.find((t) => t.entity === ctx.query.subject)
    : undefined;
  const table = subjectTable ?? candidates[0]!;
  return pickSeries(table, metric);
}

// ---------------------------------------------------------------------------
// Built-in analysts (domain-agnostic)
// ---------------------------------------------------------------------------

export const statisticalAnalyst: Analyst = {
  id: 'statistical',
  name: 'Statistical Analyst',
  description: 'Descriptive statistics: level, dispersion, volatility, change.',
  supportedIntents: ['analyze', 'summarize', 'explain', 'evaluate', 'diagnose', 'discover', 'compare', 'predict', 'performance', 'risk', 'relationship', 'simulate', 'decide', 'understand'],
  analysisTypes: ['statistical', 'descriptive', 'trend', 'anomaly', 'comparison', 'forecast', 'performance', 'risk', 'correlation', 'volume', 'onchain', 'flow', 'scenario'],
  requiredDataTypes: ['timeseries', 'ohlcv', 'table'],
  reliability: 0.9,
  run(ctx) {
    const series = primarySeries(ctx);
    if (!series) return insufficient('statistical', 'no numeric series available');
    const { values } = series;
    const change = pctChange(values);
    const vol = volatilityPct(values);
    const evidence: EvidenceItem[] = [
      makeEvidence({ sourceId: series.table.sourceId, analystId: 'statistical', metric: 'latest', value: round2(values[values.length - 1]!), reliability: reliabilityFor(values), label: `latest ${series.label} = ${round2(values[values.length - 1]!)}` }),
      makeEvidence({ sourceId: series.table.sourceId, analystId: 'statistical', metric: 'change_pct', value: round2(change), baseline: 0, transformation: 'pctChange(first,last)', reliability: reliabilityFor(values), label: `${series.label} change ${round2(change)}% over window` }),
      makeEvidence({ sourceId: series.table.sourceId, analystId: 'statistical', metric: 'volatility_pct', value: round2(vol), reliability: reliabilityFor(values), label: `volatility ${round2(vol)}%` }),
      makeEvidence({ sourceId: series.table.sourceId, analystId: 'statistical', metric: 'range', value: { min: round2(arrMin(values)), max: round2(arrMax(values)), mean: round2(mean(values)), stdev: round2(stdev(values)), n: values.length }, reliability: reliabilityFor(values), label: `range ${round2(arrMin(values))}–${round2(arrMax(values))} (n=${values.length})` }),
    ];
    const finding = makeFinding({
      title: `${series.label} ${change >= 0 ? 'up' : 'down'} ${Math.abs(round2(change))}% over the observed window`,
      detail: `mean ${round2(mean(values))}, stdev ${round2(stdev(values))}, volatility ${round2(vol)}%, n=${values.length}.`,
      analystId: 'statistical',
      evidenceIds: evidence.map((e) => e.id),
      tags: ['statistical'],
    });
    for (const e of evidence) e.findingIds.push(finding.id);
    return output('statistical', {
      findings: [finding],
      evidence,
      confidence: values.length >= 30 ? 0.8 : 0.55,
      headline: `change ${round2(change)}% · vol ${round2(vol)}%`,
    });
  },
};

export const trendAnalyst: Analyst = {
  id: 'trend',
  name: 'Trend Analyst',
  description: 'Trend direction, momentum and strength from linear fit.',
  supportedIntents: ['analyze', 'trend', 'pattern', 'diagnose', 'forecast', 'predict', 'evaluate', 'discover', 'performance'],
  analysisTypes: ['trend', 'momentum', 'seasonality', 'pattern', 'forecast', 'technical', 'performance'],
  requiredDataTypes: ['timeseries', 'ohlcv'],
  reliability: 0.85,
  run(ctx) {
    const series = primarySeries(ctx);
    if (!series) return insufficient('trend', 'no numeric series available');
    const t = trendDirection(series.values);
    // Momentum: recent third vs previous third drift.
    const third = Math.floor(series.values.length / 3);
    const momentumPct = third > 0 ? pctChange(series.values.slice(-third)) : 0;
    const evidence: EvidenceItem[] = [
      makeEvidence({ sourceId: series.table.sourceId, analystId: 'trend', metric: 'trend_slope', value: round2(t.slope), transformation: 'OLS linear fit', reliability: reliabilityFor(series.values), label: `trend slope ${round2(t.slope)} (R²=${round2(t.r2)})` }),
      makeEvidence({ sourceId: series.table.sourceId, analystId: 'trend', metric: 'momentum_pct', value: round2(momentumPct), transformation: 'pctChange(last third)', reliability: reliabilityFor(series.values), label: `recent momentum ${round2(momentumPct)}%` }),
    ];
    const finding = makeFinding({
      title: `Trend is ${t.direction === 'flat' ? 'sideways' : t.direction === 'up' ? 'rising' : 'falling'} (${t.strength})`,
      detail: `R²=${round2(t.r2)}; recent momentum ${round2(momentumPct)}%.`,
      analystId: 'trend',
      confidence: t.strength === 'strong' ? 0.8 : t.strength === 'moderate' ? 0.6 : 0.4,
      evidenceIds: evidence.map((e) => e.id),
      tags: ['trend'],
    });
    for (const e of evidence) e.findingIds.push(finding.id);
    return output('trend', {
      findings: [finding],
      evidence,
      confidence: finding.confidence,
      headline: `${t.direction} (${t.strength})`,
    });
  },
};

export const anomalyAnalyst: Analyst = {
  id: 'anomaly',
  name: 'Anomaly Analyst',
  description: 'Z-score and rolling-baseline anomaly detection with severity ranking.',
  supportedIntents: ['anomaly', 'discover', 'diagnose', 'troubleshoot', 'analyze', 'find'],
  analysisTypes: ['anomaly', 'statistical', 'pattern', 'flow', 'onchain', 'performance'],
  requiredDataTypes: ['timeseries', 'ohlcv', 'table'],
  reliability: 0.85,
  run(ctx) {
    const series = primarySeries(ctx);
    if (!series) return insufficient('anomaly', 'no numeric series available');
    const anomalies = detectAnomalies(series.values, {
      method: 'zscore',
      threshold: 3,
      metric: series.label,
      timestamps: series.timestamps,
      idPrefix: ctx.query.subject ?? 'series',
    });
    const evidence: EvidenceItem[] = anomalies.slice(0, 5).map((a) =>
      makeEvidence({
        sourceId: series.table.sourceId,
        analystId: 'anomaly',
        timestamp: a.timestamp,
        metric: a.metric,
        value: round2(a.value),
        baseline: round2(a.baseline),
        transformation: `zscore deviation ${a.deviation}σ`,
        reliability: reliabilityFor(series.values),
        findingIds: [],
        label: `${a.metric} = ${round2(a.value)} vs baseline ${round2(a.baseline)} (${a.deviation}σ)`,
      }),
    );
    const findings: Finding[] = [];
    if (anomalies.length) {
      const finding = makeFinding({
        title: `${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} detected in ${series.label}`,
        detail: `most severe: ${round2(anomalies[0]!.value)} (${anomalies[0]!.deviation}σ from baseline ${round2(anomalies[0]!.baseline)}).`,
        analystId: 'anomaly',
        evidenceIds: evidence.map((e) => e.id),
        tags: ['anomaly'],
      });
      for (const e of evidence) e.findingIds.push(finding.id);
      findings.push(finding);
    }
    return output('anomaly', {
      findings,
      evidence,
      anomalies,
      headline: anomalies.length ? `${anomalies.length} anomalies` : 'no anomalies',
    });
  },
};

export const correlationAnalyst: Analyst = {
  id: 'correlation',
  name: 'Correlation Analyst',
  description: 'Pairwise Pearson correlation and linear relationship between series.',
  supportedIntents: ['relationship', 'correlation', 'influence', 'compare', 'analyze'],
  analysisTypes: ['correlation', 'regression', 'influence', 'comparison'],
  requiredDataTypes: ['timeseries', 'ohlcv', 'table'],
  reliability: 0.8,
  run(ctx) {
    const seriesList = pickSeriesPerTable(ctx.tables.filter((t) => t.kind !== 'text'), ctx.query.metrics[0]);
    if (seriesList.length < 2) {
      // Fall back to correlating numeric columns within one table.
      const table = ctx.tables.find((t) => t.columns.filter((c) => c.type === 'number').length >= 2);
      if (!table) return insufficient('correlation', 'need at least two numeric series');
      const numericCols = table.columns.filter((c) => c.type === 'number');
      const a = columnValues(table.rows, numericCols[0]!.key);
      const b = columnValues(table.rows, numericCols[1]!.key);
      return correlationOutput(ctx, table.sourceId, numericCols[0]!.label, a, numericCols[1]!.label, b);
    }
    const [a, b] = seriesList;
    return correlationOutput(ctx, a!.table.sourceId, a!.label, a!.values, b!.label, b!.values, seriesList);
  },
};

function correlationOutput(
  ctx: AnalystContext,
  sourceId: string,
  labelA: string,
  a: number[],
  labelB: string,
  b: number[],
  allSeries?: SeriesPick[],
): AnalystOutput {
  const r = pearson(a, b);
  const fit = linearRegression(b.slice(0, Math.min(a.length, b.length)));
  const strength = Math.abs(r);
  const direction: 'positive' | 'negative' | undefined = r > 0.05 ? 'positive' : r < -0.05 ? 'negative' : undefined;
  const evidence = [
    makeEvidence({
      sourceId,
      analystId: 'correlation',
      metric: 'pearson_r',
      value: round2(r),
      transformation: `pearson(${labelA}, ${labelB})`,
      reliability: a.length >= 30 ? 'high' : 'medium',
      label: `${labelA} vs ${labelB}: r = ${round2(r)}`,
    }),
  ];
  const finding = makeFinding({
    title: `${labelA} and ${labelB} show ${strength < 0.2 ? 'no meaningful' : strength < 0.5 ? 'weak' : strength < 0.8 ? 'moderate' : 'strong'} ${direction ?? ''} correlation (r=${round2(r)})`.replace(/\s+/g, ' '),
    analystId: 'correlation',
    evidenceIds: evidence.map((e) => e.id),
    tags: ['correlation'],
  });
  for (const e of evidence) e.findingIds.push(finding.id);
  const relationships = [
    {
      id: nextId('rel'),
      kind: 'correlation' as const,
      a: labelA,
      b: labelB,
      strength: round2(r),
      direction,
      evidenceIds: evidence.map((e) => e.id),
    },
  ];
  // Extra pairwise correlations when more series exist.
  if (allSeries && allSeries.length > 2) {
    for (let i = 0; i < allSeries.length; i++) {
      for (let j = i + 1; j < allSeries.length; j++) {
        if (i === 0 && j === 1) continue;
        const rr = pearson(allSeries[i]!.values, allSeries[j]!.values);
        relationships.push({
          id: nextId('rel'),
          kind: 'correlation' as const,
          a: allSeries[i]!.label,
          b: allSeries[j]!.label,
          strength: round2(rr),
          direction: rr > 0.05 ? 'positive' as const : rr < -0.05 ? 'negative' as const : undefined,
          evidenceIds: [],
        });
      }
    }
  }
  void ctx;
  void fit;
  return output('correlation', { findings: [finding], evidence, relationships, headline: `r=${round2(r)}` });
}

export const forecastingAnalyst: Analyst = {
  id: 'forecasting',
  name: 'Forecasting Analyst',
  description: 'Linear-regression forecast with residual-based uncertainty interval.',
  supportedIntents: ['forecast', 'predict', 'probability'],
  analysisTypes: ['forecast', 'seasonality'],
  requiredDataTypes: ['timeseries', 'ohlcv'],
  reliability: 0.7,
  run(ctx) {
    const series = primarySeries(ctx);
    if (!series || series.values.length < 10) return insufficient('forecasting', 'need at least 10 observations for a forecast');
    const n = series.values.length;
    const horizon = Math.min(Math.max(Math.round(n / 4), 3), 30);
    // Estimate step size from timestamps when present.
    let stepMs: number | undefined;
    const ts = series.timestamps?.map((t) => Number(t)).filter((t) => Number.isFinite(t)) as number[] | undefined;
    if (ts && ts.length >= 2) stepMs = ts[ts.length - 1]! - ts[ts.length - 2]!;
    const fc = forecastSeries(series.values, horizon, ts, stepMs);
    const fit = linearRegression(series.values);
    const confidence = Math.min(0.85, 0.3 + fit.r2 * 0.6);
    const evidence = [
      makeEvidence({
        sourceId: series.table.sourceId,
        analystId: 'forecasting',
        metric: 'forecast_fit',
        value: { slope: round2(fit.slope), r2: round2(fit.r2), residualStd: round2(fc.residualStd) },
        transformation: 'OLS + residual interval',
        reliability: reliabilityFor(series.values),
        label: `forecast fit R²=${round2(fit.r2)}, residual σ=${round2(fc.residualStd)}`,
      }),
    ];
    const finding = makeFinding({
      title: `Forecast (${fc.method}): ${fit.slope >= 0 ? 'rising' : 'falling'} over next ${horizon} steps`,
      detail: `intervals widen with horizon; R²=${round2(fit.r2)}.`,
      analystId: 'forecasting',
      confidence: round2(confidence),
      evidenceIds: evidence.map((e) => e.id),
      tags: ['forecast'],
    });
    evidence[0]!.findingIds.push(finding.id);
    return output('forecasting', {
      findings: [finding],
      evidence,
      forecast: {
        method: fc.method,
        horizon: `${horizon} steps`,
        points: fc.points,
        confidence: round2(confidence),
        notes: ['Model estimate from historical trend only — not a guarantee.', `fit R²=${round2(fit.r2)}`],
      },
      confidence: round2(confidence),
      headline: `forecast ${fit.slope >= 0 ? '↑' : '↓'} ${horizon} steps`,
    });
  },
};

export const comparativeAnalyst: Analyst = {
  id: 'comparative',
  name: 'Comparative Analyst',
  description: 'Cross-entity comparison: absolute/percentage change, ranking, relative performance.',
  supportedIntents: ['compare', 'rank', 'benchmark', 'analyze'],
  analysisTypes: ['comparison', 'ranking', 'performance'],
  requiredDataTypes: ['timeseries', 'ohlcv', 'table'],
  reliability: 0.85,
  run(ctx) {
    const seriesList = pickSeriesPerTable(ctx.tables.filter((t) => t.kind !== 'text'), ctx.query.metrics[0]);
    if (seriesList.length < 2) return insufficient('comparative', 'need at least two comparable series');
    const rows = seriesList.map((s) => ({
      label: s.table.entity ?? s.label,
      first: s.values[0]!,
      last: s.values[s.values.length - 1]!,
      changePct: round2(pctChange(s.values)),
      volatility: round2(volatilityPct(s.values)),
      trend: trendDirection(s.values).direction,
    }));
    const ranked = [...rows].sort((a, b) => b.changePct - a.changePct);
    const evidence = rows.map((r) =>
      makeEvidence({
        sourceId: seriesList.find((s) => (s.table.entity ?? s.label) === r.label)?.table.sourceId,
        analystId: 'comparative',
        metric: 'relative_change_pct',
        value: r.changePct,
        transformation: 'pctChange over window',
        reliability: 'medium',
        label: `${r.label}: ${r.changePct}%`,
      }),
    );
    const finding = makeFinding({
      title: `${ranked[0]!.label} leads (${ranked[0]!.changePct}%) vs ${ranked[ranked.length - 1]!.label} (${ranked[ranked.length - 1]!.changePct}%)`,
      detail: rows.map((r) => `${r.label}: ${r.changePct}% (${r.trend})`).join('; '),
      analystId: 'comparative',
      evidenceIds: evidence.map((e) => e.id),
      tags: ['comparison'],
    });
    for (const e of evidence) e.findingIds.push(finding.id);
    return output('comparative', {
      findings: [finding],
      evidence,
      headline: `${ranked[0]!.label} +${ranked[0]!.changePct}% leads`,
    });
  },
};

export const regimeAnalyst: Analyst = {
  id: 'regime',
  name: 'Regime Analyst',
  description: 'Classifies the current regime: trend, volatility, momentum states.',
  supportedIntents: ['analyze', 'evaluate', 'risk', 'diagnose', 'performance', 'trend'],
  analysisTypes: ['trend', 'risk', 'performance', 'statistical'],
  requiredDataTypes: ['timeseries', 'ohlcv'],
  reliability: 0.75,
  run(ctx) {
    const series = primarySeries(ctx);
    if (!series || series.values.length < 10) return insufficient('regime', 'no numeric series available');
    const v = series.values;
    const trend = trendDirection(v);
    const vol = volatilityPct(v);
    const volMedian = vol; // single-window volatility; classify relative to scale
    const third = Math.floor(v.length / 3);
    const momentum = third > 0 ? pctChange(v.slice(-third)) : 0;

    const regimes = [
      { dimension: 'trend', state: trend.direction === 'up' ? 'rising' : trend.direction === 'down' ? 'falling' : 'ranging', trend: trend.direction, value: round2(trend.slope) },
      { dimension: 'volatility', state: volMedian < 1 ? 'low' : volMedian < 3 ? 'moderate' : 'high', value: round2(vol), trend: 'flat' as const },
      { dimension: 'momentum', state: momentum > 2 ? 'accelerating' : momentum < -2 ? 'fading' : 'stable', value: round2(momentum), trend: momentum > 0.5 ? 'up' as const : momentum < -0.5 ? 'down' as const : 'flat' as const },
    ];
    const overall = trend.direction === 'flat' ? 'ranging' : trend.strength === 'strong' ? 'trending' : 'transitional';
    const evidence = [
      makeEvidence({ sourceId: series.table.sourceId, analystId: 'regime', metric: 'regime', value: { overall, volatilityPct: round2(vol), momentumPct: round2(momentum) }, reliability: reliabilityFor(v), label: `regime: ${overall} (vol ${round2(vol)}%, momentum ${round2(momentum)}%)` }),
    ];
    const finding = makeFinding({
      title: `Current regime: ${overall}`,
      detail: regimes.map((r) => `${r.dimension}=${r.state}`).join(', '),
      analystId: 'regime',
      evidenceIds: evidence.map((e) => e.id),
      tags: ['regime'],
    });
    evidence[0]!.findingIds.push(finding.id);
    return output('regime', { findings: [finding], evidence, regimes, headline: `regime: ${overall}` });
  },
};

export const levelsAnalyst: Analyst = {
  id: 'levels',
  name: 'Levels Analyst',
  description: 'Important observed levels: window high/low, baseline mean, recent close.',
  supportedIntents: ['analyze', 'evaluate', 'decide', 'recommend', 'trend', 'diagnose'],
  analysisTypes: ['technical', 'trend', 'risk', 'recommendation'],
  requiredDataTypes: ['timeseries', 'ohlcv'],
  reliability: 0.7,
  run(ctx) {
    const series = primarySeries(ctx);
    if (!series) return insufficient('levels', 'no numeric series available');
    const v = series.values;
    const hi = arrMax(v);
    const lo = arrMin(v);
    const avg = mean(v);
    const lastV = v[v.length - 1]!;
    // Classic floor-trader pivot ladder — fully deterministic from the window.
    // Labels follow trader convention: R1/S1 = nearest barrier to current price.
    const pivot = (hi + lo + lastV) / 3;
    const pivotR1 = 2 * pivot - lo;
    const pivotS1 = 2 * pivot - hi;
    const mk = (label: string, value: number, kind: string, reason: string, consequence: string) =>
      ({ id: nextId('lvl'), label, value: round2(value), kind, reason, consequence, evidenceIds: [] as string[] });
    const resistances = [pivotR1, hi].filter((x) => x > lastV).sort((a, b) => a - b);
    const supports = [pivotS1, lo].filter((x) => x < lastV).sort((a, b) => b - a);
    const candidates = [
      ...resistances.slice(0, 2).map((x, i) => mk(`Resistance ${i + 1}`, x, 'resistance', i === 0 ? 'nearest barrier above (pivot/window high)' : 'next barrier above (pivot/window high)', i === 0 ? 'first upside hurdle' : 'a break above signals range expansion')),
      mk('Current', lastV, 'current', `latest ${series.label}`, 'reference price'),
      ...supports.slice(0, 2).map((x, i) => mk(`Support ${i + 1}`, x, 'support', i === 0 ? 'nearest cushion below (pivot/window low)' : 'deeper cushion (pivot/window low)', i === 0 ? 'first downside cushion' : 'a break below signals range breakdown')),
      mk('Baseline mean', avg, 'baseline', 'window average', 'mean-reversion reference'),
    ];
    // Drop near-duplicates so chart lines do not overlap (tolerance = 1% of range).
    const tolerance = Math.max(1e-9, (hi - lo) * 0.01);
    const levels: typeof candidates = [];
    for (const cand of candidates) {
      if (!levels.some((kept) => Math.abs(kept.value - cand.value) <= tolerance)) levels.push(cand);
    }
    const evidence = [
      makeEvidence({ sourceId: series.table.sourceId, analystId: 'levels', metric: 'levels', value: { high: round2(hi), low: round2(lo), mean: round2(avg), last: round2(lastV), pivot: round2(pivot), r1: round2(pivotR1), s1: round2(pivotS1) }, reliability: reliabilityFor(v), label: `R ${round2(hi)} / pivot ${round2(pivot)} / last ${round2(lastV)} / S ${round2(lo)}` }),
    ];
    for (const lvl of levels) lvl.evidenceIds.push(evidence[0]!.id);
    const finding = makeFinding({
      title: `Key levels: ${levels.filter((l) => l.kind === 'resistance' || l.kind === 'support').map((l) => `${l.label} ${l.value}`).join(' / ')} (range ${round2(lo)}–${round2(hi)})`,
      analystId: 'levels',
      evidenceIds: [evidence[0]!.id],
      tags: ['levels'],
    });
    evidence[0]!.findingIds.push(finding.id);
    return output('levels', { findings: [finding], evidence, levels, headline: `${round2(lo)}–${round2(hi)}` });
  },
};

export const causalAnalyst: Analyst = {
  id: 'causal',
  name: 'Causal Analyst',
  description: 'Change-point detection and evidence-based explanation of moves. Never invents causes.',
  supportedIntents: ['diagnose', 'troubleshoot'],
  analysisTypes: ['causal', 'trend', 'anomaly'],
  requiredDataTypes: ['timeseries', 'ohlcv'],
  reliability: 0.65,
  run(ctx) {
    const series = primarySeries(ctx);
    if (!series || series.values.length < 10) return insufficient('causal', 'need a longer series to localize a cause');
    const cp = detectChangePoint(series.values);
    const anomalies = detectAnomalies(series.values, { method: 'zscore', threshold: 2.5, metric: series.label, timestamps: series.timestamps, idPrefix: ctx.query.subject ?? 'series' });
    const evidence: EvidenceItem[] = [];
    const findings: Finding[] = [];
    if (cp) {
      const ts = series.timestamps?.[cp.index];
      const ev = makeEvidence({
        sourceId: series.table.sourceId,
        analystId: 'causal',
        timestamp: ts !== undefined ? new Date(ts).toISOString() : undefined,
        metric: 'change_point',
        value: { index: cp.index, magnitude: round2(cp.magnitude) },
        transformation: 'rolling-mean shift',
        reliability: 'medium',
        label: `regime shift at #${cp.index} (Δ ${round2(cp.magnitude)})`,
      });
      evidence.push(ev);
      const direction = cp.magnitude >= 0 ? 'upward' : 'downward';
      const finding = makeFinding({
        title: `${direction} shift localized around observation #${cp.index}${ts ? ` (${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')})` : ''}`,
        detail: anomalies.length
          ? `${anomalies.length} anomalous observations cluster near the shift. Correlated drivers require additional datasets; no external cause is claimed without evidence.`
          : 'No external cause is claimed without supporting evidence from additional datasets.',
        analystId: 'causal',
        confidence: 0.55,
        evidenceIds: [ev.id],
        tags: ['causal'],
      });
      ev.findingIds.push(finding.id);
      findings.push(finding);
    }
    return output('causal', {
      findings,
      evidence,
      anomalies,
      headline: cp ? `shift at #${cp.index}` : 'no clear shift',
    });
  },
};

/** All built-in core analysts. */
export const CORE_ANALYSTS: Analyst[] = [
  statisticalAnalyst,
  trendAnalyst,
  anomalyAnalyst,
  correlationAnalyst,
  forecastingAnalyst,
  comparativeAnalyst,
  regimeAnalyst,
  levelsAnalyst,
  causalAnalyst,
];
