import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { makeRuntime } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = resolve(HERE, '../plugins');

async function makePluginRuntime() {
  const rt = await makeRuntime({}, { loadPlugins: false });
  await rt.plugins.loadFromDir(PLUGINS_DIR);
  return rt;
}

test('plugins register intelligence contributions (analysts, sources, resolvers, workflows)', async () => {
  const rt = await makePluginRuntime();

  // Financial analysts + sources.
  for (const id of ['technical', 'onchain-whale', 'sentiment', 'macro', 'market-risk']) {
    assert.ok(rt.analystRegistry.get(id), `missing analyst ${id}`);
  }
  for (const id of ['crypto-market', 'crypto-news', 'onchain-mock', 'game-project']) {
    assert.ok(rt.dataSources.get(id), `missing data source ${id}`);
  }
  // Mock sources stay marked.
  assert.equal(rt.dataSources.get('onchain-mock')?.mock, true);

  // GameDev analysts.
  for (const id of ['game-performance', 'game-dependency']) {
    assert.ok(rt.analystRegistry.get(id), `missing analyst ${id}`);
  }

  // Entity resolver maps BTC.
  const found = rt.entityResolvers.resolveAll('analyze bitcoin');
  assert.ok(found.some((e) => e.id === 'BTCUSDT' && e.resolverId === 'crypto-symbols'));

  await rt.shutdown();
});

test('whale query routes to whale workflow and selects the on-chain analyst, not macro/sentiment', async () => {
  const rt = await makePluginRuntime();
  const result = await rt.analyze('whale analysis BTC today', {});
  assert.equal(result.plan.workflow, 'whale-onchain');
  assert.equal(result.subject, 'BTCUSDT');
  assert.equal(result.domain, 'crypto');
  assert.ok(result.plan.analystIds.includes('onchain-whale'), result.plan.analystIds.join(','));
  assert.ok(!result.plan.analystIds.includes('macro'), 'macro must not fire on whale queries');
  assert.ok(!result.plan.analystIds.includes('sentiment'), 'sentiment must not fire on whale queries');
  // On-chain analyst produced findings from mock data (marked).
  const whale = result.analysts.find((a) => a.analystId === 'onchain-whale');
  assert.ok(whale?.ok, whale?.error ?? 'onchain analyst failed');
  assert.ok(whale.findings.length > 0);
  // Mock data is disclosed in assumptions and dataSources.
  assert.ok(result.dataSources.some((s) => s.mock));
  assert.ok(result.assumptions.some((a) => /mock/i.test(a)));
  // Whale-specific evidence exists.
  assert.ok(result.evidence.some((e) => e.metric.includes('netflow') || e.metric.includes('whale')));
  await rt.shutdown();
});

test('technical query selects technical analyst with real indicator evidence', async () => {
  const rt = await makePluginRuntime();
  const result = await rt.analyze('technical analysis ETH', {});
  assert.equal(result.plan.workflow, 'technical');
  assert.ok(result.plan.analystIds.includes('technical'), result.plan.analystIds.join(','));
  const tech = result.analysts.find((a) => a.analystId === 'technical');
  assert.ok(tech?.ok, tech?.error ?? 'technical analyst failed');
  assert.ok(tech.evidence.some((e) => e.metric === 'rsi14'));
  assert.ok(tech.evidence.some((e) => e.metric === 'macd_hist'));
  // Candlestick visualization emitted from OHLCV data.
  assert.ok(result.visualizations.some((v) => v.type === 'candlestick'), result.visualizations.map((v) => v.type).join(','));
  await rt.shutdown();
});

test('diagnose query ("why is BTC dropping?") runs multi-signal causal workflow', async () => {
  const rt = await makePluginRuntime();
  const result = await rt.analyze('why is BTC dropping?', {});
  assert.equal(result.plan.workflow, 'diagnostic');
  // Multi-source diagnosis: trend + anomaly + causal core analysts plus domain specialists.
  assert.ok(result.plan.analystIds.includes('causal'), result.plan.analystIds.join(','));
  assert.ok(result.plan.analystIds.includes('anomaly'));
  assert.ok(result.plan.analystIds.includes('trend'));
  // Deep diagnosis fetches multiple timeframes → multi-period matrix.
  assert.ok(result.multiPeriod, 'expected multi-period analysis');
  assert.ok(result.multiPeriod!.periods.length >= 2);
  assert.ok(result.multiPeriod!.dimensions.includes('trend'));
  await rt.shutdown();
});

test('compare query across BTC and gold produces comparison visualization', async () => {
  const rt = await makePluginRuntime();
  const result = await rt.analyze('compare BTC with gold', {});
  assert.equal(result.plan.workflow, 'cross-asset');
  assert.ok(result.plan.analystIds.includes('comparative'), result.plan.analystIds.join(','));
  const cmp = result.analysts.find((a) => a.analystId === 'comparative');
  assert.ok(cmp?.ok, cmp?.error ?? 'comparative failed');
  assert.ok(result.visualizations.some((v) => v.type === 'bar'), result.visualizations.map((v) => v.type).join(','));
  await rt.shutdown();
});

test('forecast query produces a forecast with honest uncertainty notes', async () => {
  const rt = await makePluginRuntime();
  const result = await rt.analyze('predict BTC next week', {});
  assert.equal(result.plan.workflow, 'forecast');
  assert.ok(result.plan.analystIds.includes('forecasting'));
  assert.ok(result.forecast, 'expected forecast');
  assert.ok(result.forecast!.points.length >= 3);
  assert.ok(result.forecast!.notes.some((n) => /not a guarantee|estimate/i.test(n)));
  assert.ok(result.scenarios && result.scenarios.length >= 3);
  await rt.shutdown();
});

test('gamedev: FPS diagnosis uses the performance analyst on workspace logs', async () => {
  const dir = `/tmp/agent-gamedev-test-${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  // 60 samples @60fps, then a drop to ~30fps.
  const lines = ['time,fps'];
  for (let i = 0; i < 60; i++) lines.push(`${i},${60 + (i % 3)}`);
  for (let i = 60; i < 100; i++) lines.push(`${i},${30 + (i % 2)}`);
  writeFileSync(`${dir}/fps.csv`, lines.join('\n'));

  const rt = await makePluginRuntime();
  const result = await rt.analyze('why is my game FPS dropping?', { workspacePath: dir });
  assert.equal(result.plan.workflow, 'gamedev-diagnosis');
  const perf = result.analysts.find((a) => a.analystId === 'game-performance');
  assert.ok(perf?.ok, perf?.error ?? 'performance analyst failed');
  assert.ok(perf.findings.length > 0, 'expected a change-point finding');
  assert.ok(result.anomalies.length > 0 || perf.anomalies!.length > 0);
  // Finance analysts must not fire on gamedev queries.
  assert.ok(!result.plan.analystIds.includes('onchain-whale'));
  assert.ok(!result.plan.analystIds.includes('technical'));
  rmSync(dir, { recursive: true, force: true });
  await rt.shutdown();
});

test('gamedev: dependency query returns a network visualization', async () => {
  const dir = `/tmp/agent-gamedev-deps-${Date.now()}`;
  mkdirSync(`${dir}/src`, { recursive: true });
  writeFileSync(`${dir}/src/main.ts`, `import { Player } from './player';\nimport { World } from './world';\n`);
  writeFileSync(`${dir}/src/player.ts`, `import { World } from './world';\nexport class Player {}\n`);
  writeFileSync(`${dir}/src/world.ts`, `export class World {}\n`);

  const rt = await makePluginRuntime();
  const result = await rt.analyze('show module dependencies in this game project', { workspacePath: dir });
  const dep = result.analysts.find((a) => a.analystId === 'game-dependency');
  assert.ok(dep?.ok, dep?.error ?? 'dependency analyst failed');
  assert.ok(result.relationships.some((r) => r.kind === 'dependency'));
  assert.ok(result.visualizations.some((v) => v.type === 'network'), result.visualizations.map((v) => v.type).join(','));
  rmSync(dir, { recursive: true, force: true });
  await rt.shutdown();
});

test('provider switching does not affect the intelligence layer', async () => {
  const rt = await makePluginRuntime();
  rt.useProvider('mock-b');
  const result = await rt.analyze('whale analysis BTC today', {});
  assert.equal(result.plan.workflow, 'whale-onchain');
  assert.ok(result.findings.length > 0);
  await rt.shutdown();
});

test('analyses persist and can be listed/rerun from history', async () => {
  const rt = await makePluginRuntime();
  const a = await rt.analyze('technical analysis BTC', {});
  const b = await rt.analyze('whale analysis ETH today', {});
  const list = await rt.repository.listAnalyses();
  assert.ok(list.some((x) => x.id === a.id));
  assert.ok(list.some((x) => x.id === b.id));
  const reloaded = await rt.repository.getAnalysis(a.id);
  assert.equal(reloaded?.id, a.id);
  assert.ok(reloaded?.evidenceGraph?.nodes.length);
  await rt.shutdown();
});
