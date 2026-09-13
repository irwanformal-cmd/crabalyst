/**
 * Scenario Engine + What-if Simulation.
 *
 * Scenarios are model estimates derived from observed trend/volatility —
 * clearly labeled observed/inferred/forecast/hypothetical. What-if applies a
 * user-supplied parameter change to the observed relationship and labels the
 * output hypothetical when no validated model exists.
 */
import { linearRegression, mean, pctChange, round2, stdev, trendDirection, volatilityPct } from './stats.js';
import { nextId } from './analysts.js';
import type { DataTable, Scenario, StructuredQuery, WhatIfRequest } from './types.js';
import { columnValues } from './stats.js';

export interface ScenarioInput {
  query: StructuredQuery;
  tables: DataTable[];
}

/** Generate generic scenarios (upside / base / downside) when relevant. */
export function generateScenarios(input: ScenarioInput): Scenario[] | undefined {
  const { query, tables } = input;
  const relevant =
    query.intentCategory === 'predict' ||
    query.intentCategory === 'simulate' ||
    query.intentCategory === 'decide' ||
    query.intentCategory === 'evaluate' ||
    query.depth === 'deep';
  if (!relevant) return undefined;

  const table = tables.find((t) => t.kind === 'timeseries' || t.kind === 'ohlcv');
  if (!table) return undefined;
  const key = table.columns.find((c) => c.key === 'close' || c.key === 'value')?.key ?? table.columns.find((c) => c.type === 'number')?.key;
  if (!key) return undefined;
  const values = columnValues(table.rows, key);
  if (values.length < 10) return undefined;

  const last = values[values.length - 1]!;
  const trend = trendDirection(values);
  const vol = volatilityPct(values);
  const driftPct = pctChange(values);

  // Probability estimates from trend strength only — explicitly model estimates.
  const pUp = trend.direction === 'up' ? 0.35 + trend.r2 * 0.35 : trend.direction === 'down' ? 0.15 : 0.3;
  const pDown = trend.direction === 'down' ? 0.35 + trend.r2 * 0.35 : trend.direction === 'up' ? 0.15 : 0.3;
  const pBase = Math.max(0.1, 1 - pUp - pDown);
  const norm = pUp + pDown + pBase;

  const mk = (name: string, p: number, targetPct: number, conditions: string[], risks: string[]): Scenario => ({
    id: nextId('scn'),
    name,
    probability: round2(p / norm),
    conditions,
    expectedOutcome: [`${table.label} moves ~${targetPct > 0 ? '+' : ''}${round2(targetPct)}% from ${round2(last)} (≈ ${round2(last * (1 + targetPct / 100))})`],
    supportingEvidence: [`observed drift ${round2(driftPct)}%`, `volatility ${round2(vol)}%`, `trend ${trend.direction} (R²=${round2(trend.r2)})`],
    risks,
    uncertainty: ['Probabilities are model estimates from historical trend/volatility, not facts.'],
    kind: 'forecast',
  });

  return [
    mk('Upside', pUp, Math.max(2, vol * 3), ['trend persists', 'no adverse regime shift'], ['volatility expansion against the position']),
    mk('Base', pBase, Math.max(-1, Math.min(1, driftPct / 4)), ['current regime continues', 'mean-reversion dominates'], ['stale data', 'regime change']),
    mk('Downside', pDown, -Math.max(2, vol * 3), ['support breaks', 'momentum fades'], ['sharp mean-reversion rally']),
  ];
}

export interface WhatIfResult {
  variable: string;
  changePct?: number;
  changeAbs?: number;
  baseline: number;
  projected: number;
  assumption: string;
  hypothetical: boolean;
  explanation: string;
  scenario: Scenario;
}

/** Apply a what-if parameter change to the primary observed series. */
export function runWhatIf(whatIf: WhatIfRequest, tables: DataTable[]): WhatIfResult | undefined {
  const table = tables.find((t) => t.kind === 'timeseries' || t.kind === 'ohlcv' || t.kind === 'table');
  if (!table) return undefined;
  const numericCols = table.columns.filter((c) => c.type === 'number');
  if (!numericCols.length) return undefined;

  // Find the column matching the requested variable, else use the primary one.
  const varCol =
    numericCols.find((c) => c.key.toLowerCase().includes(whatIf.variable.toLowerCase()) || c.label.toLowerCase().includes(whatIf.variable.toLowerCase())) ??
    numericCols.find((c) => c.key === 'close' || c.key === 'value') ??
    numericCols[0]!;
  const values = columnValues(table.rows, varCol.key);
  if (!values.length) return undefined;

  const baseline = mean(values);
  const fit = linearRegression(values);
  const changePct = whatIf.changePct ?? (whatIf.changeAbs !== undefined ? (whatIf.changeAbs / (Math.abs(baseline) || 1)) * 100 : 0);
  const projected = baseline * (1 + changePct / 100);
  const spread = stdev(values);

  const hypothetical = true; // no validated causal model — always hypothetical
  const explanation =
    `Assuming a linear/proportional relationship, ${whatIf.variable} ` +
    `${changePct >= 0 ? '+' : ''}${round2(changePct)}% moves the expected level from ` +
    `${round2(baseline)} to ≈ ${round2(projected)} (±${round2(spread)} historical σ). ` +
    `Observed trend slope is ${round2(fit.slope)} per step (R²=${round2(fit.r2)}).`;

  return {
    variable: whatIf.variable,
    changePct: round2(changePct),
    changeAbs: whatIf.changeAbs,
    baseline: round2(baseline),
    projected: round2(projected),
    assumption: 'linear proportional response estimated from observed data',
    hypothetical,
    explanation,
    scenario: {
      id: nextId('scn'),
      name: `What-if: ${whatIf.variable} ${changePct >= 0 ? '+' : ''}${round2(changePct)}%`,
      probability: undefined,
      conditions: [`${whatIf.variable} changes by ${round2(changePct)}%`],
      expectedOutcome: [`level ≈ ${round2(projected)} (baseline ${round2(baseline)})`],
      supportingEvidence: [`historical σ ${round2(spread)}`, `trend R² ${round2(fit.r2)}`],
      risks: ['relationship may be non-linear or confounded'],
      uncertainty: ['Hypothetical — no validated causal model.'],
      kind: 'hypothetical',
    },
  };
}
