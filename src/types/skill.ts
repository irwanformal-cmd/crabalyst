import type { Permission } from './permissions.js';

/** A named skill/playbook that can be injected into agent context. */
export interface Skill {
  name: string;
  description: string;
  /** Purpose statement (used for relevance matching). */
  purpose: string;
  /** Full instructions/playbook content. */
  instructions: string;
  constraints: string[];
  requiredTools: string[];
  workflow: string[];
  outputFormat?: string;
  /** Optional trigger words for automatic selection. */
  triggers?: string[];
  /** Source plugin id, when the skill comes from a plugin. */
  pluginId?: string;
  /** Absolute path to the skill directory. */
  path?: string;
}

/** A subagent definition (Markdown + optional frontmatter). */
export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool names allowed for this agent. Empty = inherit all. */
  tools: string[];
  /** Provider override. Empty = inherit parent. */
  provider?: string;
  /** Model override. Empty = inherit parent. */
  model?: string;
  /** Maximum output tokens budget. */
  maxTokens?: number;
  /** Maximum tool-call iterations. */
  maxIterations?: number;
  pluginId?: string;
  path?: string;
}
