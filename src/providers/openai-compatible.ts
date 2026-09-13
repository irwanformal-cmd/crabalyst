import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderEvent,
  ToolCall,
  ToolDefinition,
} from '../types/provider.js';
import { parseSSE } from './sse.js';

/** Convert internal messages to OpenAI chat-completion message format. */
export function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '', name: m.name });
    } else if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        }));
      }
      out.push(entry);
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export function toOpenAITools(tools?: ToolDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ type: 'function', function: t.function }));
}

interface OpenAIDelta {
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  finish_reason?: string | null;
}

/**
 * OpenAI-compatible streaming provider. Works with OpenAI, DeepSeek, Qwen
 * (DashScope compatible-mode), and arbitrary custom endpoints configured via
 * `base_url`.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly model: string;
  private apiKey: string;
  private options: Record<string, unknown>;
  private allowStream: boolean;

  constructor(cfg: ProviderConfig) {
    this.id = cfg.name;
    this.label = cfg.name;
    this.baseUrl = (cfg.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = cfg.model;
    this.apiKey = cfg.api_key ?? process.env[cfg.api_key_env ?? 'OPENAI_API_KEY'] ?? '';
    this.options = cfg.options ?? {};
    this.allowStream = this.options.stream !== false;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      systemPrompt: true,
      vision: this.options.vision === true,
      maxContextTokens: (this.options.maxContextTokens as number) ?? 128_000,
    };
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const url = `${this.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: request.model || this.model,
      messages: [...(request.system ? [{ role: 'system', content: request.system }] : []), ...toOpenAIMessages(request.messages)],
      stream: this.allowStream,
    };
    const tools = toOpenAITools(request.tools);
    if (tools) body.tools = tools;
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (this.options.tool_choice) body.tool_choice = this.options.tool_choice;
    if (request.extra) Object.assign(body, request.extra);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.options.headers as Record<string, string> | undefined),
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      yield { type: 'error', message: `provider request failed: ${(err as Error).message}`, cause: err };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      yield { type: 'error', message: `provider HTTP ${response.status}: ${text.slice(0, 500)}` };
      return;
    }

    if (!this.allowStream) {
      yield* this.handleNonStreaming(response);
      return;
    }
    yield* this.handleStreaming(response, signal);
  }

  private async *handleNonStreaming(response: Response): AsyncIterable<ProviderEvent> {
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = json.choices?.[0]?.message;
    const text = message?.content ?? '';
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeJsonParse(tc.function.arguments),
    }));
    if (text) yield { type: 'text', text };
    for (const call of toolCalls) yield { type: 'tool_call', call };
    yield {
      type: 'done',
      text,
      toolCalls,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
      },
    };
  }

  private async *handleStreaming(response: Response, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    let text = '';
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
    let usage: Record<string, number> | undefined;

    for await (const data of parseSSE(response.body!, signal)) {
      if (data === '[DONE]') break;
      let chunk: { choices?: Array<{ delta?: OpenAIDelta; message?: unknown }>; usage?: Record<string, number> | undefined };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue;
      }
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const acc = toolCallAccum.get(index) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolCallAccum.set(index, acc);
      }
    }

    const toolCalls: ToolCall[] = [...toolCallAccum.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({ id: acc.id || `call-${Math.random().toString(36).slice(2)}`, name: acc.name, arguments: safeJsonParse(acc.args) }));

    for (const call of toolCalls) yield { type: 'tool_call', call };
    yield {
      type: 'done',
      text,
      toolCalls,
      usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined,
    };
  }
}

function safeJsonParse(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
