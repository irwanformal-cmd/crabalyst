import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAnomalies,
  pearson,
  linearRegression,
  trendDirection,
  volatilityPct,
  forecastSeries,
  detectChangePoint,
  pctChange,
} from '../src/intelligence/stats.js';
import { generateScenarios, runWhatIf } from '../src/intelligence/scenarios.js';
import { buildEvidenceGraph, collectEvidence, evidenceStrength } from '../src/intelligence/evidence.js';
import { synthesizeDecision } from '../src/intelligence/decision.js';
import { predictionsFromAnalysis, aggregateTrackRecords, MIN_SAMPLES_FOR_SKILL } from '../src/intelligence/predictions.js';
import type { AnalysisResult, DataTable, StructuredQuery } from '../src/intelligence/types.js';

const flat = Array.from({ length: 50 }, () => 100);
const rising = Array.from({ length: 50 }, (_, i) => 100 + i);
const falling = Array.from({ length: 50 }, (_, i) => 200 - i);
const withSpike = rising.map((v, i) => (i === 30 ? v + 500 : v));

function seriesTable(values: number[], id = 't1'): DataTable {
  return {
    id,
    sourceId: 'test-src',
    label: id,
    kind: 'timeseries',
    columns: [
      { key: 'i', label: 'index', type: 'number' },
      { key: 'value', label: 'value', type: 'number' },
    ],
    rows: values.map((v, i) => ({ i, value: v })),
    provenance: 'unit test',
    quality: { completeness: 1 },
  };
}

function baseQuery(partial: Partial<StructuredQuery>): StructuredQuery {
  return {
    raw: 'test',
    intent: 'analyze',
    intentCategory: 'discover',
    entities: [],
    analysisTypes: ['trend'],
    dimensions: [],
    metrics: [],
    compareTargets: [],
    requestedOutput: [],
    depth: 'standard',
    ...partial,
  };
}

test('z-score anomaly detection finds an injected spike with severity', () => {
  const anomalies = detectAnomalies(withSpike, { method: 'zscore', threshold: 3, metric: 'value', idPrefix: 't' });
  assert.ok(anomalies.length >= 1);
  assert.equal(anomalies[0]!.index, 30);
  assert.equal(anomalies[0]!.severity, 'high');
  // Flat series has no anomalies and no NaN crashes.
  assert.equal(detectAnomalies(flat, { method: 'zscore', metric: 'v', idPrefix: 't' }).length, 0);
});

test('rolling-baseline method detects regime breaks', () => {
  const series = [...Array.from({ length: 30 }, () => 10), ...Array.from({ length: 10 }, () => 40)];
  const anomalies = detectAnomalies(series, { method: 'rolling', window: 10, threshold: 3, metric: 'v', idPrefix: 't' });
  assert.ok(anomalies.length > 0);
  assert.ok(anomalies[0]!.index! >= 30);
});

test('pearson correlation: aligned vs inverted series', () => {
  assert.ok(pearson(rising, rising) > 0.99);
  assert.ok(pearson(rising, falling) < -0.99);
  const noise = rising.map((_, i) => (i % 2 === 0 ? 1 : -1));
  assert.ok(Math.abs(pearson(rising, noise)) < 0.3);
});

test('trend direction classification', () => {
  assert.equal(trendDirection(rising).direction, 'up');
  assert.equal(trendDirection(falling).direction, 'down');
  assert.equal(trendDirection(flat).direction, 'flat');
  assert.equal(trendDirection(rising).strength, 'strong');
});

test('linear regression and forecast produce intervals that widen with horizon', () => {
  const fit = linearRegression(rising);
  assert.equal(Math.round(fit.slope), 1);
  assert.ok(fit.r2 > 0.99);
  // Noisy series → non-zero residuals → intervals must widen with horizon.
  const noisy = rising.map((v, i) => v + (i % 3 === 0 ? 3 : i % 3 === 1 ? -2 : 1));
  const fc = forecastSeries(noisy, 5);
  assert.equal(fc.points.length, 5);
  assert.ok(fc.residualStd > 0);
  const widths = fc.points.map((p) => (p.upper ?? 0) - (p.lower ?? 0));
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i]! > widths[i - 1]!);
  // Perfectly linear data → zero-width intervals (honest, not fabricated).
  const perfect = forecastSeries(rising, 3);
  assert.equal(perfect.residualStd, 0);
});

test('change point localizes the regime shift', () => {
  const series = [...Array.from({ length: 40 }, () => 10), ...Array.from({ length: 40 }, () => 30)];
  const cp = detectChangePoint(series);
  assert.ok(cp);
  assert.ok(Math.abs(cp.index - 40) <= 4);
});

test('volatility is scale-normalized and positive', () => {
  assert.ok(volatilityPct(rising) > 0);
  assert.equal(volatilityPct(flat), 0);
  assert.ok(Math.abs(pctChange(rising) - 49) < 0.01);
});

test('scenario generation labels forecasts as model estimates', () => {
  const scenarios = generateScenarios({
    query: baseQuery({ intentCategory: 'predict', intent: 'forecast', analysisTypes: ['forecast'] }),
    tables: [seriesTable(rising)],
  });
  assert.ok(scenarios);
  assert.equal(scenarios.length, 3);
  assert.ok(scenarios.every((s) => s.kind === 'forecast'));
  assert.ok(scenarios.every((s) => s.uncertainty.length > 0));
  const totalP = scenarios.reduce((s, x) => s + (x.probability ?? 0), 0);
  assert.ok(Math.abs(totalP - 1) < 0.05, `probabilities sum ~1, got ${totalP}`);
  // Rising trend → upside more likely than downside.
  const up = scenarios.find((s) => s.name === 'Upside')!;
  const down = scenarios.find((s) => s.name === 'Downside')!;
  assert.ok(up.probability! > down.probability!);
});

test('scenarios are not generated for irrelevant intents', () => {
  const scenarios = generateScenarios({
    query: baseQuery({ intent: 'explain', intentCategory: 'understand' }),
    tables: [seriesTable(rising)],
  });
  assert.equal(scenarios, undefined);
});

test('what-if simulation is labeled hypothetical', () => {
  const result = runWhatIf({ variable: 'value', changePct: 20, direction: 'increase' }, [seriesTable(flat.map(() => 200))]);
  assert.ok(result);
  assert.equal(result.hypothetical, true);
  assert.equal(result.baseline, 200);
  assert.equal(result.projected, 240);
  assert.equal(result.scenario.kind, 'hypothetical');
  assert.ok(result.explanation.includes('Assuming'));
});

test('decision synthesizer reports insufficient evidence honestly', () => {
  const d = synthesizeDecision({
    query: baseQuery({}),
    outputs: [{ analystId: 'trend', ok: false, findings: [], evidence: [], error: 'no data' }],
    tables: [],
    sourceErrors: [{ sourceId: 'x', error: 'offline' }],
  });
  assert.ok(d);
  assert.equal(d.classification, 'insufficient-evidence');
  assert.equal(d.confidence, undefined);
  assert.equal(d.breakdown.evidenceStrength, 'insufficient');
});

test('decision confidence is discounted by weak evidence and poor data', () => {
  const strongOutputs = [{
    analystId: 'trend',
    ok: true,
    findings: [{ id: 'f1', title: 'rising', confidence: 0.9, evidenceIds: ['e1'], tags: [] }],
    evidence: [{ id: 'e1', metric: 'slope', value: 1, reliability: 'high' as const, findingIds: ['f1'], label: 'slope 1' }],
    confidence: 0.9,
    confidenceWeight: 1,
  }];
  const good = synthesizeDecision({ query: baseQuery({}), outputs: strongOutputs, tables: [seriesTable(rising)], sourceErrors: [] });
  const poor = synthesizeDecision({ query: baseQuery({}), outputs: strongOutputs, tables: [seriesTable(rising)], sourceErrors: [{ sourceId: 'a', error: 'x' }, { sourceId: 'b', error: 'y' }] });
  assert.ok(good!.confidence! > poor!.confidence!, `${good!.confidence} vs ${poor!.confidence}`);
});

test('evidence graph links conclusion→analyst→finding→evidence→source', () => {
  const { evidence, findings } = collectEvidence([{
    analystId: 'trend',
    ok: true,
    findings: [{ id: 'f1', title: 'rising trend', evidenceIds: ['e1'], tags: [] }],
    evidence: [{ id: 'e1', sourceId: 'src-1', metric: 'slope', value: 1, reliability: 'high', findingIds: ['f1'], label: 'slope 1' }],
  }]);
  assert.equal(evidenceStrength(evidence, findings), 'low'); // 1 evidence item
  const graph = buildEvidenceGraph({
    decisionSummary: 'Trend is rising',
    outputs: [{
      analystId: 'trend',
      ok: true,
      findings,
      evidence,
    }],
    sources: [{ id: 'src-1', label: 'Source 1' }],
  });
  const kinds = graph.nodes.map((n) => n.kind);
  assert.ok(kinds.includes('conclusion'));
  assert.ok(kinds.includes('analyst'));
  assert.ok(kinds.includes('finding'));
  assert.ok(kinds.includes('evidence'));
  assert.ok(kinds.includes('source'));
  assert.ok(graph.edges.some((e) => e.kind === 'supports' && e.from === 'e1' && e.to === 'f1'));
  assert.ok(graph.edges.some((e) => e.kind === 'derived-from' && e.from === 'f1'));
});

test('prediction tracking: records only meaningful predictions with sample-size honesty', () => {
  const noPred = predictionsFromAnalysis({ id: 'a1', assumptions: [], evidence: [], timestamp: 't' });
  assert.equal(noPred, undefined);

  const pred = predictionsFromAnalysis({
    id: 'a2',
    subject: 'BTCUSDT',
    decision: { classification: 'improving', confidence: 0.7 },
    forecast: { horizon: '7 steps', points: [{ y: 101 }, { y: 102 }] },
    assumptions: [],
    evidence: [{ id: 'e1' }],
    timestamp: 't',
  });
  assert.ok(pred);
  assert.equal(pred.target, 102);

  // Small samples never claim skill.
  const few = aggregateTrackRecords([{ key: 'technical', samples: 5, correct: 4, targets: 5, targetHits: 3 }]);
  assert.equal(few[0]!.sufficient, false);
  assert.ok(few[0]!.note!.includes('too few'));
  const many = aggregateTrackRecords([{ key: 'technical', samples: MIN_SAMPLES_FOR_SKILL + 1, correct: 22, targets: 10, targetHits: 6 }]);
  assert.equal(many[0]!.sufficient, true);
  assert.ok(many[0]!.directionAccuracy! > 0);
});

test('AnalysisResult schema stays JSON-serializable', async () => {
  // Round-trip a minimal result through JSON as the WS transport would.
  const minimal: Partial<AnalysisResult> = {
    id: 'x',
    timestamp: new Date().toISOString(),
    status: 'success',
    uncertainty: [],
    assumptions: [],
    limitations: [],
    importantLevels: [],
    regimes: [],
  };
  const json = JSON.stringify(minimal);
  const back = JSON.parse(json);
  assert.equal(back.id, 'x');
});

test('levels analyst emits a labeled pivot ladder (R2/R1/Current/S1/S2)', async () => {
  const { levelsAnalyst } = await import('../src/intelligence/analysts.js');
  // Window: lo=80, hi=120, last=110 -> P=103.33, R1=126.67, S1=86.67.
  const values = [80, 95, 120, 100, 110];
  const table: DataTable = {
    id: 't1', sourceId: 'src', kind: 'timeseries', label: 'test series',
    columns: [
      { key: 'i', label: 'index', type: 'number' },
      { key: 'value', label: 'value', type: 'number' },
    ],
    rows: values.map((v, i) => ({ i, value: v })),
    quality: { completeness: 1, freshness: 'test', mock: false }, provenance: 'test',
  };
  const query = {
    raw: 'test', intent: 'analyze', intentCategory: 'understand',
    entities: [], analysisTypes: ['technical'], dimensions: [], metrics: [],
    compareTargets: [], requestedOutput: [], depth: 'standard',
  } as StructuredQuery;
  const out = await levelsAnalyst.run({ query, tables: [table], sources: [], workspacePath: '', emit() {} });
  assert.ok(out.ok);
  const labels = (out.levels ?? []).map((l) => l.label);
  for (const expected of ['Resistance 2', 'Resistance 1', 'Current', 'Support 1', 'Support 2']) {
    assert.ok(labels.includes(expected), `missing ${expected} in [${labels.join(', ')}]`);
  }
  const by = (label: string) => (out.levels ?? []).find((l) => l.label === label)!.value;
  assert.equal(by('Resistance 1'), 120); // nearest barrier above current
  assert.equal(by('Resistance 2'), 126.67);
  assert.equal(by('Current'), 110);
  assert.equal(by('Support 1'), 86.67);
  assert.equal(by('Support 2'), 80);
});

test('candlestick/line specs carry chart-drawable levels', async () => {
  const { recommendVisualizations } = await import('../src/intelligence/visualization.js');
  const table: DataTable = {
    id: 't1', sourceId: 'src', kind: 'ohlcv', label: 'TEST 4h',
    columns: [], rows: [{ t: 1, open: 1, high: 2, low: 0.5, close: 1.5 }],
    quality: { completeness: 1, freshness: 'test', mock: false }, provenance: 'test',
  };
  const query = { raw: 'x', intent: 'analyze', intentCategory: 'understand', entities: [], analysisTypes: [], dimensions: [], metrics: [], compareTargets: [], requestedOutput: [], depth: 'standard' } as StructuredQuery;
  const levels = [
    { id: 'l1', label: 'Resistance 1', value: 2, kind: 'resistance', reason: 'r', evidenceIds: [] },
    { id: 'l2', label: 'Current', value: 1.5, kind: 'current', reason: 'r', evidenceIds: [] },
  ];
  const specs = recommendVisualizations({ query, tables: [table], outputs: [], levels });
  assert.equal(specs[0]!.type, 'candlestick');
  const drawn = (specs[0]!.data as { levels?: Array<{ label: string; kind: string }> }).levels ?? [];
  assert.equal(drawn.length, 2);
  assert.equal(drawn[1]!.kind, 'current');
});
