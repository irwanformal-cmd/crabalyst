import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager, estimateTokens } from '../src/core/context-manager.js';

test('estimateTokens is a rough heuristic', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('hello world') > 0);
});

test('buildSystemPrompt combines base, project and skills', () => {
  const cm = new ContextManager({ systemPrompt: 'BASE', projectInstructions: 'PROJECT' });
  const out = cm.buildSystemPrompt([], ['EXTRA']);
  assert.match(out, /BASE/);
  assert.match(out, /PROJECT/);
  assert.match(out, /EXTRA/);
});

test('buildSystemPrompt includes selected skills', () => {
  const cm = new ContextManager({});
  const out = cm.buildSystemPrompt([
    { name: 's1', description: '', purpose: 'p', instructions: 'instr', constraints: [], requiredTools: [], workflow: [] },
  ]);
  assert.match(out, /Skill: s1/);
  assert.match(out, /instr/);
});

test('trim keeps recent messages within budget', () => {
  const cm = new ContextManager({ maxContextTokens: 1000 });
  const messages = Array.from({ length: 100 }, (_, i) => ({
    role: 'user' as const,
    content: `message number ${i} with a fair amount of extra content to push past the budget`,
  }));
  const trimmed = cm.trim(messages, 300);
  assert.ok(trimmed.length < 100);
  assert.equal(trimmed[trimmed.length - 1]!.content, messages[messages.length - 1]!.content);
});
