import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookEngine } from '../src/hooks/engine.js';
import { makeRuntime, collectEvents } from './helpers.js';

test('hook engine fires hooks in registration order and collects errors', async () => {
  const engine = new HookEngine();
  const order: string[] = [];
  engine.register({ name: 'a', point: 'AfterToolCall', run: async () => { order.push('a'); } });
  engine.register({ name: 'b', point: 'AfterToolCall', run: async () => { order.push('b'); } });
  engine.register({ name: 'boom', point: 'AfterToolCall', run: async () => { throw new Error('boom'); } });
  const errors = await engine.fire('AfterToolCall', { workspacePath: '/' });
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.message, 'boom');
});

test('runtime fires BeforeAgent/AfterAgent and tool hooks', async () => {
  const rt = await makeRuntime({ agent: { model: 'mock-1', maxIterations: 8 } });
  const fired: string[] = [];
  rt.hooks.register({ name: 'before', point: 'BeforeAgent', run: () => { fired.push('BeforeAgent'); } });
  rt.hooks.register({ name: 'after', point: 'AfterAgent', run: () => { fired.push('AfterAgent'); } });
  rt.hooks.register({ name: 'tool', point: 'AfterToolCall', run: () => { fired.push('AfterToolCall'); } });
  await rt.run('hi');
  assert.ok(fired.includes('BeforeAgent'));
  assert.ok(fired.includes('AfterAgent'));
  await rt.shutdown();
});
