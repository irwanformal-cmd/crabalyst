import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { PluginManifest } from '../types/plugin.js';

/** Parse and validate a plugin manifest.yaml. */
export function parseManifest(text: string): PluginManifest {
  const raw = parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') throw new Error('plugin manifest must be a YAML mapping');
  if (!raw.name || typeof raw.name !== 'string') throw new Error('plugin manifest requires `name`');
  if (!raw.version || typeof raw.version !== 'string') throw new Error(`plugin "${raw.name}" requires \`version\``);

  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const tools = Array.isArray(raw.tools)
    ? (raw.tools as unknown[]).map((t, i) => {
        if (typeof t === 'string') {
          return { name: t, description: '', parameters: {} };
        }
        if (t && typeof t === 'object') {
          const o = t as Record<string, unknown>;
          return {
            name: String(o.name ?? `tool-${i}`),
            description: String(o.description ?? ''),
            parameters: (o.parameters ?? o.input_schema ?? {}) as Record<string, unknown>,
            permissions: arr(o.permissions),
          };
        }
        throw new Error(`plugin "${raw.name}" tool #${i} must be a string or mapping`);
      })
    : undefined;

  return {
    name: raw.name as string,
    version: raw.version as string,
    description: typeof raw.description === 'string' ? raw.description : '',
    author: typeof raw.author === 'string' ? raw.author : undefined,
    permissions: arr(raw.permissions),
    tools,
    skills: arr(raw.skills),
    agents: arr(raw.agents),
    commands: arr(raw.commands),
    hooks: arr(raw.hooks),
    mcp: arr(raw.mcp),
    entry: typeof raw.entry === 'string' ? raw.entry : undefined,
    ...raw,
  };
}

export function readManifest(dir: string): PluginManifest {
  const path = join(dir, 'manifest.yaml');
  if (!existsSync(path)) throw new Error(`plugin directory ${dir} has no manifest.yaml`);
  return parseManifest(readFileSync(path, 'utf8'));
}
