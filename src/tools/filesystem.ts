import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types/tool.js';
import { Permissions } from '../types/permissions.js';

/** Resolve a user-supplied path against the workspace and confine it. */
export function resolveWorkspacePath(workspacePath: string, input: string): string {
  const p = resolve(workspacePath, input);
  if (!isInside(workspacePath, p)) {
    throw new Error(`path "${input}" escapes the workspace`);
  }
  return p;
}

function isInside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  const rel = relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function ok(output: string, data?: unknown): ToolResult {
  return { ok: true, output, data };
}
function fail(error: string): ToolResult {
  return { ok: false, output: error, error };
}

function textResult(file: string, content: string, path: string): ToolResult {
  return ok(`${file}\n${content}`, { path, content });
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace, returning line-numbered content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace.' },
      offset: { type: 'integer', description: '1-based first line to return (default 1).' },
      limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000).' },
    },
    required: ['path'],
  },
  permissions: [Permissions.FilesystemRead],
  async execute(input, ctx) {
    try {
      const p = resolveWorkspacePath(ctx.workspacePath, String(input.path ?? ''));
      if (!existsSync(p)) return fail(`file not found: ${p}`);
      const content = readFileSync(p, 'utf8');
      const lines = content.split('\n');
      const offset = Number(input.offset ?? 1);
      const limit = Number(input.limit ?? 2000);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
      return textResult(basename(p), numbered, p);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create or fully replace a UTF-8 text file in the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace.' },
      content: { type: 'string', description: 'Full file contents.' },
    },
    required: ['path', 'content'],
  },
  permissions: [Permissions.FilesystemWrite],
  async execute(input, ctx) {
    try {
      const p = resolveWorkspacePath(ctx.workspacePath, String(input.path ?? ''));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, String(input.content ?? ''), 'utf8');
      return ok(`wrote ${p} (${String(input.content ?? '').length} bytes)`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Replace a literal string in a UTF-8 text file. Fails if the match is not unique unless replace_all is true.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace.' },
      old_string: { type: 'string', description: 'Literal text to replace.' },
      new_string: { type: 'string', description: 'Replacement text (empty to delete).' },
      replace_all: { type: 'boolean', description: 'Replace all matches (default false).' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  permissions: [Permissions.FilesystemWrite],
  async execute(input, ctx) {
    try {
      const p = resolveWorkspacePath(ctx.workspacePath, String(input.path ?? ''));
      if (!existsSync(p)) return fail(`file not found: ${p}`);
      const content = readFileSync(p, 'utf8');
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      const replaceAll = input.replace_all === true;
      const count = content.split(oldStr).length - 1;
      if (count === 0) return fail(`old_string not found in ${p}`);
      if (count > 1 && !replaceAll) return fail(`old_string matches ${count} times; set replace_all: true or be more specific`);
      const next = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
      writeFileSync(p, next, 'utf8');
      return ok(`edited ${p} (${replaceAll ? count : 1} replacement${replaceAll && count !== 1 ? 's' : ''})`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List entries in a workspace directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the workspace (default workspace root).' },
    },
    required: [],
  },
  permissions: [Permissions.FilesystemRead],
  async execute(input, ctx) {
    try {
      const p = resolveWorkspacePath(ctx.workspacePath, String(input.path ?? '.'));
      if (!existsSync(p)) return fail(`directory not found: ${p}`);
      const entries = readdirSync(p).sort().map((name) => {
        const full = join(p, name);
        const isDir = statSync(full).isDirectory();
        return `${isDir ? 'd' : '-'} ${name}`;
      });
      return ok(entries.join('\n') || '(empty)', { entries });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files by glob pattern within the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
    },
    required: ['pattern'],
  },
  permissions: [Permissions.FilesystemRead],
  async execute(input, ctx) {
    try {
      const pattern = String(input.pattern ?? '*');
      const matches = globInDir(ctx.workspacePath, pattern);
      return ok(matches.join('\n') || '(no matches)', { matches });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search file contents in the workspace with a regular expression.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search (default workspace root).' },
    },
    required: ['pattern'],
  },
  permissions: [Permissions.FilesystemRead],
  async execute(input, ctx) {
    try {
      const pattern = new RegExp(String(input.pattern ?? ''), 'g');
      const base = resolveWorkspacePath(ctx.workspacePath, String(input.path ?? '.'));
      const results: string[] = [];
      const files = statSync(base).isDirectory() ? globInDir(base, '**/*') : [base];
      for (const f of files) {
        if (!existsSync(f) || statSync(f).isDirectory()) continue;
        const content = readFileSync(f, 'utf8');
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          if (pattern.test(line)) {
            results.push(`${f}:${i + 1}: ${line.trim()}`);
          }
          pattern.lastIndex = 0;
        });
      }
      return ok(results.slice(0, 250).join('\n') || '(no matches)', { count: results.length });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
};

/** Simple glob matching: `*` (basename), `**` (any depth). */
export function globInDir(root: string, pattern: string): string[] {
  const hasSlash = pattern.includes('/');
  const results: string[] = [];
  const segments = pattern.split('/');
  const re = globToRegExp(pattern);
  walk(root, (p) => {
    const rel = relative(root, p);
    if (re.test(rel) || re.test(p)) results.push(p);
  });
  // If pattern has no slash, match basename at any depth.
  const out = hasSlash ? results : results.filter((p) => basename(p).match(globToRegExp(pattern)));
  return out.sort();
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function walk(dir: string, cb: (p: string) => void, depth = 0): void {
  if (depth > 20) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const p = join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walk(p, cb, depth + 1);
    } else {
      cb(p);
    }
  }
}
