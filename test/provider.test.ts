import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/providers/mock.js';
import { OpenAICompatibleProvider, toOpenAIMessages, toOpenAITools } from '../src/providers/openai-compatible.js';
import { AnthropicProvider, toAnthropicMessages } from '../src/providers/anthropic.js';
import type { ProviderConfig } from '../src/types/provider.js';

test('mock provider streams text and done events', async () => {
  const p = new MockProvider('mock', { script: 'echo' });
  const events = [];
  for await (const e of p.chat({ model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(e);
  }
  assert.ok(events.some((e) => e.type === 'text'));
  assert.ok(events.some((e) => e.type === 'done'));
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  if (done && done.type === 'done') assert.equal(done.text.length > 0, true);
});

test('mock provider emits tool calls for script=tool', async () => {
  const p = new MockProvider('mock', { script: 'tool' });
  const events = [];
  for await (const e of p.chat({ model: 'mock-1', messages: [{ role: 'user', content: 'run' }], tools: [] })) {
    events.push(e);
  }
  const calls = events.filter((e) => e.type === 'tool_call');
  assert.equal(calls.length, 1);
});

test('openai-compatible message conversion', () => {
  const converted = toOpenAIMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', toolCalls: [{ id: 'c1', name: 'echo', arguments: { m: 'x' } }] },
    { role: 'tool', content: 'x', toolCallId: 'c1', name: 'echo' },
  ]);
  assert.equal(converted[0]!.role, 'user');
  assert.equal((converted[1] as { tool_calls: Array<{ function: { name: string } }> }).tool_calls[0]!.function.name, 'echo');
  assert.equal((converted[2] as { tool_call_id: string }).tool_call_id, 'c1');
});

test('anthropic message conversion groups tool results', () => {
  const converted = toAnthropicMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'echo', arguments: {} }] },
    { role: 'tool', content: 'result', toolCallId: 't1' },
  ]);
  assert.equal(converted.length, 3);
  assert.equal(converted[2]!.role, 'user');
  assert.equal(converted[2]!.content[0]!.type, 'tool_result');
});

test('provider instances expose capabilities', () => {
  const openaiCfg: ProviderConfig = { name: 'x', kind: 'openai-compatible', model: 'm', base_url: 'https://x/v1' };
  const p = new OpenAICompatibleProvider(openaiCfg);
  assert.equal(p.getCapabilities().streaming, true);
  assert.equal(p.getCapabilities().tools, true);

  const anthroCfg: ProviderConfig = { name: 'a', kind: 'anthropic', model: 'm' };
  const a = new AnthropicProvider(anthroCfg);
  assert.equal(a.getCapabilities().tools, true);
});

test('openai tools conversion', () => {
  const tools = toOpenAITools([{ type: 'function', function: { name: 'echo', description: 'd', parameters: { type: 'object', properties: {} } } }]);
  assert.equal((tools![0] as { function: { name: string } }).function.name, 'echo');
});
