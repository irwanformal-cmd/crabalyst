/**
 * Structured internal agent events.
 *
 * The CLI/web UI consume these events instead of parsing terminal text.
 */

export type AgentEvent =
  | { type: 'planning'; plan?: string; sessionId?: string }
  | { type: 'tool_call'; toolCallId: string; name: string; input: unknown; sessionId?: string }
  | { type: 'tool_result'; toolCallId: string; name: string; ok: boolean; output: string; sessionId?: string }
  | { type: 'reflection'; text: string; sessionId?: string }
  | { type: 'continuation'; sessionId?: string }
  | { type: 'completion'; summary: string; sessionId?: string }
  | { type: 'text'; text: string; sessionId?: string }
  | { type: 'usage'; usage: import('./provider.js').Usage; sessionId?: string }
  | { type: 'error'; message: string; cause?: unknown; sessionId?: string }
  | { type: 'status'; message: string; sessionId?: string }
  | { type: 'subagent_start'; id: string; name: string; sessionId?: string }
  | { type: 'subagent_result'; id: string; name: string; ok: boolean; result: string; sessionId?: string }
  | { type: 'ensemble_start'; symbol: string; agents: string[]; sessionId?: string }
  | { type: 'analysis_start'; analysisId: string; query: import('../intelligence/types.js').StructuredQuery; sessionId?: string }
  | { type: 'analysis_step'; analysisId: string; step: import('../intelligence/types.js').PlanStep; sessionId?: string }
  | { type: 'analyst_result'; analysisId: string; analystId: string; ok: boolean; headline?: string; confidence?: number; evidenceLabels?: string[]; sessionId?: string }
  | { type: 'analysis_plan'; analysisId: string; steps: Array<{ id: string; label: string; status: string }>; sessionId?: string }
  | { type: 'analysis_result'; analysisId: string; result: import('../intelligence/types.js').AnalysisResult; sessionId?: string }
  | {
      type: 'ensemble_result';
      symbol: string;
      direction: 'bullish' | 'bearish' | 'neutral';
      confidence: number;
      votes: Array<{ agent: string; direction: string; confidence: number; rationale: string; ok: boolean }>;
      sessionId?: string;
    };

/** Serializable agent event for transport (WebSocket / logs). */
export interface AgentEventEnvelope {
  seq: number;
  ts: string;
  event: AgentEvent;
}
