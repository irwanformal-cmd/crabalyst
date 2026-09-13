import type { PluginModule } from '../../src/types/plugin.js';
import type { ToolContext } from '../../src/types/tool.js';
import { gamedevIntelligence } from './intelligence.js';

function ok(output: string, data?: unknown) {
  return { ok: true, output, data };
}
function fail(output: string, error?: string) {
  return { ok: false, output, error };
}

const entry: PluginModule = {
  intelligence: gamedevIntelligence,
  tools: {
    project_inspect: {
      description: 'Inspect a game project: list structure and detect engine/type.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project path relative to workspace.' } },
        required: [],
      },
      permissions: ['filesystem.read'],
      async execute(input, ctx: unknown) {
        const context = ctx as ToolContext;
        const fs = await import('node:fs');
        const path = await import('node:path');
        const root = path.join(context.workspacePath, String(input.path ?? '.'));
        if (!fs.existsSync(root)) return fail(`project not found: ${root}`);
        const entries = fs.readdirSync(root).sort();
        const engine = detectEngine(entries);
        return ok(`project at ${root}\nengine: ${engine}\n${entries.map((e) => `- ${e}`).join('\n')}`, { engine, entries });
      },
    },

    run_game: {
      description: 'Run the game (uses the project run command).',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Override run command.' } },
        required: [],
      },
      permissions: ['terminal.execute'],
      async execute(input, ctx: unknown) {
        const context = ctx as ToolContext;
        const command = String(input.command ?? 'npm run dev');
        return runCommand(command, context);
      },
    },

    run_tests: {
      description: 'Run the project test suite.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Override test command.' } },
        required: [],
      },
      permissions: ['terminal.execute'],
      async execute(input, ctx: unknown) {
        const context = ctx as ToolContext;
        const command = String(input.command ?? 'npm test');
        return runCommand(command, context);
      },
    },

    build_project: {
      description: 'Build the project.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Override build command.' } },
        required: [],
      },
      permissions: ['terminal.execute'],
      async execute(input, ctx: unknown) {
        const context = ctx as ToolContext;
        const command = String(input.command ?? 'npm run build');
        return runCommand(command, context);
      },
    },

    create_asset: {
      description: 'Create a placeholder asset file (sprite, tile, model stub).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Asset file name, e.g. "hero.png".' },
          path: { type: 'string', description: 'Directory relative to workspace.' },
        },
        required: ['name'],
      },
      permissions: ['filesystem.write'],
      async execute(input, ctx: unknown) {
        const context = ctx as ToolContext;
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = path.join(context.workspacePath, String(input.path ?? 'assets'));
        fs.mkdirSync(dir, { recursive: true });
        const name = String(input.name);
        const target = path.join(dir, name);
        if (name.endsWith('.json')) {
          fs.writeFileSync(target, JSON.stringify({ asset: name, placeholder: true }, null, 2));
        } else {
          fs.writeFileSync(target, `# placeholder asset: ${name}\n`);
        }
        return ok(`created asset ${target}`);
      },
    },

    modify_scene: {
      description: 'Modify a scene file by literal replacement.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Scene file relative to workspace.' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      permissions: ['filesystem.write'],
      async execute(input, ctx: unknown) {
        const context = ctx as ToolContext;
        const fs = await import('node:fs');
        const path = await import('node:path');
        const target = path.join(context.workspacePath, String(input.path));
        if (!fs.existsSync(target)) return fail(`scene not found: ${target}`);
        const content = fs.readFileSync(target, 'utf8');
        const oldStr = String(input.old_string);
        const count = content.split(oldStr).length - 1;
        if (count === 0) return fail('old_string not found');
        if (count > 1) return fail(`old_string matches ${count} times; be more specific`);
        fs.writeFileSync(target, content.replace(oldStr, String(input.new_string)));
        return ok(`modified scene ${target}`);
      },
    },
  },

  commands: {
    inspect: async (args) => {
      const ctx = { workspacePath: process.cwd() } as ToolContext;
      const res = await entry.tools!.project_inspect!.execute({ path: args.trim() || '.' }, ctx);
      return res.output;
    },
  },
};

function detectEngine(entries: string[]): string {
  if (entries.some((e) => e === 'project.godot')) return 'godot';
  if (entries.some((e) => e === 'package.json')) return 'web/js';
  if (entries.some((e) => e.toLowerCase() === 'unity' || e === 'Assets')) return 'unity';
  if (entries.some((e) => e.toLowerCase() === 'src' && e.toLowerCase() === 'love')) return 'love2d';
  return 'unknown';
}

async function runCommand(command: string, context: ToolContext) {
  const { exec } = await import('node:child_process');
  return new Promise<{ ok: boolean; output: string; error?: string }>((resolve) => {
    exec(command, { cwd: context.workspacePath, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout + stderr).trim() || '(no output)', error: err?.message });
    });
  });
}

export default entry;
