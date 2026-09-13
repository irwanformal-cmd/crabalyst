#!/usr/bin/env node
// Minimal MCP stdio server for integration tests.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
};

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    respond(msg.id, {
      tools: [
        {
          name: 'mcp_echo',
          description: 'Echo arguments back',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        },
      ],
    });
  } else if (msg.method === 'tools/call') {
    const args = msg.params?.arguments ?? {};
    respond(msg.id, {
      content: [{ type: 'text', text: `mcp_echo: ${args.message ?? ''}` }],
      structuredContent: args,
      isError: false,
    });
  }
});
