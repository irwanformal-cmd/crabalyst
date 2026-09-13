import { createInterface } from 'node:readline';
import { AgentRuntime } from '../core/runtime.js';
import { color, symbols, banner } from './ui.js';
import type { Approver, PermissionDecision } from '../types/permissions.js';

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`agent ${VERSION} — provider-agnostic cloud agent CLI

Usage:
  agent                                   Start the interactive REPL
  agent run "<prompt>"                    Run a single instruction
  agent -p "<prompt>"                     Alias for run
  agent analyze "<question>"              Run the Intelligence Layer (structured AnalysisResult)
  agent provider list|add|use|remove      Manage LLM providers
  agent session list|create|resume|delete Manage sessions
  agent plugins|agents|skills|tools       Inspect platform capabilities
  agent serve [--port 8080]               Start the WebSocket gateway + web UI
  agent --help                            Show this help
`);
}

/** Interactive approver: prompts on TTY, fails closed otherwise. */
function createApprover(): Approver {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return async (req): Promise<PermissionDecision> => {
    if (!process.stdin.isTTY) {
      return { allowed: false, reason: 'no interactive approver available' };
    }
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(
        `\n${color.yellow('⚠ allow')} ${req.description} ${color.dim('(y/N)')} `,
        (a) => resolvePromise(a.trim().toLowerCase()),
      );
    });
    return answer === 'y' || answer === 'yes' ? { allowed: true } : { allowed: false, reason: 'declined by user' };
  };
}

async function runWithEvents(runtime: AgentRuntime, prompt: string, opts: { sessionId?: string } = {}) {
  // Wire structured events to a compact streaming display.
  const unsubscribe = runtime.events.subscribe((ev) => {
    switch (ev.type) {
      case 'planning':
        process.stdout.write(`${color.cyan('Planning...')}\n`);
        break;
      case 'tool_call':
        process.stdout.write(`${symbols.arrow} ${color.blue(ev.name)} ${color.dim(JSON.stringify(ev.input).slice(0, 120))}\n`);
        break;
      case 'tool_result':
        process.stdout.write(`  ${ev.ok ? symbols.check : color.red('✗')} ${ev.name} ${color.dim(ev.output.split('\n')[0]?.slice(0, 80) ?? '')}\n`);
        break;
      case 'reflection':
        if (ev.text.trim()) process.stdout.write(`\n${color.gray(ev.text)}\n`);
        break;
      case 'completion':
        process.stdout.write(`\n${color.green(symbols.check)} done\n`);
        break;
      case 'error':
        process.stdout.write(`${color.red('error:')} ${ev.message}\n`);
        break;
    }
  });

  try {
    const res = await runtime.dispatch(prompt, opts);
    return res;
  } finally {
    unsubscribe();
  }
}

async function repl(runtime: AgentRuntime): Promise<void> {
  console.log(
    banner('Agent Platform', [
      `Provider: ${runtime.providers.active().id}`,
      `Workspace: ${runtime.workspace}`,
      `Plugins: ${runtime.plugins.list().length}`,
    ]),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.question(`${color.cyan('> ')} `, async (input) => {
    const trimmed = input.trim();
    if (!trimmed) return prompt();
    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit') {
      console.log('bye');
      rl.close();
      await runtime.shutdown();
      return;
    }
    try {
      const res = await runWithEvents(runtime, trimmed);
      if (!res.ok) console.log(color.red('run failed'));
    } catch (err) {
      console.log(color.red(`error: ${(err as Error).message}`));
    }
    prompt();
  });
  prompt();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return;
  }

  // `serve` runs without an interactive approver (web gateway owns prompts).
  if (cmd === 'serve') {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? Number(args[portIdx + 1] ?? 8080) : 8080;
    const { serve } = await import('../ws/gateway.js');
    await serve({ port });
    return;
  }

  const runtime = new AgentRuntime();
  runtime.setApprover(createApprover());
  await runtime.start();

  try {
    if (!cmd || cmd === 'repl') {
      await repl(runtime);
      return;
    }

    if (cmd === 'analyze') {
      const promptText = args.slice(1).join(' ');
      if (!promptText) {
        console.log(color.red('missing query'));
        process.exitCode = 1;
        return;
      }
      const events = collectAnalysisEvents(runtime);
      const result = await runtime.analyze(promptText);
      events.off();
      printAnalysis(result);
      if (result.status === 'error') process.exitCode = 1;
      return;
    }

    if (cmd === 'run' || cmd === '-p' || cmd === '--prompt') {
      const promptText = cmd === 'run' || cmd === '-p' || cmd === '--prompt' ? args.slice(1).join(' ') : '';
      if (!promptText) {
        console.log(color.red('missing prompt'));
        process.exitCode = 1;
        return;
      }
      const res = await runWithEvents(runtime, promptText);
      if (!res.ok) process.exitCode = 1;
      return;
    }

    if (cmd === 'provider') {
      await handleProvider(runtime, args.slice(1));
      return;
    }

    if (cmd === 'session') {
      await handleSession(runtime, args.slice(1));
      return;
    }

    switch (cmd) {
      case 'plugins':
        console.log((runtime.commands.get('plugins')!.handler('', { workspacePath: runtime.workspace, runtime }) as string));
        break;
      case 'providers':
        console.log(runtime.listProviders().map((p) => `${p.active ? '* ' : '  '}${p.id} (${p.model})`).join('\n'));
        break;
      case 'agents':
        console.log((runtime.commands.get('agents')!.handler('', { workspacePath: runtime.workspace, runtime }) as string));
        break;
      case 'skills':
        console.log((runtime.commands.get('skills')!.handler('', { workspacePath: runtime.workspace, runtime }) as string));
        break;
      case 'tools':
        console.log(runtime.tools.list().map((t) => `${t.name} — ${t.description}`).join('\n'));
        break;
      default:
        console.log(color.red(`unknown command "${cmd}"`));
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== 'repl' && cmd) await runtime.shutdown();
  }
}

/** Stream analysis activity steps to the terminal. */
function collectAnalysisEvents(runtime: AgentRuntime) {
  const off = runtime.events.subscribe((ev) => {
    if (ev.type === 'analysis_step') {
      const mark = ev.step.status === 'done' ? color.green(symbols.check) : ev.step.status === 'failed' ? color.red('✗') : ev.step.status === 'running' ? color.yellow('…') : '·';
      process.stdout.write(`${mark} ${ev.step.label}${ev.step.detail ? color.dim(` — ${ev.step.detail}`) : ''}\n`);
    }
  });
  return { off };
}

/** Compact CLI rendering of a structured AnalysisResult. */
function printAnalysis(result: import('../intelligence/types.js').AnalysisResult): void {
  const d = result.decision;
  console.log(`\n${color.cyan('ANALYSIS')} ${result.subject ?? ''} ${color.dim(`[${result.plan.workflow}]`)} status=${result.status}`);
  if (d) {
    console.log(`${color.yellow(d.classification.toUpperCase())}${d.confidence !== undefined ? ` (${Math.round(d.confidence * 100)}%)` : ''} — ${d.decision}`);
    console.log(color.dim(`evidence: ${d.breakdown.evidenceStrength} · data: ${d.breakdown.dataQuality}`));
  }
  for (const f of result.findings.slice(0, 6)) {
    console.log(`  • ${f.title}`);
  }
  if (result.anomalies.length) console.log(color.red(`  ⚠ ${result.anomalies.length} anomalies`));
  if (result.forecast) console.log(color.dim(`  forecast: ${result.forecast.method} (${result.forecast.horizon}) — model estimate`));
  console.log(color.dim(`  analysts: ${result.analysts.filter((a) => a.ok).map((a) => a.analystId).join(', ')}`));
  console.log(color.dim(`  evidence items: ${result.evidence.length} · visualizations: ${result.visualizations.map((v) => v.type).join(', ')}`));
}

async function handleProvider(runtime: AgentRuntime, args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'list':
      console.log(runtime.listProviders().map((p) => `${p.active ? '* ' : '  '}${p.id} (${p.model})`).join('\n'));
      break;
    case 'use': {
      const id = args[1];
      if (!id) { console.log(color.red('usage: agent provider use <name>')); process.exitCode = 1; return; }
      try {
        runtime.useProvider(id);
        console.log(`${symbols.check} using provider ${id}`);
      } catch (err) {
        console.log(color.red((err as Error).message));
        process.exitCode = 1;
      }
      break;
    }
    case 'remove': {
      const id = args[1];
      if (!id) { console.log(color.red('usage: agent provider remove <name>')); process.exitCode = 1; return; }
      await runtime.removeProvider(id);
      console.log(`${symbols.check} removed ${id}`);
      break;
    }
    case 'add': {
      // `agent provider add <name> <kind> <base_url> <model> [api_key_env]`
      const [name, kind, base_url, model, api_key_env] = args.slice(1);
      if (!name || !kind || !model) {
        console.log(color.red('usage: agent provider add <name> <kind> <base_url> <model> [api_key_env]'));
        process.exitCode = 1;
        return;
      }
      await runtime.addProvider({ name, kind, base_url, model, api_key_env });
      console.log(`${symbols.check} added provider ${name}`);
      break;
    }
    default:
      console.log(color.red('usage: agent provider list|add|use|remove'));
      process.exitCode = 1;
  }
}

async function handleSession(runtime: AgentRuntime, args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'list':
      console.log((await runtime.listSessions()).map((s) => `${s.id}  ${s.title}  (${s.providerId}/${s.model})`).join('\n') || 'no sessions');
      break;
    case 'create': {
      const title = args.slice(1).join(' ') || 'session';
      const s = await runtime.createSession(title);
      console.log(`${symbols.check} created ${s.id}`);
      break;
    }
    case 'resume': {
      const id = args[1];
      if (!id) { console.log(color.red('usage: agent session resume <id>')); process.exitCode = 1; return; }
      const s = await runtime.resumeSession(id);
      console.log(`${symbols.check} resumed ${s.id} (${s.title})`);
      break;
    }
    case 'delete': {
      const id = args[1];
      if (!id) { console.log(color.red('usage: agent session delete <id>')); process.exitCode = 1; return; }
      await runtime.deleteSession(id);
      console.log(`${symbols.check} deleted ${id}`);
      break;
    }
    default:
      console.log(color.red('usage: agent session list|create|resume|delete'));
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(color.red(`fatal: ${(err as Error).message}`));
  process.exitCode = 1;
});
