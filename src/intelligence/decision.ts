/**
 * Decision Synthesizer — builds the generic Decision/Verdict model.
 *
 * Never fabricates confidence: the breakdown distinguishes evidence strength,
 * data quality and model confidence, and reports "insufficient evidence"
 * instead of inventing a number.
 */
import { evidenceStrength } from './evidence.js';
import type {
  AnalystOutput,
  ConfidenceBreakdown,
  DataTable,
  Decision,
  StructuredQuery,
} from './types.js';

export interface DecisionInput {
  query: StructuredQuery;
  outputs: AnalystOutput[];
  tables: DataTable[];
  sourceErrors: Array<{ sourceId: string; error: string }>;
}

export function synthesizeDecision(input: DecisionInput): Decision | undefined {
  const okOutputs = input.outputs.filter((o) => o.ok && o.findings.length);
  const allEvidence = input.outputs.flatMap((o) => o.evidence);
  const allFindings = input.outputs.flatMap((o) => o.findings);

  const strength = evidenceStrength(allEvidence, allFindings);
  const dataQuality = computeDataQuality(input.tables, input.sourceErrors);

  if (!okOutputs.length || strength === 'insufficient') {
    return {
      decision: 'Insufficient evidence to form a conclusion.',
      classification: 'insufficient-evidence',
      breakdown: { evidenceStrength: 'insufficient', dataQuality },
      rationale: [
        okOutputs.length ? 'Analysts produced no findings with supporting evidence.' : 'No analyst could run on the available data.',
        ...(input.sourceErrors.length ? [`Data source errors: ${input.sourceErrors.map((e) => `${e.sourceId} (${e.error})`).join('; ')}`] : []),
      ],
      evidenceIds: [],
      recommendations: ['Provide more data or a longer history.', 'Check that the relevant data sources are available.'],
      invalidation: [],
      domainData: {},
    };
  }

  // Weighted analyst confidence — weighted by declared reliability, and only
  // over analysts that actually produced a confidence value.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const out of okOutputs) {
    if (out.confidence === undefined) continue;
    const w = out.confidenceWeight ?? 1;
    weightedSum += out.confidence * w;
    weightTotal += w;
  }
  const modelConfidence = weightTotal > 0 ? weightedSum / weightTotal : undefined;
  const overall = modelConfidence !== undefined ? adjustForEvidence(modelConfidence, strength, dataQuality) : undefined;

  // Primary finding: the highest-confidence finding from the most reliable analyst.
  const primary = [...okOutputs]
    .sort((a, b) => (b.confidence ?? 0.5) * (b.confidenceWeight ?? 1) - (a.confidence ?? 0.5) * (a.confidenceWeight ?? 1))
    .flatMap((o) => o.findings)
    .sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5))[0];

  const classification = classify(input.query, okOutputs);
  const rationale = okOutputs
    .filter((o) => o.headline)
    .map((o) => `${o.analystId}: ${o.headline}`)
    .slice(0, 6);

  return {
    decision: primary?.title ?? 'Analysis complete.',
    classification,
    confidence: overall !== undefined ? Math.round(overall * 100) / 100 : undefined,
    breakdown: {
      overall,
      model: modelConfidence !== undefined ? Math.round(modelConfidence * 100) / 100 : undefined,
      evidenceStrength: strength,
      dataQuality,
    },
    rationale,
    evidenceIds: primary?.evidenceIds ?? [],
    recommendations: buildRecommendations(input.query, okOutputs),
    invalidation: buildInvalidation(input.query, okOutputs),
    domainData: {},
  };
}

function computeDataQuality(tables: DataTable[], errors: Array<{ sourceId: string; error: string }>): ConfidenceBreakdown['dataQuality'] {
  if (!tables.length) return errors.length ? 'poor' : 'unknown';
  const worst = Math.min(...tables.map((t) => t.quality?.completeness ?? 0.8));
  if (errors.length >= tables.length) return 'poor';
  if (worst < 0.5 || errors.length) return 'partial';
  return 'good';
}

function adjustForEvidence(model: number, strength: string, quality: string): number {
  let factor = 1;
  if (strength === 'low') factor *= 0.75;
  if (strength === 'medium') factor *= 0.9;
  if (quality === 'partial') factor *= 0.85;
  if (quality === 'poor') factor *= 0.6;
  return Math.max(0.05, Math.min(0.95, model * factor));
}

/** Domain-agnostic classification from analyst headlines/trends. */
function classify(query: StructuredQuery, outputs: AnalystOutput[]): string {
  const trend = outputs.find((o) => o.analystId === 'trend');
  const headline = trend?.headline ?? '';
  const anomalies = outputs.find((o) => o.analystId === 'anomaly');
  if (query.intentCategory === 'diagnose' && anomalies?.anomalies?.length) return 'anomalous';
  if (/up|rising/.test(headline)) return 'improving';
  if (/down|falling/.test(headline)) return 'declining';
  if (headline.includes('flat')) return 'stable';
  return query.intentCategory;
}

function buildRecommendations(query: StructuredQuery, outputs: AnalystOutput[]): string[] {
  const recs: string[] = [];
  const anomaly = outputs.find((o) => o.analystId === 'anomaly');
  if (anomaly?.anomalies?.length) {
    recs.push(`Investigate the ${anomaly.anomalies.length} detected anomal${anomaly.anomalies.length === 1 ? 'y' : 'ies'} before acting on trends.`);
  }
  const forecast = outputs.find((o) => o.analystId === 'forecasting' && o.forecast);
  if (forecast?.forecast) {
    recs.push('Treat the forecast as a model estimate; re-run when new data arrives.');
  }
  if (query.intentCategory === 'decide') {
    recs.push('Confirm the decision drivers against the linked evidence before committing.');
  }
  return recs.slice(0, 3);
}

function buildInvalidation(query: StructuredQuery, outputs: AnalystOutput[]): string[] {
  const out: string[] = [];
  const levels = outputs.find((o) => o.levels?.length);
  if (levels?.levels?.length && (query.domain === 'crypto' || query.domain === 'finance' || query.intentCategory === 'decide')) {
    const hi = levels.levels.find((l) => l.kind === 'resistance');
    const lo = levels.levels.find((l) => l.kind === 'support');
    if (hi) out.push(`A sustained break above ${hi.value} invalidates a range/decline read.`);
    if (lo) out.push(`A sustained break below ${lo.value} invalidates a recovery read.`);
  }
  return out.slice(0, 3);
}
