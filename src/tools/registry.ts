import type { JSONSchema, ToolDefinition } from '../types/provider.js';
import type { Tool, ToolContext, ToolResult, ToolRuntime } from '../types/tool.js';
import type { PermissionPolicy } from '../permissions/policy.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(private policy: PermissionPolicy) {}

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Replace an existing tool (idempotent re-registration for hot reloads). */
  upsert(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolRuntime[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      permissions: t.permissions,
    }));
  }

  /** The schema shape the model sees — implementation details are hidden. */
  listSchemas(): ToolDefinition[] {
    return this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: normalizeSchema(t.inputSchema),
      },
    }));
  }

  /** Execute a tool with permission enforcement. */
  async execute(name: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, output: `tool "${name}" not found`, error: `unknown tool: ${name}` };

    const decision = await this.policy.check(tool.permissions, {
      description: `tool "${name}" requires ${tool.permissions.join(', ') || 'no permissions'}`,
      toolName: name,
      input,
      sessionId: context.sessionId,
    });
    if (!decision.allowed) {
      return { ok: false, output: `permission denied for tool "${name}": ${decision.reason ?? 'denied'}`, error: 'permission denied' };
    }

    const started = Date.now();
    try {
      const result = await tool.execute(input, context);
      result.durationMs = Date.now() - started;
      return result;
    } catch (err) {
      return {
        ok: false,
        output: `tool "${name}" threw: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - started,
      };
    }
  }

  get size(): number {
    return this.tools.size;
  }
}

/** Coerce our permissive JSONSchema into a model-safe object schema. */
function normalizeSchema(schema: JSONSchema): JSONSchema {
  if (schema.type === 'object') return schema;
  // Tools must accept an object of arguments; wrap bare schemas.
  return {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required ?? [],
    description: schema.description,
  };
}
