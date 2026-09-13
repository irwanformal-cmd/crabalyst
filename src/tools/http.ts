import type { Tool } from '../types/tool.js';
import { Permissions } from '../types/permissions.js';

export const httpTool: Tool = {
  name: 'http',
  description: 'Perform an HTTP request and return status, headers and body.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL.' },
      method: { type: 'string', description: 'HTTP method.', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers.' },
      body: { type: 'string', description: 'Request body (string).' },
      timeout: { type: 'integer', description: 'Timeout in ms (default 20000).' },
    },
    required: ['url'],
  },
  permissions: [Permissions.HttpRequest],
  async execute(input) {
    try {
      const url = String(input.url ?? '');
      const method = String(input.method ?? 'GET').toUpperCase();
      const headers = (input.headers as Record<string, string>) ?? {};
      const timeout = Number(input.timeout ?? 20_000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, {
        method,
        headers,
        body: input.body !== undefined ? String(input.body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      const truncated = text.slice(0, 50_000);
      return {
        ok: res.ok,
        output: `${res.status} ${res.statusText}\n${truncated}`,
        data: { status: res.status, headers: Object.fromEntries(res.headers as unknown as Iterable<[string, string]>), body: truncated },
        meta: { status: res.status },
      };
    } catch (err) {
      return { ok: false, output: `http request failed: ${(err as Error).message}`, error: (err as Error).message };
    }
  },
};
