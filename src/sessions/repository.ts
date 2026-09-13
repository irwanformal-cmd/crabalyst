import type { Database } from '../db/database.js';
import type { ChatMessage } from '../types/provider.js';
import type { SessionRecord, SessionSummary } from '../types/session.js';
import type { ToolResult } from '../types/tool.js';
import type { AnalysisResult } from '../intelligence/types.js';

/** Persistence boundary — replace with PostgreSQL/etc. behind this interface. */
export interface SessionRepository {
  // Intelligence layer: persisted analyses.
  recordAnalysis(entry: { id: string; sessionId?: string; result: AnalysisResult }): Promise<void>;
  getAnalysis(id: string): Promise<AnalysisResult | undefined>;
  listAnalyses(limit?: number): Promise<Array<{ id: string; query: string; subject?: string; intent: string; timestamp: string; classification?: string; status?: string }>>;
  create(session: SessionRecord): Promise<void>;
  update(session: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | undefined>;
  list(): Promise<SessionSummary[]>;
  delete(id: string): Promise<boolean>;
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>;
  recordToolCall(entry: {
    id: string;
    sessionId: string;
    toolCallId?: string;
    name: string;
    input: unknown;
    result: ToolResult;
  }): Promise<void>;
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
  recordJournal(entry: { sessionId?: string; eventType: string; payload: unknown }): Promise<void>;
  recordPredictionEvaluation(entry: {
    predictionId: number;
    actual: string;
    directionCorrect?: boolean;
    targetReached?: boolean;
    magnitudeError?: number;
    evaluatedAt: string;
  }): Promise<void>;
  predictionPerformance(): Promise<Array<{ key: string; samples: number; correct: number; targets: number; targetHits: number }>>;
  recordUsage(entry: {
    sessionId?: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    tool?: string;
    latencyMs?: number;
    error?: string;
  }): Promise<void>;
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private db: Database) {}

  // ---- intelligence layer: analyses ----

  async recordAnalysis(entry: { id: string; sessionId?: string; result: AnalysisResult }): Promise<void> {
    const r = entry.result;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO analyses (id, session_id, query, subject, domain, intent, classification, status, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sessionId ?? null,
        r.query.raw,
        r.subject ?? null,
        r.domain ?? null,
        r.intent,
        r.decision?.classification ?? null,
        r.status,
        JSON.stringify(r),
        r.timestamp,
      );
  }

  async getAnalysis(id: string): Promise<AnalysisResult | undefined> {
    const row = this.db.prepare(`SELECT result FROM analyses WHERE id=?`).get(id) as { result: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.result) as AnalysisResult;
    } catch {
      return undefined;
    }
  }

  async listAnalyses(limit = 50): Promise<Array<{ id: string; query: string; subject?: string; intent: string; timestamp: string; classification?: string; status?: string }>> {
    const rows = this.db
      .prepare(`SELECT id, query, subject, intent, classification, status, created_at FROM analyses ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      query: r.query as string,
      subject: (r.subject as string) || undefined,
      intent: r.intent as string,
      classification: (r.classification as string) || undefined,
      status: (r.status as string) || undefined,
      timestamp: r.created_at as string,
    }));
  }

  async create(session: SessionRecord): Promise<void> {
    this.db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, provider_id, model, plugins, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.title,
      session.workspacePath,
      session.providerId,
      session.model,
      JSON.stringify(session.plugins ?? []),
      JSON.stringify(session.metadata ?? {}),
      session.createdAt,
      session.updatedAt,
    );
  }

  async update(session: SessionRecord): Promise<void> {
    this.db.prepare(
      `UPDATE sessions SET title=?, workspace_path=?, provider_id=?, model=?, plugins=?, metadata=?, updated_at=? WHERE id=?`,
    ).run(
      session.title,
      session.workspacePath,
      session.providerId,
      session.model,
      JSON.stringify(session.plugins ?? []),
      JSON.stringify(session.metadata ?? {}),
      session.updatedAt,
      session.id,
    );
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const messages = this.db
      .prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY seq ASC`)
      .all(id) as Array<Record<string, unknown>>;
    return {
      id: row.id as string,
      title: row.title as string,
      workspacePath: row.workspace_path as string,
      providerId: row.provider_id as string,
      model: row.model as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      plugins: JSON.parse(row.plugins as string),
      metadata: JSON.parse(row.metadata as string),
      messages: messages.map((m) => ({
        role: m.role as ChatMessage['role'],
        content: m.content as string,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls as string) : undefined,
        toolCallId: (m.tool_call_id as string) || undefined,
        name: (m.name as string) || undefined,
      })),
    };
  }

  async list(): Promise<SessionSummary[]> {
    const rows = this.db
      .prepare(`SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count FROM sessions s ORDER BY updated_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      workspacePath: r.workspace_path as string,
      providerId: r.provider_id as string,
      model: r.model as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      pluginCount: (JSON.parse(r.plugins as string) as unknown[]).length,
      messageCount: Number(r.message_count ?? 0),
    }));
  }

  async delete(id: string): Promise<boolean> {
    this.db.prepare(`DELETE FROM messages WHERE session_id=?`).run(id);
    this.db.prepare(`DELETE FROM tool_calls WHERE session_id=?`).run(id);
    const res = this.db.prepare(`DELETE FROM sessions WHERE id=?`).run(id);
    return res.changes > 0;
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    const seqRow = this.db
      .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM messages WHERE session_id=?`)
      .get(sessionId) as { n: number };
    this.db
      .prepare(`INSERT INTO messages (session_id, seq, role, content, tool_calls, tool_call_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        sessionId,
        seqRow.n,
        message.role,
        message.content,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId ?? null,
        message.name ?? null,
        new Date().toISOString(),
      );
    this.db.prepare(`UPDATE sessions SET updated_at=? WHERE id=?`).run(new Date().toISOString(), sessionId);
  }

  async recordToolCall(entry: {
    id: string;
    sessionId: string;
    toolCallId?: string;
    name: string;
    input: unknown;
    result: ToolResult;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, session_id, tool_call_id, name, input, result, ok, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.toolCallId ?? null,
        entry.name,
        JSON.stringify(entry.input ?? {}),
        JSON.stringify(entry.result),
        entry.result.ok ? 1 : 0,
        entry.result.durationMs ?? null,
        new Date().toISOString(),
      );
  }

  async recordPrediction(entry: {
    asset: string;
    timestamp: string;
    timeframe?: string;
    prediction: string;
    confidence?: number;
    reasoning: unknown;
    indicators: unknown;
    outcome?: string | null;
    plugin?: string;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO predictions (asset, timestamp, timeframe, prediction, confidence, reasoning, indicators, outcome, plugin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.asset,
        entry.timestamp,
        entry.timeframe ?? null,
        entry.prediction,
        entry.confidence ?? null,
        JSON.stringify(entry.reasoning ?? {}),
        JSON.stringify(entry.indicators ?? {}),
        entry.outcome ?? null,
        entry.plugin ?? null,
        new Date().toISOString(),
      );
  }

  async recordJournal(entry: { sessionId?: string; eventType: string; payload: unknown }): Promise<void> {
    this.db
      .prepare(`INSERT INTO journal (session_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(entry.sessionId ?? null, entry.eventType, JSON.stringify(entry.payload ?? {}), new Date().toISOString());
  }

  async recordPredictionEvaluation(entry: {
    predictionId: number;
    actual: string;
    directionCorrect?: boolean;
    targetReached?: boolean;
    magnitudeError?: number;
    evaluatedAt: string;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO prediction_evaluations (prediction_id, actual, direction_correct, target_reached, magnitude_error, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.predictionId,
        entry.actual,
        entry.directionCorrect === undefined ? null : entry.directionCorrect ? 1 : 0,
        entry.targetReached === undefined ? null : entry.targetReached ? 1 : 0,
        entry.magnitudeError ?? null,
        entry.evaluatedAt,
      );
    // Mark the prediction as evaluated.
    this.db.prepare(`UPDATE predictions SET outcome=? WHERE id=?`).run(entry.actual, entry.predictionId);
  }

  async predictionPerformance(): Promise<Array<{ key: string; samples: number; correct: number; targets: number; targetHits: number }>> {
    const rows = this.db
      .prepare(
        `SELECT p.prediction AS key,
                COUNT(e.id) AS samples,
                SUM(CASE WHEN e.direction_correct = 1 THEN 1 ELSE 0 END) AS correct,
                SUM(CASE WHEN e.target_reached IS NOT NULL THEN 1 ELSE 0 END) AS targets,
                SUM(CASE WHEN e.target_reached = 1 THEN 1 ELSE 0 END) AS targetHits
         FROM predictions p
         JOIN prediction_evaluations e ON e.prediction_id = p.id
         GROUP BY p.prediction`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      key: r.key as string,
      samples: Number(r.samples ?? 0),
      correct: Number(r.correct ?? 0),
      targets: Number(r.targets ?? 0),
      targetHits: Number(r.targetHits ?? 0),
    }));
  }

  async recordUsage(entry: {
    sessionId?: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    tool?: string;
    latencyMs?: number;
    error?: string;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO usage (session_id, provider, model, input_tokens, output_tokens, tool, latency_ms, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.sessionId ?? null,
        entry.provider ?? null,
        entry.model ?? null,
        entry.inputTokens ?? null,
        entry.outputTokens ?? null,
        entry.tool ?? null,
        entry.latencyMs ?? null,
        entry.error ?? null,
        new Date().toISOString(),
      );
  }
}
