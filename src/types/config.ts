import type { ProviderConfig } from './provider.js';
import type { Permission } from './permissions.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Auto-start when the runtime boots. */
  enabled?: boolean;
}

export interface AgentConfig {
  /** Default model. */
  model?: string;
  /** Default max output tokens. */
  maxTokens?: number;
  /** Default temperature. */
  temperature?: number;
  /** Max tool-call iterations in a single agent turn. */
  maxIterations?: number;
  /** Global system prompt appended to every agent. */
  systemPrompt?: string;
}

export interface RuntimeConfig {
  /** Active provider name. */
  provider?: string;
  agent?: AgentConfig;
  providers: ProviderConfig[];
  /** Map of MCP server name -> config. */
  mcp?: Record<string, McpServerConfig>;
  /** Pre-granted permissions. */
  permissions?: {
    allow: Permission[];
    deny: Permission[];
  };
  /** Plugin names to load. */
  plugins?: string[];
  /** Extra plugin directories to search. */
  pluginDirs?: string[];
  /** Logging configuration. */
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    dir?: string;
    redact?: string[];
  };
  workspace?: {
    root?: string;
  };
  [key: string]: unknown;
}

/** Fully merged, effective configuration after hierarchy resolution. */
export interface EffectiveConfig extends RuntimeConfig {
  /** Resolution precedence order, for diagnostics. */
  sources: string[];
  /** Absolute path of the agent home directory. */
  homeDir: string;
  /** Absolute path of the project directory (if any). */
  projectDir?: string;
}

export const CONFIG_PRECEDENCE = [
  'defaults',
  'global (~/.agent/config.yaml)',
  'project (./AGENT.md / .agent/config.yaml)',
  'plugin',
  'agent override',
  'session',
] as const;
