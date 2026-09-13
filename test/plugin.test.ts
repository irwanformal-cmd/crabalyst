import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeRuntime } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = resolve(HERE, '../plugins');

test('financial-analysis plugin loads tools, skills, agents, commands, hooks', async () => {
  const rt = await makeRuntime({}, { loadPlugins: false });
  await rt.plugins.loadFromDir(PLUGINS_DIR);

  const loaded = rt.plugins.list();
  assert.ok(loaded.some((p) => p.id === 'financial-analysis'));
  assert.ok(loaded.some((p) => p.id === 'gamedev'));

  // Financial tools registered.
  for (const name of ['market_data', 'technical_indicators', 'backtest', 'risk_calculator', 'journal_prediction']) {
    assert.ok(rt.tools.has(name), `missing tool ${name}`);
  }
  // Gamedev tools registered.
  for (const name of ['project_inspect', 'run_game', 'run_tests', 'create_asset', 'modify_scene', 'build_project']) {
    assert.ok(rt.tools.has(name), `missing tool ${name}`);
  }

  // Skills.
  assert.ok(rt.skills.get('technical-analysis'));
  assert.ok(rt.skills.get('risk-management'));

  // Agents.
  assert.ok(rt.agents.get('technical'));
  assert.ok(rt.agents.get('coordinator'));

  // Commands.
  assert.ok(rt.commands.get('scan'));
  assert.ok(rt.commands.get('analyze'));
  assert.ok(rt.commands.get('inspect'));

  await rt.shutdown();
});

test('plugin tool executes (technical_indicators)', async () => {
  const rt = await makeRuntime({}, { loadPlugins: false });
  await rt.plugins.loadFromDir(PLUGINS_DIR);
  const res = await rt.tools.execute('technical_indicators', { symbol: 'BTCUSDT', timeframe: '4h' }, { workspacePath: '/tmp/agent-test-ws' });
  assert.equal(res.ok, true);
  const data = res.data as Record<string, unknown>;
  assert.ok(data.price !== undefined);
  assert.ok(data.rsi !== undefined);
  await rt.shutdown();
});

test('plugin reload is idempotent', async () => {
  const rt = await makeRuntime({}, { loadPlugins: false });
  await rt.plugins.loadFromDir(PLUGINS_DIR);
  await rt.plugins.loadFromDir(PLUGINS_DIR);
  assert.equal(rt.plugins.list().length, 2);
  await rt.shutdown();
});
