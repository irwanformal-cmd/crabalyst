import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LoadedPlugin, PluginModule } from '../types/plugin.js';
import { parseManifest, readManifest } from './manifest.js';
import { readFileSync } from 'node:fs';

/** Discover plugin directories (dirs containing manifest.yaml) in a root. */
export function discoverPluginDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    try {
      if (statSync(full).isDirectory() && existsSync(join(full, 'manifest.yaml'))) {
        out.push(full);
      }
    } catch {
      /* ignore unreadable entries */
    }
  }
  return out.sort();
}

/**
 * Load a plugin from its directory. Optionally imports its entry module
 * (dynamic import) to get executable tools/hooks.
 */
export async function loadPlugin(dir: string): Promise<LoadedPlugin> {
  const abs = resolve(dir);
  const manifest = readManifest(abs);
  let module: PluginModule | undefined;
  if (manifest.entry) {
    const entryPath = resolve(abs, manifest.entry);
    if (!existsSync(entryPath)) {
      throw new Error(`plugin "${manifest.name}" entry "${manifest.entry}" not found`);
    }
    const imported = (await import(entryPath)) as { default?: PluginModule; tools?: PluginModule['tools']; hooks?: PluginModule['hooks'] };
    module = imported.default ?? {
      tools: imported.tools,
      hooks: imported.hooks,
    };
  } else {
    // Auto-discover entry.ts / entry.js if present.
    for (const candidate of ['entry.ts', 'entry.js', 'plugin.ts', 'plugin.js', 'index.ts', 'index.js']) {
      const p = resolve(abs, candidate);
      if (existsSync(p)) {
        const imported = (await import(p)) as { default?: PluginModule; tools?: PluginModule['tools']; hooks?: PluginModule['hooks'] };
        module = imported.default ?? { tools: imported.tools, hooks: imported.hooks };
        break;
      }
    }
  }

  return { id: manifest.name, manifest, path: abs, module };
}

/** Parse a plugin's manifest without executing any of its code. */
export function inspectPlugin(dir: string): LoadedPlugin {
  const abs = resolve(dir);
  return { id: parseManifest(readFileSync(join(abs, 'manifest.yaml'), 'utf8')).name, manifest: readManifest(abs), path: abs };
}
