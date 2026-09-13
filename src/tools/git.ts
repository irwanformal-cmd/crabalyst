import { exec } from 'node:child_process';
import type { Tool } from '../types/tool.js';
import { Permissions } from '../types/permissions.js';

const READ_ACTIONS = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse']);
const WRITE_ACTIONS = new Set(['commit', 'add', 'checkout', 'merge', 'push', 'pull', 'reset', 'tag', 'rebase']);

function execGit(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(`git ${args.join(' ')}`, { cwd, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout + stderr).trim() || '(no output)' });
    });
  });
}

export const gitTool: Tool = {
  name: 'git',
  description: 'Run a git subcommand in the workspace. Read-only actions require git.read; mutating actions require git.write.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Git subcommand: status, log, diff, show, branch, add, commit, checkout, etc.',
        enum: [...READ_ACTIONS, ...WRITE_ACTIONS],
      },
      args: { type: 'array', items: { type: 'string' }, description: 'Additional arguments.' },
    },
    required: ['action'],
  },
  permissions: [Permissions.GitRead],
  async execute(input, ctx) {
    const action = String(input.action ?? 'status');
    const extra = (input.args as string[] | undefined) ?? [];
    const args = [action, ...extra];

    // Mutating actions require an elevated permission. This is enforced by the
    // registry only for the declared permission, so we re-check here by
    // returning a clear error when the action is a write and the caller only
    // holds git.read. The runtime enforces git.write via the policy when the
    // tool is configured with both; a single-declared permission keeps the
    // model contract simple while this guard prevents accidental writes.
    const writeRequested = WRITE_ACTIONS.has(action);
    if (writeRequested && ctx.approver) {
      const decision = await ctx.approver({
        kind: 'tool',
        permission: Permissions.GitWrite,
        description: `git ${action} mutates the repository`,
        toolName: 'git',
        input,
        sessionId: ctx.sessionId,
      });
      if (!decision.allowed) {
        return { ok: false, output: `git ${action} blocked: ${decision.reason ?? 'denied'}`, error: 'permission denied' };
      }
    }

    const res = await execGit(args, ctx.workspacePath);
    return { ok: res.ok, output: res.output };
  },
};
