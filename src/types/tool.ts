import type { JSONSchema } from './provider.js';
import type { Permission } from './permissions.js';

/** Result of executing a tool. */
export interface ToolResult {
  /** Whether the tool considers itself successful. */
  ok: boolean;
  /** Human/model-readable output. */
  output: string;
  /** Structured data attached to the result (e.g. parsed values). */
  data?: unknown;
  /** Error message when ok === false. */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Arbitrary metadata (exit codes, paths, etc.). */
  meta?: Record<string, unknown>;
}

/** Execution context handed to every tool invocation. */
export interface ToolContext {
  sessionId?: string;
  workspacePath: string;
  /** The agent runtime, exposed for advanced tools (typed loosely to avoid cycles). */
  runtime?: unknown;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Environment variables visible to tools. */
  env?: Record<string, string>;
  /** Request/approve dangerous operations. */
  approver?: import('./permissions.js').Approver;
}

/** A callable tool. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permissions: Permission[];
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  /** Optional: hooks fired by the tool itself are not needed; see HookEngine. */
}

/** Runtime view of a tool (the model sees name/description/schema only). */
export interface ToolRuntime {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permissions: Permission[];
}
