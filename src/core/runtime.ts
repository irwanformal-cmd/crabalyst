import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AgentEventBus } from './event-emitter.js';
import { AgentLoop, type AgentRunOptions } from './agent-loop.js';
import { ContextManager } from './context-manager.js';
import { ConfigLoader, ensureAgentHome } from '../config/loader.js';
import { Database } from '../db/database.js';
import { SqliteSessionRepository, type SessionRepository } from '../sessions/repository.js';
import { SessionManager } from '../sessions/manager.js';
import { createProvider, ProviderRegistry } from '../providers/registry.js';
import { PermissionPolicy } from '../permissions/policy.js';
import { ToolRegistry, registerBuiltinTools } from '../tools/index.js';
import { HookEngine } from '../hooks/engine.js';
import { SkillManager } from '../skills/manager.js';
import { AgentManager } from '../agents/manager.js';
import { CommandRegistry, type CommandContext } from '../commands/registry.js';
import { PluginRegistry } from '../plugins/registry.js';
import { McpManager } from '../mcp/manager.js';
import { SubagentRunner } from '../agents/runner.js';
import { Logger } from '../logging/logger.js';
import { IntentEngine } from '../intelligence/intent.js';
import { createEntityRegistry, type EntityResolverRegistry } from '../intelligence/entities.js';
import { QueryUnderstanding } from '../intelligence/query.js';
import { AnalysisPlanner } from '../intelligence/planner.js';
import { AnalystRegistry, CORE_ANALYSTS } from '../intelligence/analysts.js';
import { createDataSourceRegistry, type DataSourceRegistry } from '../intelligence/datasources.js';
import { IntelligenceEngine } from '../intelligence/engine.js';
import type { AnalysisResult } from '../intelligence/types.js';
import type { EffectiveConfig } from '../types/config.js';
import type { Approver } from '../types/permissions.js';
import type { ProviderConfig } from '../types/provider.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface RuntimeOptions {
  homeDir?: string;
  projectDir?: string;
  dbPath?: string;
  approver?: Approver;
  logger?: Logger;
  loadPlugins?: boolean;
  /** Override the effective config (skips file/env loading). */
  config?: EffectiveConfig;
}

export interface RuntimeRunOptions {
  sessionId?: string;
  workspacePath?: string;
  providerId?: string;
  model?: string;
  signal?: AbortSignal;
  maxIterations?: number;
  /** Skip skill injection (conceptual Q&A must not inherit analysis skills). */
  skipSkills?: boolean;
  /** Force a brand-new session (conceptual Q&A must not see analysis history). */
  freshSession?: boolean;
}

/**
 * The assembled Agent Runtime. Owns all registries and is the single
 * programmatic API used by the CLI and (future) web gateway.
 */
export class AgentRuntime {
  readonly config: EffectiveConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly repository: SessionRepository;
  readonly sessions: SessionManager;
  readonly providers: ProviderRegistry;
  readonly policy: PermissionPolicy;
  readonly tools: ToolRegistry;
  readonly hooks: HookEngine;
  readonly skills: SkillManager;
  readonly agents: AgentManager;
  readonly commands: CommandRegistry;
  readonly plugins: PluginRegistry;
  readonly mcp: McpManager;
  readonly events: AgentEventBus;
  readonly contextManager: ContextManager;
  readonly loop: AgentLoop;
  readonly subagents: SubagentRunner;
  readonly loader: ConfigLoader;
  // Intelligence layer registries + engine.
  readonly intentEngine: IntentEngine;
  readonly entityResolvers: EntityResolverRegistry;
  readonly analystRegistry: AnalystRegistry;
  readonly dataSources: DataSourceRegistry;
  readonly planner: AnalysisPlanner;
  readonly intelligence: IntelligenceEngine;

  private workspacePath: string;
  private activeSessionId?: string;
  private shouldLoadPlugins: boolean;

  constructor(options: RuntimeOptions = {}) {
    this.shouldLoadPlugins = options.loadPlugins !== false;
    // Respect an injected config's homeDir so tests (and embedders) never
    // leak provider/plugin writes into the real ~/.agent.
    const homeDir = options.homeDir ?? options.config?.homeDir;
    this.loader = new ConfigLoader({ homeDir, projectDir: options.projectDir });
    this.config = options.config ?? this.loader.load(options.projectDir);
    this.workspacePath = resolve(this.config.workspace?.root ?? options.projectDir ?? process.cwd());

    this.logger = options.logger ?? new Logger();
    this.logger.configure(this.config.logging);

    this.db = new Database({ path: options.dbPath ?? join(this.loader.homeDir, 'agent.sqlite') });
    this.repository = new SqliteSessionRepository(this.db);
    this.sessions = new SessionManager(this.repository);

    this.providers = new ProviderRegistry();
    for (const cfg of this.config.providers) {
      this.providers.register(createProvider(cfg), cfg);
    }

    this.policy = new PermissionPolicy({
      allow: this.config.permissions?.allow ?? [],
      deny: this.config.permissions?.deny ?? [],
      approver: options.approver,
    });

    this.tools = new ToolRegistry(this.policy);
    registerBuiltinTools(this.tools);
    this.hooks = new HookEngine();
    this.skills = new SkillManager();
    this.agents = new AgentManager();
    this.commands = new CommandRegistry();
    this.mcp = new McpManager(this.tools);
    this.events = new AgentEventBus();

    // Intelligence layer: registries first so plugins can contribute to them.
    this.intentEngine = new IntentEngine();
    this.entityResolvers = createEntityRegistry();
    this.analystRegistry = new AnalystRegistry();
    for (const analyst of CORE_ANALYSTS) this.analystRegistry.register(analyst);
    this.dataSources = createDataSourceRegistry();
    const queryUnderstanding = new QueryUnderstanding({ intents: this.intentEngine, entities: this.entityResolvers });
    this.planner = new AnalysisPlanner({ analysts: this.analystRegistry, dataSources: this.dataSources });
    this.intelligence = new IntelligenceEngine({
      query: queryUnderstanding,
      planner: this.planner,
      analysts: this.analystRegistry,
      dataSources: this.dataSources,
      events: this.events,
      store: this.repository,
    });

    this.plugins = new PluginRegistry({
      tools: this.tools,
      skills: this.skills,
      agents: this.agents,
      commands: this.commands,
      hooks: this.hooks,
      mcp: this.mcp,
      intelligence: {
        intents: this.intentEngine,
        entities: this.entityResolvers,
        analysts: this.analystRegistry,
        dataSources: this.dataSources,
        planner: this.planner,
      },
    });

    const projectInstructions = this.loader.readProjectInstructions(options.projectDir);
    this.contextManager = new ContextManager({
      systemPrompt: this.config.agent?.systemPrompt,
      projectInstructions,
      maxContextTokens: this.providers.active().getCapabilities().maxContextTokens,
    });

    this.loop = new AgentLoop({
      provider: this.providers.active(),
      tools: this.tools,
      hooks: this.hooks,
      events: this.events,
      repository: this.repository,
      contextManager: this.contextManager,
    });

    this.subagents = new SubagentRunner({
      agents: this.agents,
      tools: this.tools,
      hooks: this.hooks,
      events: this.events,
      repository: this.repository,
      contextManager: this.contextManager,
      getProvider: (id) => {
        const p = id ? this.providers.get(id) : undefined;
        if (!p) throw new Error(`provider "${id}" not found`);
        return p;
      },
      parentProvider: this.providers.active(),
      parentModel: this.activeModel(),
    });

    this.registerBuiltinCommands();
  }

  /** Boot async resources: load plugins, start MCP servers. */
  async start(): Promise<void> {
    ensureAgentHome(this.loader.homeDir);
    if (this.shouldLoadPlugins) {
      await this.loadPlugins();
    }
    await this.startMcpServers();
  }

  async loadPlugins(): Promise<void> {
    const dirs = new Set<string>();
    dirs.add(join(PACKAGE_ROOT, 'plugins'));
    dirs.add(join(this.loader.homeDir, 'plugins'));
    for (const d of this.config.pluginDirs ?? []) dirs.add(resolve(d));
    for (const dir of dirs) {
      try {
        await this.plugins.loadFromDir(dir);
      } catch (err) {
        this.logger.warn(`failed to load plugins from ${dir}: ${(err as Error).message}`);
      }
    }
    this.logger.info(`loaded ${this.plugins.list().length} plugin(s)`, { provider: this.providers.activeIdOrUndefined() });
  }

  async startMcpServers(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.config.mcp ?? {})) {
      if (cfg.enabled === false) continue;
      try {
        await this.mcp.addServer(name, cfg, ['mcp']);
      } catch (err) {
        this.logger.warn(`failed to start MCP server "${name}": ${(err as Error).message}`);
      }
    }
  }

  get workspace(): string {
    return this.workspacePath;
  }

  setApprover(approver?: Approver): void {
    this.policy.setApprover(approver);
  }

  activeProviderId(): string {
    return this.providers.active().id;
  }

  activeModel(): string {
    return this.providers.config(this.providers.active().id)?.model ?? this.config.agent?.model ?? 'default';
  }

  /** Run a user instruction in a (new or existing) session. */
  async run(input: string, options: RuntimeRunOptions = {}): Promise<{ sessionId: string; summary: string; ok: boolean }> {
    const providerId = options.providerId ?? this.providers.active().id;
    const provider = this.providers.get(providerId) ?? this.providers.active();
    const model = options.model ?? this.providers.config(provider.id)?.model ?? this.config.agent?.model ?? 'default';
    const workspacePath = resolve(options.workspacePath ?? this.workspacePath);

    let sessionId = options.freshSession ? undefined : (options.sessionId ?? this.activeSessionId);
    if (sessionId) {
      const existing = await this.sessions.resume(sessionId);
      if (!existing) sessionId = undefined;
    }
    if (!sessionId) {
      const session = await this.sessions.create({
        title: input.slice(0, 60),
        workspacePath,
        providerId: provider.id,
        model,
        plugins: this.plugins.list().map((p) => p.id),
      });
      sessionId = session.id;
    }
    if (!options.freshSession) this.activeSessionId = sessionId;

    await this.hooks.fire('SessionStart', { sessionId, workspacePath, input });
    const started = Date.now();

    const selectedSkills = options.skipSkills ? [] : this.skills.select(input);
    const runOptions: AgentRunOptions = {
      sessionId,
      workspacePath,
      model,
      maxTokens: this.config.agent?.maxTokens,
      temperature: this.config.agent?.temperature,
      maxIterations: options.maxIterations ?? this.config.agent?.maxIterations,
      selectedSkills,
      runtime: this,
      signal: options.signal,
    };

    // Swap the loop's provider for this run without mutating shared state.
    const loop = new AgentLoop({
      provider,
      tools: this.tools,
      hooks: this.hooks,
      events: this.events,
      repository: this.repository,
      contextManager: this.contextManager,
    });
    const result = await loop.run(input, runOptions);

    await this.hooks.fire('SessionEnd', { sessionId, workspacePath, result });
    this.logger.info('agent run complete', {
      session_id: sessionId,
      provider: provider.id,
      model,
      latency_ms: Date.now() - started,
      tokens: result.usage,
    });

    return { sessionId, summary: result.summary, ok: result.ok };
  }

  /**
   * Analyze a natural-language question through the Intelligence Layer.
   * Produces a structured AnalysisResult (no raw LLM text parsing required).
   */
  async analyze(input: string, options: RuntimeRunOptions = {}): Promise<AnalysisResult> {
    const sessionId = options.sessionId ?? this.activeSessionId ?? (await this.createSession(input.slice(0, 60))).id;
    this.activeSessionId = sessionId;
    const workspacePath = resolve(options.workspacePath ?? this.workspacePath);
    return this.intelligence.analyze(input, { sessionId, workspacePath, runtime: this });
  }

  /** Dispatch a slash command or run the agent. */
  async dispatch(input: string, options: RuntimeRunOptions = {}): Promise<{ sessionId?: string; summary: string; ok: boolean }> {
    const parsed = this.commands.parse(input);
    if (parsed) {
      const output = await this.commands.run(parsed.name, parsed.args, {
        sessionId: this.activeSessionId,
        workspacePath: this.workspacePath,
        runtime: this,
      });
      return { summary: output, ok: true };
    }
    return this.run(input, options);
  }

  async shutdown(): Promise<void> {
    await this.mcp.stopAll();
    this.db.close();
  }

  // ---- provider management (CLI-facing) ----
  listProviders() {
    return this.providers.list();
  }

  async addProvider(cfg: ProviderConfig): Promise<void> {
    this.providers.register(createProvider(cfg), cfg);
    this.loader.writeProvider(cfg);
  }

  async removeProvider(id: string): Promise<void> {
    this.providers.unregister(id);
    const { rmSync, existsSync } = await import('node:fs');
    const path = join(this.loader.homeDir, 'providers', `${id}.yaml`);
    if (existsSync(path)) rmSync(path);
  }

  useProvider(id: string): void {
    this.providers.use(id);
    this.loader.setDefaultProvider(id);
  }

  // ---- session management (CLI-facing) ----
  listSessions() {
    return this.sessions.list();
  }

  createSession(title: string, workspacePath = this.workspacePath) {
    return this.sessions.create({
      title,
      workspacePath,
      providerId: this.providers.active().id,
      model: this.activeModel(),
      plugins: this.plugins.list().map((p) => p.id),
    });
  }

  resumeSession(id: string) {
    return this.sessions.resume(id);
  }

  deleteSession(id: string) {
    return this.sessions.delete(id);
  }

  /** Register built-in slash commands. */
  private registerBuiltinCommands(): void {
    const runtime = this;
    const listPlugins = () => {
      const plugins = runtime.plugins.list();
      if (!plugins.length) return 'no plugins loaded';
      return plugins.map((p) => `${p.id}@${p.manifest.version} — ${p.manifest.description}`).join('\n');
    };
    const listProviders = () =>
      runtime.providers
        .list()
        .map((p) => `${p.active ? '* ' : '  '}${p.id} (${p.model})`)
        .join('\n');
    const listAgents = () => {
      const agents = runtime.agents.list();
      if (!agents.length) return 'no agents registered';
      return agents.map((a) => `${a.name} — ${a.description}`).join('\n');
    };
    const listSkills = () => {
      const skills = runtime.skills.list();
      if (!skills.length) return 'no skills registered';
      return skills.map((s) => `${s.name} — ${s.purpose}`).join('\n');
    };

    this.commands.register({ name: 'plugins', description: 'List loaded plugins', handler: () => listPlugins() });
    this.commands.register({ name: 'providers', description: 'List providers', handler: () => listProviders() });
    this.commands.register({ name: 'agents', description: 'List subagents', handler: () => listAgents() });
    this.commands.register({ name: 'skills', description: 'List skills', handler: () => listSkills() });
    this.commands.register({ name: 'sessions', description: 'List sessions', handler: async () => {
      const list = await runtime.sessions.list();
      if (!list.length) return 'no sessions';
      return list.map((s) => `${s.id}  ${s.title}  (${s.providerId}/${s.model})`).join('\n');
    } });
    this.commands.register({ name: 'tools', description: 'List tools', handler: () =>
      runtime.tools.list().map((t) => `${t.name} — ${t.description}`).join('\n') });
    this.commands.register({ name: 'help', description: 'Show help', handler: () =>
      runtime.commands.list().map((c) => `/${c.name.padEnd(12)} ${c.description}`).join('\n') });
  }
}

export function commandContext(runtime: AgentRuntime): CommandContext {
  return { workspacePath: runtime.workspace, runtime };
}
