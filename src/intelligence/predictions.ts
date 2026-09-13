/**
 * Prediction Tracker — persists predictions produced by analyses and
 * evaluates them later against observed outcomes.
 *
 * Rules:
 *  - Never averages raw confidence values to claim skill.
 *  - Always reports sample size; refuses to claim predictive skill below the
 *    minimum sample threshold.
 *  - Direction accuracy / target reached / calibration are computed from
 *    recorded outcomes only.
 */

export interface PredictionRecord {
  analysisId: string;
  subject: string;
  prediction: string;
  confidence?: number;
  horizon?: string;
  target?: number;
  assumptions: string[];
  evidenceIds: string[];
  timestamp: string;
}

export interface PredictionEvaluation {
  predictionId: number;
  actual: string;
  directionCorrect?: boolean;
  targetReached?: boolean;
  magnitudeError?: number;
  evaluatedAt: string;
}

export interface AnalystTrackRecord {
  key: string;
  samples: number;
  directionAccuracy?: number;
  targetAccuracy?: number;
  /** True only when there are enough samples to say anything meaningful. */
  sufficient: boolean;
  note?: string;
}

export const MIN_SAMPLES_FOR_SKILL = 30;

export interface PredictionStore {
  recordPrediction(entry: {
    asset: string;
    timestamp: string;
    timeframe?: string;
    prediction: string;
    confidence?: number;
    reasoning: unknown;
    indicators: unknown;
    outcome?: string | null;
    plugin?: string;
  }): Promise<void>;
  recordPredictionEvaluation?(ev: PredictionEvaluation): Promise<void>;
  predictionPerformance?(): Promise<Array<{ key: string; samples: number; correct: number; targets: number; targetHits: number }>>;
}

/** Persist the predictions contained in an analysis result, when any. */
export function predictionsFromAnalysis(result: {
  id: string;
  subject?: string;
  decision?: { classification: string; confidence?: number };
  forecast?: { horizon: string; points: Array<{ y: number }> };
  assumptions: string[];
  evidence: Array<{ id: string }>;
  timestamp: string;
}): PredictionRecord | undefined {
  if (!result.subject || !result.decision) return undefined;
  const classification = result.decision.classification;
  if (classification === 'insufficient-evidence') return undefined;
  return {
    analysisId: result.id,
    subject: result.subject,
    prediction: classification,
    confidence: result.decision.confidence,
    horizon: result.forecast?.horizon,
    target: result.forecast?.points.length ? result.forecast.points[result.forecast.points.length - 1]!.y : undefined,
    assumptions: result.assumptions,
    evidenceIds: result.evidence.slice(0, 8).map((e) => e.id),
    timestamp: result.timestamp,
  };
}

/** Aggregate per-analyst/per-classification performance with sample sizes. */
export function aggregateTrackRecords(
  rows: Array<{ key: string; samples: number; correct: number; targets: number; targetHits: number }>,
): AnalystTrackRecord[] {
  return rows.map((r) => {
    const sufficient = r.samples >= MIN_SAMPLES_FOR_SKILL;
    return {
      key: r.key,
      samples: r.samples,
      directionAccuracy: r.samples > 0 ? Math.round((r.correct / r.samples) * 1000) / 10 : undefined,
      targetAccuracy: r.targets > 0 ? Math.round((r.targetHits / r.targets) * 1000) / 10 : undefined,
      sufficient,
      note: sufficient
        ? undefined
        : `only ${r.samples} sample${r.samples === 1 ? '' : 's'} — too few to claim predictive skill (need ${MIN_SAMPLES_FOR_SKILL}+)`,
    };
  });
}
