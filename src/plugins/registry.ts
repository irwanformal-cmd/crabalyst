import type { AgentManager } from '../agents/manager.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { HookEngine } from '../hooks/engine.js';
import type { McpManager } from '../mcp/manager.js';
import type { SkillManager } from '../skills/manager.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { LoadedPlugin, PluginTool } from '../types/plugin.js';
import type { Tool } from '../types/tool.js';
import type { IntentEngine } from '../intelligence/intent.js';
import type { EntityResolverRegistry } from '../intelligence/entities.js';
import type { AnalystRegistry } from '../intelligence/analysts.js';
import type { DataSourceRegistry } from '../intelligence/datasources.js';
import type { AnalysisPlanner } from '../intelligence/planner.js';
import { discoverPluginDirs, loadPlugin } from './loader.js';

export interface PluginRegistryDeps {
  tools: ToolRegistry;
  skills: SkillManager;
  agents: AgentManager;
  commands: CommandRegistry;
  hooks: HookEngine;
  mcp?: McpManager;
  intelligence?: {
    intents: IntentEngine;
    entities: EntityResolverRegistry;
    analysts: AnalystRegistry;
    dataSources: DataSourceRegistry;
    planner: AnalysisPlanner;
  };
}

/**
 * Loads plugins and wires their declared capabilities into the platform
 * registries. Plugins never touch core internals directly.
 */
export class PluginRegistry {
  private loaded = new Map<string, LoadedPlugin>();

  constructor(private deps: PluginRegistryDeps) {}

  async loadFromDir(dir: string): Promise<LoadedPlugin[]> {
    const results: LoadedPlugin[] = [];
    for (const pluginDir of discoverPluginDirs(dir)) {
      results.push(await this.load(pluginDir));
    }
    return results;
  }

  async load(dir: string): Promise<LoadedPlugin> {
    const plugin = await loadPlugin(dir);
    if (this.loaded.has(plugin.id)) {
      await this.unload(plugin.id);
    }
    this.loaded.set(plugin.id, plugin);
    this.wire(plugin);
    return plugin;
  }

  async unload(id: string): Promise<boolean> {
    const plugin = this.loaded.get(id);
    if (!plugin) return false;
    // Unregister tools
    for (const decl of plugin.manifest.tools ?? []) {
      this.deps.tools.unregister(decl.name);
    }
    if (plugin.module?.tools) {
      for (const name of Object.keys(plugin.module.tools)) {
        this.deps.tools.unregister(name);
      }
    }
    // Unregister skills/agents/commands/hooks by pluginId
    for (const s of this.deps.skills.list().filter((s) => s.pluginId === id)) this.deps.skills.unregister(s.name);
    for (const a of this.deps.agents.list().filter((a) => a.pluginId === id)) this.deps.agents.unregister(a.name);
    for (const c of this.deps.commands.list().filter((c) => c.pluginId === id)) this.deps.commands.unregister(c.name);
    for (const h of this.deps.hooks.list().filter((h) => h.pluginId === id)) this.deps.hooks.unregister(h.name);
    // Intelligence-layer contributions.
    const intel = plugin.module?.intelligence;
    if (intel && this.deps.intelligence) {
      for (const a of intel.analysts ?? []) this.deps.intelligence.analysts.unregister(a.id);
      for (const s of intel.dataSources ?? []) this.deps.intelligence.dataSources.unregister(s.id);
      for (const r of intel.entityResolvers ?? []) this.deps.intelligence.entities.unregister(r.id);
    }
    this.loaded.delete(id);
    return true;
  }

  list(): LoadedPlugin[] {
    return [...this.loaded.values()];
  }

  get(id: string): LoadedPlugin | undefined {
    return this.loaded.get(id);
  }

  private wire(plugin: LoadedPlugin): void {
    const id = plugin.id;
    // Skills
    if (plugin.manifest.skills?.length) {
      this.deps.skills.loadDir(`${plugin.path}/skills`, { pluginId: id, onlyNames: plugin.manifest.skills });
    } else {
      this.deps.skills.loadDir(`${plugin.path}/skills`, { pluginId: id });
    }

    // Agents
    if (plugin.manifest.agents?.length) {
      this.deps.agents.loadDir(`${plugin.path}/agents`, { pluginId: id, onlyNames: plugin.manifest.agents });
    } else {
      this.deps.agents.loadDir(`${plugin.path}/agents`, { pluginId: id });
    }

    // Commands: manifest advertises names; implementations come from entry module.
    const commandImpls = (plugin.module as { commands?: Record<string, (args: string, ctx: unknown) => Promise<string> | string> } | undefined)?.commands;
    for (const name of plugin.manifest.commands ?? []) {
      const impl = commandImpls?.[name];
      if (!impl) {
        // Declarative command with no implementation: still list it, but running fails clearly.
        this.deps.commands.register({
          name,
          description: `plugin command "${name}" (no handler implemented)`,
          pluginId: id,
          handler: () => `command /${name} has no handler in plugin "${id}"`,
        });
        continue;
      }
      this.deps.commands.register({
        name,
        description: `plugin command "${name}"`,
        pluginId: id,
        handler: (args, ctx) => impl(args, ctx),
      });
    }

    // Hooks
    const hookImpls = (plugin.module as { hooks?: Record<string, (ctx: unknown) => Promise<void> | void> } | undefined)?.hooks;
    for (const name of plugin.manifest.hooks ?? []) {
      const impl = hookImpls?.[name];
      if (!impl) continue;
      // Hook names may encode the point (e.g. "prediction-log" -> AfterToolCall via a
      // conventional prefix); default to AfterToolCall unless the name maps to a known point.
      const point = resolveHookPoint(name);
      this.deps.hooks.register({ name: `${id}:${name}`, point, pluginId: id, run: (ctx) => impl(ctx) });
    }

    // Intelligence-layer contributions (analysts, data sources, resolvers, workflows).
    const intel = plugin.module?.intelligence;
    if (intel && this.deps.intelligence) {
      for (const def of intel.intents ?? []) this.deps.intelligence.intents.register(def);
      for (const resolver of intel.entityResolvers ?? []) this.deps.intelligence.entities.register(resolver);
      for (const analyst of intel.analysts ?? []) {
        this.deps.intelligence.analysts.register({ ...analyst, pluginId: analyst.pluginId ?? id });
      }
      for (const source of intel.dataSources ?? []) {
        this.deps.intelligence.dataSources.register({ ...source, pluginId: source.pluginId ?? id });
      }
      for (const wf of intel.workflows ?? []) this.deps.intelligence.planner.registerWorkflow(wf);
    }

    // Tools
    const toolImpls = (plugin.module as { tools?: Record<string, PluginTool> } | undefined)?.tools;
    for (const decl of plugin.manifest.tools ?? []) {
      const impl = toolImpls?.[decl.name];
      const tool: Tool = {
        name: decl.name,
        description: impl?.description ?? decl.description,
        inputSchema: (impl?.inputSchema ?? decl.parameters ?? { type: 'object', properties: {} }) as Tool['inputSchema'],
        permissions: impl?.permissions ?? decl.permissions ?? [],
        execute: async (input, ctx) => {
          if (!impl) return { ok: false, output: `tool "${decl.name}" has no implementation in plugin "${id}"`, error: 'not implemented' };
          return impl.execute(input, ctx);
        },
      };
      this.deps.tools.upsert(tool);
    }
    // Extra tools exported by entry module but not in manifest.
    if (toolImpls) {
      const declared = new Set((plugin.manifest.tools ?? []).map((t) => t.name));
      for (const [name, impl] of Object.entries(toolImpls)) {
        if (declared.has(name)) continue;
        this.deps.tools.upsert({
          name,
          description: impl.description,
          inputSchema: (impl.inputSchema ?? { type: 'object', properties: {} }) as Tool['inputSchema'],
          permissions: impl.permissions ?? [],
          execute: (input, ctx) => impl.execute(input, ctx),
        });
      }
    }
  }
}

const KNOWN_HOOK_POINTS = new Set([
  'BeforeAgent', 'AfterAgent', 'BeforeToolCall', 'AfterToolCall', 'ToolError',
  'BeforeCommand', 'AfterCommand', 'SessionStart', 'SessionEnd',
]);

function resolveHookPoint(name: string): import('../types/hook.js').HookPoint {
  for (const p of KNOWN_HOOK_POINTS) {
    if (name.toLowerCase().includes(p.toLowerCase())) return p as import('../types/hook.js').HookPoint;
  }
  return 'AfterToolCall';
}
