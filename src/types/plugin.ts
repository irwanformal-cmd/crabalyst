import type { Permission } from './permissions.js';

/** Deserialized plugin manifest (manifest.yaml). */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: Permission[];
  /** Tool definitions provided by the plugin. */
  tools?: PluginToolDeclaration[];
  /** Skill names provided by the plugin. */
  skills?: string[];
  /** Agent (subagent) names provided by the plugin. */
  agents?: string[];
  /** Slash-command names provided by the plugin. */
  commands?: string[];
  /** Hook names provided by the plugin. */
  hooks?: string[];
  /** MCP server names provided by the plugin. */
  mcp?: string[];
  /** Optional JS/TS entry module exporting a PluginModule. */
  entry?: string;
  /** Extra manifest fields. */
  [key: string]: unknown;
}

/** Declarative tool: implemented by the plugin entry module under `tools.<name>`. */
export interface PluginToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permissions?: Permission[];
}

/** Intelligence-layer contributions a plugin can register. */
export interface PluginIntelligence {
  /** Additional intent definitions or keyword extensions. */
  intents?: Array<import('../intelligence/intent.js').IntentDefinition>;
  /** Entity resolvers (e.g. symbol/company synonym tables). */
  entityResolvers?: Array<import('../intelligence/entities.js').EntityResolver>;
  /** Specialist analysts. */
  analysts?: Array<import('../intelligence/types.js').Analyst>;
  /** Domain data sources. */
  dataSources?: Array<import('../intelligence/types.js').DataSource>;
  /** Workflow routing rules. */
  workflows?: Array<import('../intelligence/planner.js').WorkflowRule>;
}

/** What a plugin entry module exports. */
export interface PluginModule {
  /** Tool implementations keyed by name. */
  tools?: Record<string, PluginTool>;
  /** Hook implementations keyed by name. */
  hooks?: Record<string, PluginHook>;
  /** Slash-command implementations keyed by name. */
  commands?: Record<string, (args: string, context: unknown) => Promise<string> | string>;
  /** Intelligence-layer contributions (analysts, data sources, resolvers, …). */
  intelligence?: PluginIntelligence;
  /** Additional manifest data merged into the loaded manifest. */
  manifest?: Partial<PluginManifest>;
}

export type PluginTool = {
  description: string;
  inputSchema: Record<string, unknown>;
  permissions?: Permission[];
  execute(input: Record<string, unknown>, context: unknown): Promise<{ ok: boolean; output: string; data?: unknown; error?: string }>;
};

export type PluginHookContext = {
  sessionId?: string;
  workspacePath: string;
  input?: unknown;
  result?: unknown;
  [key: string]: unknown;
};

export type PluginHook = (context: PluginHookContext) => Promise<void> | void;

export interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  /** Absolute plugin directory. */
  path: string;
  module?: PluginModule;
}
