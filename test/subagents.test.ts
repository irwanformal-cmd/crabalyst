import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, collectEvents } from './helpers.js';
import { parseAgent } from '../src/agents/loader.js';

test('subagent runs with separate context and returns structured result', async () => {
  const rt = await makeRuntime({ agent: { model: 'mock-1', maxIterations: 8 } });
  rt.agents.register({
    name: 'worker',
    description: 'test worker',
    systemPrompt: 'You are a worker. Answer briefly.',
    tools: ['echo'],
    maxIterations: 4,
  });
  const events = collectEvents(rt);
  const result = await rt.subagents.run('worker', 'do the task', { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(result.name, 'worker');
  assert.equal(result.ok, true);
  assert.ok(result.result.length > 0);
  assert.ok(events.some((e) => e.type === 'subagent_start'));
  assert.ok(events.some((e) => e.type === 'subagent_result'));
  await rt.shutdown();
});

test('subagent can override provider and model', async () => {
  const rt = await makeRuntime({ agent: { model: 'mock-1', maxIterations: 8 } });
  rt.agents.register({
    name: 'b-agent',
    description: 'uses provider B',
    systemPrompt: 'worker',
    provider: 'mock-b',
    model: 'mock-b-1',
    tools: ['echo'],
  });
  const result = await rt.subagents.run('b-agent', 'go', { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'mock-b');
  await rt.shutdown();
});

test('unknown subagent returns a clean failure', async () => {
  const rt = await makeRuntime();
  const result = await rt.subagents.run('nope', 'go', { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(result.ok, false);
  await rt.shutdown();
});

test('parseAgent reads frontmatter', () => {
  const a = parseAgent('x', '---\ndescription: d\ntools: [a, b]\nmodel: m\nmax_tokens: 100\n---\nSystem body');
  assert.equal(a.name, 'x');
  assert.deepEqual(a.tools, ['a', 'b']);
  assert.equal(a.model, 'm');
  assert.equal(a.maxTokens, 100);
  assert.equal(a.systemPrompt, 'System body');
});
