import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ProviderCapabilities,
  ProviderEvent,
  ToolCall,
} from '../types/provider.js';

export interface MockResponse {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

const DEFAULT_RESPONSES: MockResponse[] = [{ text: 'This is a mock response from the deterministic provider.' }];

/**
 * Deterministic provider for tests and offline development. It replays a list
 * of scripted responses, so an agent loop can be exercised without network or
 * API keys.
 */
export class MockProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  private responses: MockResponse[];
  private calls = 0;

  constructor(id: string, options?: Record<string, unknown>) {
    this.id = id;
    this.label = `Mock (${id})`;
    const script = options?.script as string | undefined;
    const configured = options?.responses as MockResponse[] | undefined;
    if (configured?.length) {
      this.responses = configured;
    } else if (script === 'tool') {
      this.responses = [
        {
          toolCalls: [{ name: 'echo', arguments: { message: 'hello from mock' } }],
        },
        { text: 'Tool executed successfully; final answer complete.' },
      ];
    } else if (script === 'tool_twice') {
      this.responses = [
        { toolCalls: [{ name: 'echo', arguments: { message: 'one' } }] },
        { toolCalls: [{ name: 'echo', arguments: { message: 'two' } }] },
        { text: 'Final answer after two tool calls.' },
      ];
    } else {
      this.responses = DEFAULT_RESPONSES;
    }
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    if (signal?.aborted) throw new Error('aborted');
    const idx = Math.min(this.calls, this.responses.length - 1);
    const response = this.responses[idx] ?? DEFAULT_RESPONSES[0]!;
    this.calls++;

    const toolCalls: ToolCall[] = (response.toolCalls ?? []).map((tc, i) => ({
      id: `mock-${this.calls}-${i}`,
      name: tc.name,
      arguments: tc.arguments ?? {},
    }));

    // Emit text first (if any), then tool calls, matching a streaming feel.
    if (response.text) {
      yield { type: 'text', text: response.text };
    }
    for (const call of toolCalls) {
      yield { type: 'tool_call', call };
    }
    yield {
      type: 'done',
      text: response.text ?? '',
      toolCalls,
      usage: {
        inputTokens: estimateTokens(request.messages),
        outputTokens: (response.text?.length ?? 0) / 4,
      },
    };
  }

  getCapabilities(): ProviderCapabilities {
    return { streaming: true, tools: true, systemPrompt: true, vision: false, maxContextTokens: 128_000 };
  }
}

function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}
