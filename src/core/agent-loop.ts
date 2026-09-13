import type { AgentEventBus } from './event-emitter.js';
import type { ContextManager } from './context-manager.js';
import type { HookEngine } from '../hooks/engine.js';
import type { SessionRepository } from '../sessions/repository.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { LLMProvider, ChatMessage, ToolCall, Usage } from '../types/provider.js';
import type { Skill } from '../types/skill.js';
import type { ToolResult } from '../types/tool.js';

export interface AgentRunOptions {
  sessionId?: string;
  workspacePath: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  maxIterations?: number;
  selectedSkills?: Skill[];
  toolsFilter?: (name: string) => boolean;
  runtime?: unknown;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Extra system prompt segments. */
  systemExtra?: string[];
}

export interface AgentRunResult {
  summary: string;
  messages: ChatMessage[];
  toolCalls: number;
  iterations: number;
  usage: Usage | undefined;
  ok: boolean;
}

export interface AgentLoopDeps {
  provider: LLMProvider;
  tools: ToolRegistry;
  contextManager: ContextManager;
  hooks: HookEngine;
  events: AgentEventBus;
  repository?: SessionRepository;
}

/**
 * The Agent Runtime's core loop: plan -> reason -> tool calls -> results ->
 * continue -> summarize. Providers are interchangeable; tools are discovered
 * through the registry; events are emitted structurally.
 */
export class AgentLoop {
  constructor(private deps: AgentLoopDeps) {}

  async run(userInput: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const { hooks, events, repository } = this.deps;
    const maxIterations = options.maxIterations ?? 25;
    const model = options.model ?? 'default';
    const sessionId = options.sessionId;

    const systemPrompt = this.deps.contextManager.buildSystemPrompt(options.selectedSkills, options.systemExtra);
    const history: ChatMessage[] = [{ role: 'user', content: userInput }];

    await hooks.fire('BeforeAgent', { runtime: options.runtime, sessionId, workspacePath: options.workspacePath, input: userInput });
    events.emit({ type: 'planning', sessionId });

    let totalToolCalls = 0;
    let lastUsage: Usage | undefined;
    let finalText = '';
    const allMessages: ChatMessage[] = [];

    try {
      for (let iter = 0; iter < maxIterations; iter++) {
        if (options.signal?.aborted) throw new Error('cancelled');

        const schemas = this.deps.tools
          .listSchemas()
          .filter((t) => (options.toolsFilter ? options.toolsFilter(t.function.name) : true));
        const messages = this.deps.contextManager.trim(history);

        let text = '';
        const toolCalls: ToolCall[] = [];

        for await (const event of this.deps.provider.chat(
          {
            model,
            messages,
            system: systemPrompt,
            tools: schemas,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
          },
          options.signal,
        )) {
          if (event.type === 'text') {
            text += event.text;
            events.emit({ type: 'text', text: event.text, sessionId });
          } else if (event.type === 'tool_call') {
            toolCalls.push(event.call);
            events.emit({ type: 'tool_call', toolCallId: event.call.id, name: event.call.name, input: event.call.arguments, sessionId });
          } else if (event.type === 'done') {
            lastUsage = event.usage;
            if (event.usage) events.emit({ type: 'usage', usage: event.usage, sessionId });
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        }

        if (text) {
          events.emit({ type: 'reflection', text, sessionId });
          finalText = text;
        }

        // Record the assistant message.
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: text,
          toolCalls: toolCalls.length ? toolCalls : undefined,
        };
        history.push(assistantMessage);
        allMessages.push(assistantMessage);
        if (repository && sessionId) await repository.appendMessage(sessionId, assistantMessage);

        if (toolCalls.length === 0) {
          events.emit({ type: 'completion', summary: text, sessionId });
          await hooks.fire('AfterAgent', { runtime: options.runtime, sessionId, workspacePath: options.workspacePath, result: { summary: text } });
          return { summary: text, messages: allMessages, toolCalls: totalToolCalls, iterations: iter + 1, usage: lastUsage, ok: true };
        }

        totalToolCalls += toolCalls.length;
        events.emit({ type: 'continuation', sessionId });

        for (const call of toolCalls) {
          await hooks.fire('BeforeToolCall', { runtime: options.runtime, sessionId, workspacePath: options.workspacePath, input: call, meta: { name: call.name } });
          const started = Date.now();
          let result: ToolResult;
          try {
            result = await this.deps.tools.execute(call.name, call.arguments, {
              sessionId,
              workspacePath: options.workspacePath,
              runtime: options.runtime,
              signal: options.signal,
              env: options.env,
            });
          } catch (err) {
            result = { ok: false, output: (err as Error).message, error: (err as Error).message };
          }
          result.durationMs = Date.now() - started;

          events.emit({ type: 'tool_result', toolCallId: call.id, name: call.name, ok: result.ok, output: result.output, sessionId });

          if (!result.ok) {
            await hooks.fire('ToolError', { runtime: options.runtime, sessionId, workspacePath: options.workspacePath, input: call, result, error: result.error });
          }
          await hooks.fire('AfterToolCall', { runtime: options.runtime, sessionId, workspacePath: options.workspacePath, input: call, result, meta: { name: call.name } });

          const toolMessage: ChatMessage = {
            role: 'tool',
            content: result.output.slice(0, 20_000),
            toolCallId: call.id,
            name: call.name,
          };
          history.push(toolMessage);
          allMessages.push(toolMessage);
          if (repository && sessionId) {
            await repository.appendMessage(sessionId, toolMessage);
            await repository.recordToolCall({ id: call.id, sessionId, toolCallId: call.id, name: call.name, input: call.arguments, result });
          }
        }
      }

      // Reached iteration limit.
      const summary = finalText || '(iteration limit reached without completion)';
      events.emit({ type: 'completion', summary, sessionId });
      await hooks.fire('AfterAgent', { runtime: options.runtime, sessionId, workspacePath: options.workspacePath, result: { summary, truncated: true } });
      return { summary, messages: allMessages, toolCalls: totalToolCalls, iterations: maxIterations, usage: lastUsage, ok: true };
    } catch (err) {
      const message = (err as Error).message;
      events.emit({ type: 'error', message, cause: err, sessionId });
      await hooks.fire('ToolError', { runtime: options.runtime, sessionId, workspacePath: options.workspacePath, error: err });
      await hooks.fire('AfterAgent', { runtime: options.runtime, sessionId, workspacePath: options.workspacePath, result: { error: message } });
      return { summary: `error: ${message}`, messages: allMessages, toolCalls: totalToolCalls, iterations: 0, usage: lastUsage, ok: false };
    }
  }
}
