import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeRuntime } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures', 'mock-mcp-server.mjs');

test('MCP manager registers external server tools dynamically', async () => {
  const rt = await makeRuntime();
  await rt.mcp.addServer('test-mcp', { command: 'node', args: [FIXTURE], enabled: true }, ['mcp']);
  assert.ok(rt.mcp.list().includes('test-mcp'));
  assert.ok(rt.tools.has('mcp_echo'));

  const res = await rt.tools.execute('mcp_echo', { message: 'hello-mcp' }, { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(res.ok, true);
  assert.match(res.output, /hello-mcp/);

  await rt.shutdown();
});

test('MCP tool call returns structured content', async () => {
  const rt = await makeRuntime();
  await rt.mcp.addServer('mcp2', { command: 'node', args: [FIXTURE] }, ['mcp']);
  const res = await rt.tools.execute('mcp_echo', { message: 'x' }, { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { message: 'x' });
  await rt.shutdown();
});
