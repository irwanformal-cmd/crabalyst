/**
 * Intelligence Layer — shared structured types.
 *
 * Everything in this file is plain JSON-serializable data. The frontend
 * consumes these structures directly; no free-form LLM text parsing.
 * Domain logic (finance, gamedev, …) lives in plugins — the core types are
 * domain-agnostic and every section of AnalysisResult is optional.
 */

// ---------------------------------------------------------------------------
// Query understanding
// ---------------------------------------------------------------------------

export type IntentCategory =
  | 'understand'
  | 'compare'
  | 'diagnose'
  | 'discover'
  | 'predict'
  | 'evaluate'
  | 'decide'
  | 'relationship'
  | 'simulate';

/** A resolved entity mention (asset, company, dataset, service, …). */
export interface ResolvedEntity {
  /** Canonical id, e.g. "BTCUSDT", "acme-corp", "service:auth". */
  id: string;
  /** Human label, e.g. "Bitcoin". */
  label: string;
  /** Entity kind: asset | company | dataset | service | project | metric | generic */
  kind: string;
  domain?: string;
  /** Resolver that produced this entity. */
  resolverId: string;
  /** The raw mention in the query text. */
  mention: string;
  meta?: Record<string, unknown>;
}

export interface TimeRange {
  kind: 'today' | 'past' | 'range' | 'all';
  amount?: number;
  unit?: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
  from?: string;
  to?: string;
  label: string;
}

export interface WhatIfRequest {
  variable: string;
  changePct?: number;
  changeAbs?: number;
  direction?: 'increase' | 'decrease';
}

/** Structured representation of a natural-language analysis request. */
export interface StructuredQuery {
  raw: string;
  intent: string;
  intentCategory: IntentCategory;
  /** Canonical id of the primary subject, when resolved. */
  subject?: string;
  subjectLabel?: string;
  domain?: string;
  entities: ResolvedEntity[];
  analysisTypes: string[];
  timeRange?: TimeRange;
  dimensions: string[];
  metrics: string[];
  /** Entities beyond the subject (comparison targets, related series). */
  compareTargets: ResolvedEntity[];
  requestedOutput: string[];
  visualizationPreference?: string;
  depth: 'quick' | 'standard' | 'deep';
  whatIf?: WhatIfRequest;
}

// ---------------------------------------------------------------------------
// Data sources & tables
// ---------------------------------------------------------------------------

export type DataKind = 'timeseries' | 'ohlcv' | 'table' | 'events' | 'text' | 'network';

export interface DataColumn {
  key: string;
  label: string;
  type: 'number' | 'string' | 'timestamp' | 'boolean';
  unit?: string;
}

export interface DataQuality {
  /** 0..1 — fraction of expected values present. */
  completeness: number;
  freshness?: string;
  issues?: string[];
  /** True when the data comes from a clearly-marked mock provider. */
  mock?: boolean;
}

/** A domain-neutral tabular/series dataset with provenance. */
export interface DataTable {
  id: string;
  sourceId: string;
  label: string;
  kind: DataKind;
  entity?: string;
  columns: DataColumn[];
  rows: Array<Record<string, unknown>>;
  unit?: string;
  provenance: string;
  quality?: DataQuality;
  meta?: Record<string, unknown>;
}

export interface DataRequest {
  query: StructuredQuery;
  entities: ResolvedEntity[];
  timeRange?: TimeRange;
  metrics: string[];
  /** Workspace root, for filesystem-backed sources. */
  workspacePath?: string;
}

export interface DataSourceInfo {
  id: string;
  label: string;
  kind: string;
  domains?: string[];
  provides: { kinds: DataKind[]; metrics?: string[]; entities?: string[] };
  pluginId?: string;
  /** Mock sources must always be marked. */
  mock?: boolean;
}

export interface DataSource extends DataSourceInfo {
  /** Fetch data for a request. Implementations never fabricate values. */
  fetch(req: DataRequest): Promise<DataTable[]>;
}

// ---------------------------------------------------------------------------
// Analysts
// ---------------------------------------------------------------------------

export interface AnalystContext {
  query: StructuredQuery;
  tables: DataTable[];
  sources: DataSourceInfo[];
  workspacePath: string;
  sessionId?: string;
  runtime?: unknown;
  /** Report a human-readable activity step. */
  emit(step: string, detail?: string): void;
}

export interface Analyst {
  id: string;
  name: string;
  description: string;
  /** Intent ids or intent categories this analyst serves. */
  supportedIntents: string[];
  /** Analysis type tags, e.g. trend, anomaly, correlation, onchain, flow. */
  analysisTypes: string[];
  /** When set, the analyst only applies to these domains. */
  domains?: string[];
  /** Data kinds the analyst needs at least one of. */
  requiredDataTypes?: DataKind[];
  /** Owning plugin, when registered by one. */
  pluginId?: string;
  /** Relative reliability weight 0..1 used by the decision synthesizer. */
  reliability?: number;
  run(ctx: AnalystContext): Promise<AnalystOutput> | AnalystOutput;
}

export interface AnalystOutput {
  analystId: string;
  ok: boolean;
  findings: Finding[];
  evidence: EvidenceItem[];
  anomalies?: Anomaly[];
  relationships?: Relationship[];
  levels?: ImportantLevel[];
  regimes?: Regime[];
  forecast?: Forecast;
  /** Analyst-level confidence 0..1, only when meaningful. */
  confidence?: number;
  /** Weight for confidence aggregation (set by the engine from analyst reliability). */
  confidenceWeight?: number;
  /** Short headline shown on the analyst card. */
  headline?: string;
  error?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Evidence, findings, anomalies, relationships
// ---------------------------------------------------------------------------

export type Reliability = 'high' | 'medium' | 'low';

export interface EvidenceItem {
  id: string;
  sourceId?: string;
  analystId?: string;
  timestamp?: string;
  metric: string;
  value: unknown;
  baseline?: unknown;
  transformation?: string;
  reliability: Reliability;
  findingIds: string[];
  /** Human-readable one-liner, e.g. "exchange outflow +21% vs 7d baseline". */
  label: string;
}

export interface Finding {
  id: string;
  title: string;
  detail?: string;
  analystId?: string;
  confidence?: number;
  evidenceIds: string[];
  tags: string[];
}

export interface Anomaly {
  id: string;
  metric: string;
  timestamp?: string;
  index?: number;
  value: number;
  baseline: number;
  /** Signed deviation in standard deviations or percent (see method). */
  deviation: number;
  method: 'zscore' | 'rolling' | 'pct-deviation' | 'change-point' | 'iqr';
  severity: 'low' | 'medium' | 'high';
  explanation?: string;
  evidenceIds: string[];
}

export interface Relationship {
  id: string;
  kind: 'correlation' | 'dependency' | 'influence' | 'co-occurrence' | 'hierarchy';
  a: string;
  b: string;
  /** -1..1 for correlation, 0..1 otherwise. */
  strength?: number;
  direction?: 'positive' | 'negative' | 'bidirectional';
  detail?: string;
  evidenceIds: string[];
}

// ---------------------------------------------------------------------------
// Decision, confidence, scenarios, forecast
// ---------------------------------------------------------------------------

export interface ConfidenceBreakdown {
  /** Combined headline confidence 0..1, undefined when not meaningful. */
  overall?: number;
  model?: number;
  evidenceStrength: 'high' | 'medium' | 'low' | 'insufficient';
  dataQuality: 'good' | 'partial' | 'poor' | 'unknown';
  prediction?: number;
}

export interface Decision {
  /** Short verdict sentence, e.g. "Trend is accelerating." */
  decision: string;
  /** Domain-agnostic classification, e.g. bullish | growth | degraded. */
  classification: string;
  confidence?: number;
  breakdown: ConfidenceBreakdown;
  rationale: string[];
  evidenceIds: string[];
  recommendations: string[];
  invalidation: string[];
  /** Domain-specific extras (entry/target/stop for finance, …). */
  domainData: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  name: string;
  /** Model estimate 0..1, never presented as fact. */
  probability?: number;
  conditions: string[];
  expectedOutcome: string[];
  supportingEvidence: string[];
  risks: string[];
  uncertainty: string[];
  kind: 'observed' | 'inferred' | 'forecast' | 'hypothetical';
}

export interface ForecastPoint {
  x: number | string;
  y: number;
  lower?: number;
  upper?: number;
}

export interface Forecast {
  method: string;
  horizon: string;
  points: ForecastPoint[];
  confidence?: number;
  notes: string[];
}

export interface ImportantLevel {
  id: string;
  label: string;
  value: number;
  kind: string;
  reason?: string;
  confidence?: number;
  consequence?: string;
  evidenceIds: string[];
}

export interface Regime {
  dimension: string;
  state: string;
  value?: number;
  trend?: 'up' | 'down' | 'flat';
}

export interface MultiPeriodCell {
  state: 'up' | 'down' | 'flat' | 'na';
  value?: number;
  confidence?: number;
}

export interface MultiPeriodAnalysis {
  periods: string[];
  dimensions: string[];
  /** cells[dimensionIndex][periodIndex] */
  cells: MultiPeriodCell[][];
  /** Confluence score 0..1, only present when statistically justified. */
  confluence?: number;
}

// ---------------------------------------------------------------------------
// Visualization
// ---------------------------------------------------------------------------

export type VizType =
  | 'line'
  | 'area'
  | 'candlestick'
  | 'bar'
  | 'grouped-bar'
  | 'stacked-bar'
  | 'scatter'
  | 'histogram'
  | 'heatmap'
  | 'correlation-matrix'
  | 'network'
  | 'pie'
  | 'donut'
  | 'treemap'
  | 'sankey'
  | 'kpi'
  | 'timeline'
  | 'matrix';

export interface VizSeries {
  id: string;
  label: string;
  color?: string;
  /** [x, y] points; x is epoch-ms for time series, number, or category index. */
  points: Array<[number, number]>;
}

export interface VisualizationSpec {
  id: string;
  type: VizType;
  title: string;
  /** Type-specific payload (see web/viz.js renderers). */
  data: unknown;
  xType?: 'time' | 'number' | 'category';
  links?: {
    findingIds?: string[];
    evidenceIds?: string[];
    analystIds?: string[];
    sourceIds?: string[];
  };
}

// ---------------------------------------------------------------------------
// Evidence / reasoning graph (user-facing, auditable — no hidden CoT)
// ---------------------------------------------------------------------------

export interface EvidenceGraphNode {
  id: string;
  kind: 'conclusion' | 'finding' | 'evidence' | 'metric' | 'analyst' | 'source' | 'anomaly' | 'scenario' | 'assumption' | 'forecast';
  label: string;
  detail?: string;
}

export interface EvidenceGraphEdge {
  from: string;
  to: string;
  kind: 'supports' | 'contradicts' | 'derived-from' | 'correlates-with' | 'caused-by' | 'depends-on' | 'contributes-to';
}

export interface EvidenceGraph {
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
}

// ---------------------------------------------------------------------------
// Analysis plan & result
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  durationMs?: number;
}

export interface AnalysisPlan {
  workflow: string;
  rationale: string;
  analystIds: string[];
  sourceIds: string[];
  steps: PlanStep[];
}

export type AnalysisStatus = 'success' | 'partial' | 'insufficient-evidence' | 'unavailable' | 'error';

/** The central structured result the frontend consumes. */
export interface AnalysisResult {
  id: string;
  query: StructuredQuery;
  subject?: string;
  subjectLabel?: string;
  domain?: string;
  intent: string;
  timestamp: string;
  status: AnalysisStatus;
  dataSources: DataSourceInfo[];
  analysts: AnalystOutput[];
  visualizations: VisualizationSpec[];
  findings: Finding[];
  evidence: EvidenceItem[];
  anomalies: Anomaly[];
  relationships: Relationship[];
  decision?: Decision;
  scenarios?: Scenario[];
  forecast?: Forecast;
  uncertainty: string[];
  assumptions: string[];
  limitations: string[];
  importantLevels: ImportantLevel[];
  regimes: Regime[];
  multiPeriod?: MultiPeriodAnalysis;
  evidenceGraph?: EvidenceGraph;
  plan: AnalysisPlan;
  executionTrace: PlanStep[];
}
