import type { AgentDefinition } from '../types/skill.js';
import { loadAgentsFromDir } from './loader.js';

export class AgentManager {
  private agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): void {
    this.agents.set(agent.name, agent);
  }

  registerAll(agents: AgentDefinition[]): void {
    for (const a of agents) this.agents.set(a.name, a);
  }

  unregister(name: string): boolean {
    return this.agents.delete(name);
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  loadDir(dir: string, opts?: { pluginId?: string; onlyNames?: string[] }): void {
    this.registerAll(loadAgentsFromDir(dir, opts));
  }
}
