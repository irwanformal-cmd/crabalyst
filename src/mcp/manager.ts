import type { McpServerConfig } from '../types/config.js';
import type { ToolRegistry } from '../tools/registry.js';
import { McpClient } from './client.js';

export class McpManager {
  private clients = new Map<string, McpClient>();

  constructor(private tools: ToolRegistry) {}

  async addServer(name: string, config: McpServerConfig, permissions: string[]): Promise<void> {
    if (this.clients.has(name)) throw new Error(`MCP server "${name}" already registered`);
    const client = new McpClient(name, config);
    await client.start();
    const infos = await client.listTools();
    for (const info of infos) {
      this.tools.upsert(client.toPlatformTool(info, permissions));
    }
    this.clients.set(name, client);
  }

  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;
    await client.stop();
    this.clients.delete(name);
  }

  list(): string[] {
    return [...this.clients.keys()];
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
  }
}
