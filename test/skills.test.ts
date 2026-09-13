import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkill, parseFrontmatter } from '../src/skills/loader.js';
import { SkillManager } from '../src/skills/manager.js';

test('parseFrontmatter extracts YAML and body', () => {
  const text = '---\nname: x\ndescription: d\n---\nbody content';
  const { frontmatter, body } = parseFrontmatter(text);
  assert.equal(frontmatter.name, 'x');
  assert.equal(body, 'body content');
});

test('parseSkill maps fields', () => {
  const skill = parseSkill('tech', '---\npurpose: analyze\nconstraints: [a, b]\nrequired_tools: [t1]\nworkflow: [w1, w2]\n---\nInstructions here');
  assert.equal(skill.name, 'tech');
  assert.equal(skill.purpose, 'analyze');
  assert.deepEqual(skill.constraints, ['a', 'b']);
  assert.deepEqual(skill.requiredTools, ['t1']);
  assert.deepEqual(skill.workflow, ['w1', 'w2']);
  assert.equal(skill.instructions, 'Instructions here');
});

test('SkillManager selects relevant skills', () => {
  const mgr = new SkillManager();
  mgr.register(parseSkill('technical-analysis', '---\ntriggers: [rsi, macd]\npurpose: technical indicators\n---\nbody'));
  mgr.register(parseSkill('risk-management', '---\ntriggers: [stop loss]\npurpose: position sizing\n---\nbody'));
  const selected = mgr.select('compute RSI and MACD for BTC');
  assert.ok(selected.some((s) => s.name === 'technical-analysis'));
  assert.ok(!selected.some((s) => s.name === 'risk-management'));
});

test('SkillManager renders context block', () => {
  const mgr = new SkillManager();
  mgr.register(parseSkill('x', '---\npurpose: p\n---\n# X\nbody'));
  const out = mgr.renderContext(mgr.list());
  assert.match(out, /Skill: x/);
  assert.match(out, /<skills>/);
});
