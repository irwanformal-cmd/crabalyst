import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime } from './helpers.js';

test('sessions persist across runtime instances (SQLite file)', async () => {
  const dbPath = `/tmp/agent-session-test-${Date.now()}.sqlite`;
  const { AgentRuntime } = await import('../src/core/runtime.js');
  const { mockConfig } = await import('./helpers.js');

  const rt = new AgentRuntime({ config: mockConfig({ workspace: { root: '/tmp/ws' } }), dbPath, loadPlugins: false, projectDir: '/tmp/ws' });
  await rt.start();
  const created = await rt.createSession('my session', '/tmp/ws');
  await rt.sessions.appendMessage(created.id, { role: 'user', content: 'hello' });
  await rt.sessions.appendMessage(created.id, { role: 'assistant', content: 'hi' });
  await rt.shutdown();

  // New runtime against the same DB file.
  const rt3 = new AgentRuntime({ config: mockConfig({ workspace: { root: '/tmp/ws' } }), dbPath, loadPlugins: false, projectDir: '/tmp/ws' });
  await rt3.start();
  const resumed = await rt3.resumeSession(created.id);
  assert.equal(resumed.id, created.id);
  assert.equal(resumed.messages.length, 2);
  assert.equal(resumed.messages[0]!.content, 'hello');
  await rt3.shutdown();
});

test('session list and delete', async () => {
  const rt = await makeRuntime();
  const s = await rt.createSession('to-delete');
  const list = await rt.listSessions();
  assert.ok(list.some((x) => x.id === s.id));
  await rt.deleteSession(s.id);
  const list2 = await rt.listSessions();
  assert.ok(!list2.some((x) => x.id === s.id));
  await rt.shutdown();
});

test('predictions and journal persist to the repository', async () => {
  const rt = await makeRuntime();
  await rt.repository.recordPrediction({
    asset: 'BTCUSDT', timestamp: new Date().toISOString(), timeframe: '4h',
    prediction: 'bullish', confidence: 0.72, reasoning: {}, indicators: {}, outcome: null,
  });
  await rt.repository.recordJournal({ sessionId: 's1', eventType: 'AfterToolCall', payload: { x: 1 } });
  // Query via raw db.
  const pred = rt.db.prepare('SELECT COUNT(*) AS n FROM predictions').get() as { n: number };
  const journal = rt.db.prepare('SELECT COUNT(*) AS n FROM journal').get() as { n: number };
  assert.equal(pred.n, 1);
  assert.equal(journal.n, 1);
  await rt.shutdown();
});
