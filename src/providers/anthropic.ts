import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderEvent,
  ToolCall,
} from '../types/provider.js';
import { parseSSEWithEvents } from './sse-events.js';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

/** Convert internal messages into Anthropic Messages API format. */
export function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: string; content: AnthropicContentBlock[] }> {
  const out: Array<{ role: string; content: AnthropicContentBlock[] }> = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      // Group consecutive tool results into one user message.
      const blocks: AnthropicContentBlock[] = [];
      while (i < messages.length && messages[i]!.role === 'tool') {
        blocks.push({ type: 'tool_result', tool_use_id: messages[i]!.toolCallId ?? '', content: messages[i]!.content });
        i++;
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: 'assistant', content: blocks });
    } else {
      out.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
    }
    i++;
  }
  return out;
}

export function toAnthropicTools(tools: ChatRequest['tools']): Array<{ name: string; description: string; input_schema: unknown }> {
  return (tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * Anthropic Messages API provider with streaming support and native
 * tool-use blocks normalized into the common ToolCall shape.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly model: string;
  private apiKey: string;
  private options: Record<string, unknown>;

  constructor(cfg: ProviderConfig) {
    this.id = cfg.name;
    this.label = cfg.name;
    this.baseUrl = (cfg.base_url ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.model = cfg.model;
    this.apiKey = cfg.api_key ?? process.env[cfg.api_key_env ?? 'ANTHROPIC_API_KEY'] ?? '';
    this.options = cfg.options ?? {};
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      systemPrompt: true,
      vision: this.options.vision === true,
      maxContextTokens: (this.options.maxContextTokens as number) ?? 200_000,
    };
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const url = `${this.baseUrl}/v1/messages`;
    const body: Record<string, unknown> = {
      model: request.model || this.model,
      max_tokens: request.maxTokens ?? 4096,
      messages: toAnthropicMessages(request.messages),
      stream: true,
    };
    if (request.system) body.system = request.system;
    if (request.tools?.length) body.tools = toAnthropicTools(request.tools);
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.extra) Object.assign(body, request.extra);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      ...(this.options.headers as Record<string, string> | undefined),
    };

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (err) {
      yield { type: 'error', message: `provider request failed: ${(err as Error).message}`, cause: err };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      yield { type: 'error', message: `provider HTTP ${response.status}: ${text.slice(0, 500)}` };
      return;
    }

    let text = '';
    const toolAccum = new Map<number, { id: string; name: string; input: string }>();
    let usage: Record<string, number> | undefined;

    for await (const { event, data } of parseSSEWithEvents(response.body!, signal)) {
      if (event === 'error') {
        yield { type: 'error', message: String(data) };
        return;
      }
      if (event === 'message_stop') break;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event === 'content_block_delta') {
        const delta = payload.delta as { type?: string; text?: string; partial_json?: string };
        if (delta?.type === 'text_delta' && delta.text) {
          text += delta.text;
          yield { type: 'text', text: delta.text };
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          const index = (payload.index as number) ?? 0;
          const acc = toolAccum.get(index) ?? { id: '', name: '', input: '' };
          acc.input += delta.partial_json;
          toolAccum.set(index, acc);
        }
      } else if (event === 'content_block_start') {
        const block = payload.content_block as { type?: string; id?: string; name?: string; index?: number };
        if (block?.type === 'tool_use') {
          const index = block.index ?? toolAccum.size;
          const acc = toolAccum.get(index) ?? { id: '', name: '', input: '' };
          if (block.id) acc.id = block.id;
          if (block.name) acc.name = block.name;
          toolAccum.set(index, acc);
        }
      } else if (event === 'message_delta') {
        const u = payload.usage as Record<string, number> | undefined;
        if (u) usage = { ...usage, ...u };
      } else if (event === 'message_start') {
        const m = payload.message as { usage?: Record<string, number> };
        if (m.usage) usage = m.usage;
      }
    }

    const toolCalls: ToolCall[] = [...toolAccum.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({ id: acc.id || `toolu-${Math.random().toString(36).slice(2)}`, name: acc.name, arguments: safeJsonParse(acc.input) }));

    for (const call of toolCalls) yield { type: 'tool_call', call };
    yield {
      type: 'done',
      text,
      toolCalls,
      usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : undefined,
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
