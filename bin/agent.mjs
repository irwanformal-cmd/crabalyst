#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Use tsx to run the TypeScript CLI entry point.
const tsxCli = require.resolve('tsx/cli');
const cliEntry = `${__dirname}/../src/cli/main.ts`;
execFileSync(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], { stdio: 'inherit' });