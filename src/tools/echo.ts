import type { Tool } from '../types/tool.js';

/** Minimal tool used by tests and the mock provider's scripted runs. */
export const echoTool: Tool = {
  name: 'echo',
  description: 'Echo the provided message back. Used for plumbing and tests.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Message to echo.' } },
    required: ['message'],
  },
  permissions: [],
  async execute(input) {
    const message = String(input.message ?? '');
    return { ok: true, output: message };
  },
};
