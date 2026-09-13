/**
 * Provider abstraction.
 *
 * The Agent Core depends only on this interface. Anthropic, OpenAI-compatible,
 * DeepSeek, Qwen and custom providers are implementations behind it, so a
 * provider swap never requires changes to the agent, tools or plugins.
 */

/** Minimal JSON Schema subset used to describe tool inputs. */
export type JSONSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  additionalProperties?: boolean | JSONSchema;
  [key: string]: unknown;
};

export interface ToolCall {
  /** Stable id assigned by the model (where available). */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool calls made by the assistant in this message (assistant role). */
  toolCalls?: ToolCall[];
  /** For role === 'tool': the id of the tool call this result answers. */
  toolCallId?: string;
  /** Optional display name for the tool that produced this result. */
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  system?: string;
  /** Max output tokens. Providers map this to their own parameter. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Arbitrary provider-specific options passed through. */
  extra?: Record<string, unknown>;
}

/** Normalized streaming events produced by every provider implementation. */
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | {
      type: 'done';
      /** Final assistant text (excluding tool calls). */
      text: string;
      toolCalls: ToolCall[];
      usage?: Usage;
    }
  | { type: 'error'; message: string; cause?: unknown };

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  systemPrompt: boolean;
  vision: boolean;
  maxContextTokens?: number;
  /** Any extra capability flags a provider wants to advertise. */
  [key: string]: unknown;
}

export interface LLMProvider {
  /** Stable, unique provider id (e.g. `deepseek`). */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /**
   * Stream a chat completion as a sequence of normalized events.
   * Implementations should respect the AbortSignal for cancellation.
   */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  getCapabilities(): ProviderCapabilities;
}

/** Provider configuration, serializable to/from YAML. */
export interface ProviderConfig {
  name: string;
  /** Provider kind: openai-compatible | anthropic | mock. */
  kind: string;
  base_url?: string;
  api_key_env?: string;
  api_key?: string;
  model: string;
  /** Extra options passed through to the underlying client. */
  options?: Record<string, unknown>;
  /** Marked true for the currently active provider. */
  default?: boolean;
}

export const PROVIDER_KINDS = ['openai-compatible', 'anthropic', 'mock'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
