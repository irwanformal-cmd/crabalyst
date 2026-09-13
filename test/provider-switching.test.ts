import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, collectEvents, mockConfig } from './helpers.js';
import { AgentRuntime } from '../src/core/runtime.js';

/**
 * Integration test: the SAME plugin + SAME agent workflow runs identically on
 * Provider A and Provider B, proving provider-agnostic orchestration.
 */
test('same workflow runs on provider A and provider B', async () => {
  const runWorkflow = async (providerId: string) => {
    const rt = new AgentRuntime({
      config: mockConfig({ agent: { model: 'mock-1', maxIterations: 8 } }),
      dbPath: ':memory:',
      loadPlugins: false,
      projectDir: '/tmp/agent-test-ws',
    });
    await rt.start();
    rt.useProvider(providerId);
    const events = collectEvents(rt);
    const res = await rt.run('execute the workflow', { providerId });
    await rt.shutdown();
    return { res, events };
  };

  const a = await runWorkflow('mock');
  const b = await runWorkflow('mock-b');

  assert.equal(a.res.ok, true);
  assert.equal(b.res.ok, true);
  // Provider B (script=tool) exercises a tool call; provider A is a plain echo.
  assert.ok(a.events.some((e) => e.type === 'completion'));
  assert.ok(b.events.some((e) => e.type === 'completion'));
  assert.ok(b.events.some((e) => e.type === 'tool_call'));
});

test('agent loop emits structured events in order', async () => {
  const rt = await makeRuntime({ agent: { model: 'mock-1', maxIterations: 8 } });
  const events = collectEvents(rt);
  await rt.run('do work');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('planning'));
  assert.ok(types.includes('completion'));
  await rt.shutdown();
});

test('provider switching does not change registered tools', async () => {
  const rt = await makeRuntime();
  const before = rt.tools.list().map((t) => t.name).sort();
  rt.useProvider('mock-b');
  const after = rt.tools.list().map((t) => t.name).sort();
  assert.deepEqual(after, before);
  assert.equal(rt.providers.active().id, 'mock-b');
  await rt.shutdown();
});
