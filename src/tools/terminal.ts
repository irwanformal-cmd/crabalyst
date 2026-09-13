import { exec } from 'node:child_process';
import type { Tool } from '../types/tool.js';
import { Permissions } from '../types/permissions.js';

function runCommand(command: string, cwd: string, timeoutMs: number, env?: Record<string, string>): Promise<{ ok: boolean; output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = exec(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...(env ?? {}) },
      shell: '/bin/bash',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      resolve({ ok: false, output: `failed to spawn command: ${err.message}`, exitCode: -1 });
    });
    child.on('close', (code) => {
      const out = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
      resolve({ ok: code === 0, output: out.trim() || `(exit ${code})`, exitCode: code ?? -1 });
    });
  });
}

export const terminalTool: Tool = {
  name: 'terminal',
  description: 'Run a shell command in the workspace and return its stdout/stderr and exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run.' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace.' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds (default 30000).' },
    },
    required: ['command'],
  },
  permissions: [Permissions.TerminalExecute],
  async execute(input, ctx) {
    const command = String(input.command ?? '');
    const cwd = ctx.workspacePath + (input.cwd ? `/${String(input.cwd)}` : '');
    const timeout = Number(input.timeout ?? 30_000);
    const res = await runCommand(command, cwd, timeout, ctx.env);
    return { ok: res.ok, output: res.output, meta: { exitCode: res.exitCode } };
  },
};
