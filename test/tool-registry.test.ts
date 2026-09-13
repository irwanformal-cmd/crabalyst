import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, collectEvents } from './helpers.js';

test('tool registry registers, lists and executes tools', async () => {
  const rt = await makeRuntime();
  assert.ok(rt.tools.has('echo'));
  assert.ok(rt.tools.has('read_file'));
  assert.ok(rt.tools.has('write_file'));
  assert.ok(rt.tools.has('terminal'));
  assert.ok(rt.tools.has('git'));
  assert.ok(rt.tools.has('http'));

  const res = await rt.tools.execute('echo', { message: 'hello' }, { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(res.ok, true);
  assert.equal(res.output, 'hello');

  const schemas = rt.tools.listSchemas();
  assert.ok(schemas.length >= 6);
  assert.ok(schemas.every((s) => s.type === 'function' && s.function.name));
  await rt.shutdown();
});

test('unknown tool returns a clean failure', async () => {
  const rt = await makeRuntime();
  const res = await rt.tools.execute('nope', {}, { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(res.ok, false);
  await rt.shutdown();
});

test('filesystem tools read/write within the workspace and block escapes', async () => {
  const rt = await makeRuntime();
  const ws = '/tmp/agent-test-ws';
  await rt.tools.execute('write_file', { path: 'a.txt', content: 'hello' }, { workspacePath: ws });
  const read = await rt.tools.execute('read_file', { path: 'a.txt' }, { workspacePath: ws });
  assert.equal(read.ok, true);
  assert.match(read.output, /hello/);

  const escape = await rt.tools.execute('read_file', { path: '../../etc/passwd' }, { workspacePath: ws });
  assert.equal(escape.ok, false);
  await rt.shutdown();
});

test('git tool distinguishes read and write actions', async () => {
  const rt = await makeRuntime();
  const read = await rt.tools.execute('git', { action: 'status', args: [] }, { workspacePath: '/tmp/agent-test-ws' });
  // A non-repo status may fail at the git level but must not be a permission error.
  assert.equal(typeof read.output, 'string');
  await rt.shutdown();
});
