import type { ToolRegistry } from './registry.js';
import { echoTool } from './echo.js';
import { editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool } from './filesystem.js';
import { terminalTool } from './terminal.js';
import { gitTool } from './git.js';
import { httpTool } from './http.js';

/** Register the core built-in tools. */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.upsert(readFileTool);
  registry.upsert(writeFileTool);
  registry.upsert(editFileTool);
  registry.upsert(listDirTool);
  registry.upsert(globTool);
  registry.upsert(grepTool);
  registry.upsert(terminalTool);
  registry.upsert(gitTool);
  registry.upsert(httpTool);
  registry.upsert(echoTool);
}

export { echoTool };
export * from './registry.js';
export * from './filesystem.js';
export * from './terminal.js';
export * from './git.js';
export * from './http.js';
