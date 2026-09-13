import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigLoader, parseConfigText, parseProviderConfig, normalizeProviderConfig } from '../src/config/loader.js';

test('parseConfigText parses YAML', () => {
  const v = parseConfigText('a: 1\nb: [1,2]');
  assert.deepEqual(v, { a: 1, b: [1, 2] });
  assert.deepEqual(parseConfigText(''), {});
});

test('normalizeProviderConfig requires name/kind/model', () => {
  assert.throws(() => normalizeProviderConfig({ name: 'x', kind: 'openai-compatible' }), /model/);
  const p = normalizeProviderConfig({ name: 'my-provider', kind: 'openai-compatible', base_url: 'https://x/v1', api_key_env: 'MY_API_KEY', model: 'my-model' });
  assert.equal(p.base_url, 'https://x/v1');
  assert.equal(p.api_key_env, 'MY_API_KEY');
});

test('parseProviderConfig parses YAML text', () => {
  const p = parseProviderConfig('name: my-provider\nbase_url: https://example.com/v1\napi_key_env: MY_API_KEY\nmodel: my-model\nkind: openai-compatible');
  assert.equal(p.name, 'my-provider');
  assert.equal(p.model, 'my-model');
});

test('config loader merges global and project config with precedence', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-cfg-home-'));
  const project = mkdtempSync(join(tmpdir(), 'agent-cfg-proj-'));
  mkdirSync(join(home), { recursive: true });
  writeFileSync(join(home, 'config.yaml'), 'agent:\n  temperature: 0.1\n  maxIterations: 10\n');
  mkdirSync(join(project, '.agent'), { recursive: true });
  writeFileSync(join(project, '.agent', 'config.yaml'), 'agent:\n  temperature: 0.9\n');

  const loader = new ConfigLoader({ homeDir: home });
  const cfg = loader.load(project);
  assert.equal(cfg.agent?.temperature, 0.9); // project wins
  assert.equal(cfg.agent?.maxIterations, 10); // global preserved
  assert.ok(cfg.sources.some((s) => s.includes('config.yaml')));
});

test('config loader reads AGENT.md project instructions', () => {
  const project = mkdtempSync(join(tmpdir(), 'agent-cfg-proj2-'));
  writeFileSync(join(project, 'AGENT.md'), '# Rules\nDo not hard-code keys.');
  const loader = new ConfigLoader({ homeDir: mkdtempSync(join(tmpdir(), 'agent-cfg-home2-')) });
  const instructions = loader.readProjectInstructions(project);
  assert.match(instructions!, /Do not hard-code keys/);
});

test('config loader writes and lists providers', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-cfg-home3-'));
  const loader = new ConfigLoader({ homeDir: home });
  loader.writeProvider({ name: 'deepseek', kind: 'openai-compatible', base_url: 'https://api.deepseek.com/v1', api_key_env: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' });
  const list = loader.listProviders();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'deepseek');
});
