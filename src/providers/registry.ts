import type { LLMProvider, ProviderConfig } from '../types/provider.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/** Build a provider instance from its configuration. */
export function createProvider(cfg: ProviderConfig): LLMProvider {
  switch (cfg.kind) {
    case 'mock':
      return new MockProvider(cfg.name, cfg.options);
    case 'openai-compatible':
      return new OpenAICompatibleProvider(cfg);
    case 'anthropic':
      return new AnthropicProvider(cfg);
    default:
      throw new Error(
        `unknown provider kind "${cfg.kind}" for "${cfg.name}". Supported kinds: mock, openai-compatible, anthropic`,
      );
  }
}

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private configs = new Map<string, ProviderConfig>();
  private activeId?: string;

  register(provider: LLMProvider, config: ProviderConfig): void {
    this.providers.set(provider.id, provider);
    this.configs.set(provider.id, config);
    if (!this.activeId || config.default) this.activeId = provider.id;
  }

  unregister(id: string): boolean {
    this.providers.delete(id);
    this.configs.delete(id);
    if (this.activeId === id) this.activeId = undefined;
    return true;
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /** Resolve the active provider, falling back to the configured default. */
  active(): LLMProvider {
    const id = this.activeId ?? this.configs.keys().next().value as string | undefined;
    if (!id) throw new Error('no provider registered');
    const p = this.providers.get(id);
    if (!p) throw new Error(`active provider "${id}" not found`);
    return p;
  }

  activeIdOrUndefined(): string | undefined {
    return this.activeId;
  }

  /** Switch the active provider without touching plugins or agent logic. */
  use(id: string): void {
    if (!this.providers.has(id)) throw new Error(`provider "${id}" is not registered`);
    this.activeId = id;
    // Update default flags so the switch persists.
    for (const [name, cfg] of this.configs) {
      cfg.default = name === id;
    }
  }

  list(): Array<{ id: string; label: string; model: string; active: boolean }> {
    return [...this.configs.entries()].map(([id, cfg]) => ({
      id,
      label: this.providers.get(id)?.label ?? id,
      model: cfg.model,
      active: id === this.activeId,
    }));
  }

  config(id: string): ProviderConfig | undefined {
    return this.configs.get(id);
  }

  get size(): number {
    return this.providers.size;
  }
}
