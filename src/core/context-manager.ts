import type { ChatMessage, ToolDefinition } from '../types/provider.js';
import type { Skill } from '../types/skill.js';

export interface ContextManagerOptions {
  systemPrompt?: string;
  projectInstructions?: string;
  maxContextTokens?: number;
}

/** Rough heuristic: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 8, 0);
}

/**
 * Builds the effective system prompt (base + project + skills) and trims
 * history to stay within the provider's context budget.
 */
export class ContextManager {
  private options: ContextManagerOptions;

  constructor(options: ContextManagerOptions = {}) {
    this.options = options;
  }

  buildSystemPrompt(selectedSkills: Skill[] = [], extra?: string[]): string {
    const parts: string[] = [];
    if (this.options.systemPrompt) parts.push(this.options.systemPrompt);
    if (this.options.projectInstructions) {
      parts.push(`# Project instructions (AGENT.md)\n${this.options.projectInstructions}`);
    }
    for (const s of extra ?? []) parts.push(s);
    if (selectedSkills.length) {
      parts.push(this.renderSkills(selectedSkills));
    }
    return parts.join('\n\n');
  }

  private renderSkills(skills: Skill[]): string {
    const blocks = skills.map((s) => {
      const lines = [`## Skill: ${s.name}`, `Purpose: ${s.purpose}`];
      if (s.constraints.length) lines.push(`Constraints:\n${s.constraints.map((c) => `- ${c}`).join('\n')}`);
      if (s.requiredTools.length) lines.push(`Required tools: ${s.requiredTools.join(', ')}`);
      if (s.workflow.length) lines.push(`Workflow:\n${s.workflow.join('\n')}`);
      if (s.outputFormat) lines.push(`Output format: ${s.outputFormat}`);
      lines.push(s.instructions);
      return lines.join('\n');
    });
    return `<skills>\n${blocks.join('\n\n')}\n</skills>`;
  }

  /**
   * Trim history to fit the context budget, always preserving the system
   * prompt (handled separately) and the most recent messages. Returns the
   * trimmed list (does not mutate the input).
   */
  trim(messages: ChatMessage[], budgetTokens = this.options.maxContextTokens ?? 64_000): ChatMessage[] {
    const systemTokens = estimateTokens(this.options.systemPrompt ?? '') + estimateTokens(this.options.projectInstructions ?? '');
    const available = Math.max(budgetTokens - systemTokens - 1024, 256);
    const reversed: ChatMessage[] = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      const cost = estimateTokens(m.content) + (m.toolCalls ? 256 : 0);
      if (used + cost > available && reversed.length > 0) break;
      reversed.push(m);
      used += cost;
    }
    return reversed.reverse();
  }

  /** Build tool schemas for the model, capping tool count to a sane default. */
  static buildToolSchemas(tools: ToolDefinition[], maxTools = 128): ToolDefinition[] {
    return tools.slice(0, maxTools);
  }
}
