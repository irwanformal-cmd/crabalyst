import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionPolicy } from '../src/permissions/policy.js';
import { makeRuntime } from './helpers.js';

test('permission policy allows granted and denies explicit denials', async () => {
  const policy = new PermissionPolicy({ allow: ['filesystem.read'], deny: ['network'] });
  assert.equal((await policy.check(['filesystem.read'])).allowed, true);
  assert.equal((await policy.check(['network'])).allowed, false);
  // Unknown permissions fail closed when no approver exists.
  assert.equal((await policy.check(['docker'])).allowed, false);
});

test('permission policy delegates to approver for unknown permissions', async () => {
  let asked = 0;
  const policy = new PermissionPolicy({
    allow: [],
    approver: async () => {
      asked++;
      return { allowed: true };
    },
  });
  const decision = await policy.check(['docker']);
  assert.equal(decision.allowed, true);
  assert.equal(asked, 1);
});

test('runtime enforces permissions before tool execution', async () => {
  const rt = await makeRuntime({
    permissions: { allow: [], deny: ['terminal.execute'] },
  });
  const res = await rt.tools.execute('terminal', { command: 'echo hi' }, { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(res.ok, false);
  assert.match(res.output, /denied/);
  await rt.shutdown();
});

test('runtime grants configured permissions', async () => {
  const rt = await makeRuntime({
    permissions: { allow: ['filesystem.read', 'filesystem.write'], deny: [] },
  });
  const res = await rt.tools.execute('write_file', { path: 'ok.txt', content: 'x' }, { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(res.ok, true);
  await rt.shutdown();
});
