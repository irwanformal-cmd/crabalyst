/** Lifecycle hook points. */
export const HookPoints = {
  BeforeAgent: 'BeforeAgent',
  AfterAgent: 'AfterAgent',
  BeforeToolCall: 'BeforeToolCall',
  AfterToolCall: 'AfterToolCall',
  ToolError: 'ToolError',
  BeforeCommand: 'BeforeCommand',
  AfterCommand: 'AfterCommand',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
} as const;

export type HookPoint = (typeof HookPoints)[keyof typeof HookPoints];

export interface HookContext {
  hookPoint: HookPoint;
  sessionId?: string;
  workspacePath: string;
  /** Input of the tool/command, when relevant. */
  input?: unknown;
  /** Result of the tool/command, when relevant (After* hooks). */
  result?: unknown;
  /** Error for ToolError. */
  error?: unknown;
  /** The Agent Runtime (loosely typed to avoid a cycle). */
  runtime?: unknown;
  /** Arbitrary extra context. */
  meta?: Record<string, unknown>;
}

export interface Hook {
  name: string;
  point: HookPoint;
  pluginId?: string;
  run(context: HookContext): Promise<void> | void;
}
