import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import type { EffectiveConfig, RuntimeConfig } from '../types/config.js';
import type { ProviderConfig } from '../types/provider.js';

export const AGENT_HOME = process.env.AGENT_HOME ?? join(homedir(), '.agent');

const DEFAULT_CONFIG: RuntimeConfig = {
  providers: [
    {
      name: 'mock',
      kind: 'mock',
      model: 'mock-1',
      options: { script: 'echo' },
    },
  ],
  agent: {
    model: 'mock-1',
    maxTokens: 4096,
    temperature: 0,
    maxIterations: 25,
  },
  permissions: {
    allow: ['filesystem.read', 'git.read', 'network', 'http.request', 'browser'],
    deny: [],
  },
  plugins: [],
  pluginDirs: [],
  logging: { level: 'info', dir: join(AGENT_HOME, 'logs') },
  mcp: {},
};

/** Deterministic deep-merge where later sources win (arrays replaced, objects merged). */
function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, val] of Object.entries(override)) {
    if (val === undefined) continue;
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(val)) {
      out[key] = deepMerge(existing as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ConfigLoadOptions {
  /** Explicit home dir override (defaults to AGENT_HOME). */
  homeDir?: string;
  /** Project directory (defaults to cwd). */
  projectDir?: string;
}

/** Parse YAML/JSON text; returns {} on empty input. */
export function parseConfigText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  return parse(trimmed);
}

export function parseProviderConfig(text: string): ProviderConfig {
  const raw = parseConfigText(text) as Record<string, unknown>;
  return normalizeProviderConfig(raw);
}

export function normalizeProviderConfig(raw: Record<string, unknown>): ProviderConfig {
  if (!raw.name || typeof raw.name !== 'string') throw new Error('provider config requires a `name`');
  if (!raw.kind || typeof raw.kind !== 'string') throw new Error(`provider "${raw.name}" requires a \`kind\``);
  if (!raw.model || typeof raw.model !== 'string') throw new Error(`provider "${raw.name}" requires a \`model\``);
  return {
    name: raw.name as string,
    kind: raw.kind as ProviderConfig['kind'],
    base_url: typeof raw.base_url === 'string' ? raw.base_url : undefined,
    api_key_env: typeof raw.api_key_env === 'string' ? raw.api_key_env : undefined,
    api_key: typeof raw.api_key === 'string' ? raw.api_key : undefined,
    model: raw.model as string,
    options: isPlainObject(raw.options) ? raw.options : undefined,
    default: raw.default === true,
  };
}

export class ConfigLoader {
  readonly homeDir: string;

  constructor(options?: ConfigLoadOptions) {
    this.homeDir = resolve(options?.homeDir ?? AGENT_HOME);
  }

  /** Load and merge the full configuration hierarchy. */
  load(projectDir?: string): EffectiveConfig {
    const sources: string[] = ['defaults'];
    let cfg: RuntimeConfig = structuredClone(DEFAULT_CONFIG);

    const globalPath = join(this.homeDir, 'config.yaml');
    if (existsSync(globalPath)) {
      sources.push(globalPath);
      cfg = deepMerge(cfg, this.readConfigFile(globalPath));
    }

    const proj = projectDir ? resolve(projectDir) : process.cwd();
    const projectConfigPath = join(proj, '.agent', 'config.yaml');
    if (existsSync(projectConfigPath)) {
      sources.push(projectConfigPath);
      cfg = deepMerge(cfg, this.readConfigFile(projectConfigPath));
    }

    // Merge providers stored in ~/.agent/providers/*.yaml (managed via
    // `agent provider add`). Files are an additional provider source so the
    // CLI-persisted providers survive restarts.
    const providerFiles = this.listProviders();
    if (providerFiles.length > 0) {
      for (const pc of providerFiles) {
        if (!cfg.providers.some((p) => p.name === pc.name)) {
          cfg.providers.push(pc);
        } else if (pc.default) {
          cfg.providers = cfg.providers.map((p) => (p.name === pc.name ? { ...p, default: true } : { ...p, default: false }));
        }
      }
      sources.push(`${this.homeDir}/providers/*.yaml`);
    }

    // Environment overrides take precedence over files.
    const envCfg = this.readEnvOverrides();
    if (Object.keys(envCfg).length > 0) {
      sources.push('environment');
      cfg = deepMerge(cfg, envCfg);
    }

    return { ...cfg, sources, homeDir: this.homeDir, projectDir: proj };
  }

  /** Read AGENT.md (project instructions) if present. */
  readProjectInstructions(projectDir?: string): string | undefined {
    const proj = projectDir ? resolve(projectDir) : process.cwd();
    const p = join(proj, 'AGENT.md');
    if (existsSync(p)) return readFileSync(p, 'utf8');
    return undefined;
  }

  writeProvider(provider: ProviderConfig): string {
    const path = join(this.homeDir, 'providers', `${provider.name}.yaml`);
    mkdirSync(join(this.homeDir, 'providers'), { recursive: true });
    writeFileSync(path, stringify(provider), 'utf8');
    return path;
  }

  readProvider(name: string): ProviderConfig | undefined {
    const path = join(this.homeDir, 'providers', `${name}.yaml`);
    if (!existsSync(path)) return undefined;
    const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return normalizeProviderConfig(raw);
  }

  listProviders(): ProviderConfig[] {
    const dir = join(this.homeDir, 'providers');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => {
        try {
          return normalizeProviderConfig(parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
        } catch {
          return undefined;
        }
      })
      .filter((p): p is ProviderConfig => p !== undefined);
  }

  /** Persist the active provider by rewriting `default` flags in provider files. */
  setDefaultProvider(name: string): void {
    for (const p of this.listProviders()) {
      const next = { ...p, default: p.name === name };
      this.writeProvider(next);
    }
  }

  private readConfigFile(path: string): Partial<RuntimeConfig> {
    const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return this.validateConfig(raw, path);
  }

  private validateConfig(raw: unknown, path: string): Partial<RuntimeConfig> {
    if (raw === null || raw === undefined) return {};
    if (!isPlainObject(raw)) throw new Error(`config at ${path} must be a mapping`);
    const out: Partial<RuntimeConfig> = {};
    if (Array.isArray(raw.providers)) {
      out.providers = (raw.providers as Record<string, unknown>[]).map(normalizeProviderConfig);
    }
    if (isPlainObject(raw.agent)) out.agent = raw.agent as RuntimeConfig['agent'];
    if (isPlainObject(raw.mcp)) out.mcp = raw.mcp as RuntimeConfig['mcp'];
    if (isPlainObject(raw.permissions)) out.permissions = raw.permissions as RuntimeConfig['permissions'];
    if (Array.isArray(raw.plugins)) out.plugins = raw.plugins as string[];
    if (Array.isArray(raw.pluginDirs)) out.pluginDirs = raw.pluginDirs as string[];
    if (isPlainObject(raw.logging)) out.logging = raw.logging as RuntimeConfig['logging'];
    if (isPlainObject(raw.workspace)) out.workspace = raw.workspace as RuntimeConfig['workspace'];
    // Preserve unknown keys for forward-compatibility.
    for (const [k, v] of Object.entries(raw)) {
      if (!(k in out)) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }

  private readEnvOverrides(): Partial<RuntimeConfig> {
    const out: Partial<RuntimeConfig> = {};
    if (process.env.AGENT_PROVIDER) out.provider = process.env.AGENT_PROVIDER;
    if (process.env.AGENT_MODEL) {
      out.agent = { model: process.env.AGENT_MODEL };
    }
    if (process.env.AGENT_WORKSPACE) out.workspace = { root: process.env.AGENT_WORKSPACE };
    return out;
  }
}

/** Ensure the agent home directory tree exists. */
export function ensureAgentHome(homeDir: string = AGENT_HOME): void {
  for (const sub of ['providers', 'plugins', 'skills', 'agents', 'sessions', 'logs']) {
    mkdirSync(join(homeDir, sub), { recursive: true });
  }
}
