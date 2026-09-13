import { AgentRuntime } from '../src/core/runtime.js';
import type { EffectiveConfig } from '../src/types/config.js';

export const ALL_PERMISSIONS = [
  'filesystem.read', 'filesystem.write', 'terminal.execute', 'git.read', 'git.write',
  'network', 'http.request', 'process.spawn', 'docker', 'browser', 'mcp',
];

export function mockConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    providers: [
      { name: 'mock', kind: 'mock', model: 'mock-1', options: { script: 'echo' } },
      { name: 'mock-b', kind: 'mock', model: 'mock-b-1', options: { script: 'tool' } },
    ],
    agent: { model: 'mock-1', maxIterations: 8, maxTokens: 4096, temperature: 0 },
    permissions: { allow: ALL_PERMISSIONS, deny: [] },
    sources: ['test'],
    homeDir: '/tmp/agent-test-home',
    mcp: {},
    plugins: [],
    pluginDirs: [],
    logging: { level: 'error', dir: '/tmp/agent-test-logs' },
    workspace: { root: '/tmp/agent-test-ws' },
    ...overrides,
  };
}

export async function makeRuntime(overrides: Partial<EffectiveConfig> = {}, opts: { loadPlugins?: boolean } = {}): Promise<AgentRuntime> {
  const rt = new AgentRuntime({
    config: mockConfig(overrides),
    dbPath: ':memory:',
    loadPlugins: opts.loadPlugins ?? false,
    projectDir: '/tmp/agent-test-ws',
  });
  await rt.start();
  return rt;
}

export function collectEvents(rt: AgentRuntime) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  rt.events.subscribe((e) => events.push(e as unknown as { type: string; [k: string]: unknown }));
  return events;
}
