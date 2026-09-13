import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '../types/config.js';
import type { Tool } from '../types/tool.js';

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Minimal Model Context Protocol (MCP) client over stdio. Registers external
 * MCP servers' tools into the platform tool registry. No server is hard-coded.
 */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 0;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private started = false;

  constructor(readonly name: string, private config: McpServerConfig) {}

  async start(): Promise<void> {
    if (this.started) return;
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    child.stderr.on('data', () => {
      /* stderr is server logs; not protocol traffic */
    });
    child.on('exit', (code) => {
      const err = new Error(`MCP server "${this.name}" exited with code ${code}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.started = false;
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-platform', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
    this.started = false;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.request('tools/list', {})) as { tools?: McpToolInfo[]; result?: { tools?: McpToolInfo[] } };
    const tools = res.tools ?? res.result?.tools ?? [];
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string; data?: unknown }> {
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    return {
      ok: !res.isError,
      output: text || JSON.stringify(res.structuredContent ?? {}),
      data: res.structuredContent,
    };
  }

  /** Wrap an MCP tool as a platform Tool. */
  toPlatformTool(info: McpToolInfo, permissions: string[]): Tool {
    const client = this;
    return {
      name: info.name,
      description: info.description ?? `MCP tool "${info.name}" from server "${this.name}"`,
      inputSchema: (info.inputSchema as Tool['inputSchema']) ?? { type: 'object', properties: {} },
      permissions,
      execute: async (input) => client.callTool(info.name, input),
    };
  }

  private notify(method: string, params: unknown): void {
    const msg = { jsonrpc: '2.0', method, params };
    this.child?.stdin.write(JSON.stringify(msg) + '\n');
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request "${method}" timed out`));
        }
      }, 30_000);
      const origResolve = resolve;
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          origResolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    this.child?.stdin.write(JSON.stringify(msg) + '\n');
    return promise;
  }

  private onData(data: string): void {
    this.buffer += data;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (msg.id === undefined) continue; // notification/response without id
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
}

export function createMcpClient(name: string, config: McpServerConfig): McpClient {
  return new McpClient(name, config);
}

export { randomUUID };
