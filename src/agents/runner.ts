import { AgentLoop, type AgentLoopDeps, type AgentRunOptions } from '../core/agent-loop.js';
import type { ContextManager } from '../core/context-manager.js';
import type { LLMProvider } from '../types/provider.js';
import type { AgentDefinition } from '../types/skill.js';
import type { AgentManager } from './manager.js';

export interface SubagentRunnerDeps {
  agents: AgentManager;
  tools: AgentLoopDeps['tools'];
  hooks: AgentLoopDeps['hooks'];
  events: AgentLoopDeps['events'];
  repository: AgentLoopDeps['repository'];
  contextManager: ContextManager;
  /** Resolve a provider by id; defaults to the parent provider. */
  getProvider: (id?: string) => LLMProvider;
  parentProvider: LLMProvider;
  parentModel?: string;
}

export interface SubagentResult {
  id: string;
  name: string;
  ok: boolean;
  result: string;
  provider: string;
  model: string;
}

/**
 * Runs isolated subagents with separate context, tool restrictions, and
 * optional provider/model overrides.
 */
export class SubagentRunner {
  constructor(private deps: SubagentRunnerDeps) {}

  async run(name: string, task: string, opts: { sessionId?: string; workspacePath: string; signal?: AbortSignal }): Promise<SubagentResult> {
    const def = this.deps.agents.get(name);
    if (!def) {
      return { id: '', name, ok: false, result: `subagent "${name}" not found`, provider: '', model: '' };
    }

    const provider = def.provider ? this.deps.getProvider(def.provider) : this.deps.parentProvider;
    const model = def.model ?? this.deps.parentModel ?? 'default';

    this.deps.events.emit({ type: 'subagent_start', id: name, name, sessionId: opts.sessionId });

    const loop = new AgentLoop({
      provider,
      tools: this.deps.tools,
      hooks: this.deps.hooks,
      events: this.deps.events,
      repository: this.deps.repository,
      contextManager: this.deps.contextManager,
    });

    const allowTools = def.tools.length ? new Set(def.tools) : undefined;
    const runOptions: AgentRunOptions = {
      sessionId: opts.sessionId,
      workspacePath: opts.workspacePath,
      model,
      maxTokens: def.maxTokens,
      maxIterations: def.maxIterations ?? 10,
      toolsFilter: allowTools ? (t) => allowTools.has(t) : undefined,
      signal: opts.signal,
      systemExtra: [`You are the "${def.name}" subagent. ${def.systemPrompt}`],
    };

    const result = await loop.run(task, runOptions);
    this.deps.events.emit({ type: 'subagent_result', id: name, name, ok: result.ok, result: result.summary, sessionId: opts.sessionId });

    return {
      id: name,
      name,
      ok: result.ok,
      result: result.summary,
      provider: provider.id,
      model,
    };
  }
}
