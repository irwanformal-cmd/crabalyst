import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { AgentDefinition } from '../types/skill.js';
import { parseFrontmatter } from '../skills/loader.js';

/** Parse a subagent definition from Markdown with frontmatter. */
export function parseAgent(name: string, text: string, opts?: { pluginId?: string; path?: string }): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter(text);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    name: str(frontmatter.name) ?? name,
    description: str(frontmatter.description) ?? '',
    systemPrompt: body.trim(),
    tools: arr(frontmatter.tools),
    provider: str(frontmatter.provider),
    model: str(frontmatter.model),
    maxTokens: typeof frontmatter.max_tokens === 'number' ? frontmatter.max_tokens : undefined,
    maxIterations: typeof frontmatter.max_iterations === 'number' ? frontmatter.max_iterations : undefined,
    pluginId: opts?.pluginId,
    path: opts?.path,
  };
}

export function loadAgentsFromDir(dir: string, opts?: { pluginId?: string; onlyNames?: string[] }): AgentDefinition[] {
  const agents: AgentDefinition[] = [];
  if (!existsSync(dir)) return agents;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) continue;
    if (extname(entry) !== '.md') continue;
    const name = basename(entry, '.md');
    if (opts?.onlyNames && !opts.onlyNames.includes(name)) continue;
    agents.push(parseAgent(name, readFileSync(full, 'utf8'), { pluginId: opts?.pluginId, path: full }));
  }
  return agents;
}
