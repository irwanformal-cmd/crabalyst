# 🦀 Crabalyst

> **Five crab analysts watching the market so you don't have to.**
> 🇬🇧 English (primary) — 🇮🇩 [Bahasa Indonesia](README.id.md)

A **bilingual (English-first, Indonesian aliases) crypto market-watch agent platform**: a provider-agnostic CLI + plugin system feeding a live market-intelligence layer (whale tracking, technicals, sentiment, macro, risk) through a WebSocket gateway into a real-time web dashboard. Inspired by the workflow of coding agents, but built from scratch with no dependency on any specific agent product.

> **LLM providers are interchangeable brains. Plugins provide capabilities.
> The Agent Runtime orchestrates everything — the Intelligence Layer turns market noise into evidence-backed decisions.**

Use Claude, DeepSeek, Qwen, any OpenAI-compatible API, local models, or your own
custom endpoint — without changing the agent, tools, or plugins. Ask in English **or** Indonesian (`why is BTC dropping?` / `kenapa BTC turun?` both work).

## Market watch

```
  Binance public streams          Intelligence Layer               Web dashboard
  @kline_1m + @aggTrade ──► whale / technical / sentiment ──► WS gateway ──► live charts
  (no API key, read-only)   macro / risk analysts + evidence        + crab office 🦀
```

- **Live 1-minute candles** (Binance public streams, tick-by-tick) + 250ms whale-trade radar, honestly marked when mock/offline.
- **Deterministic intelligence pipeline** (no LLM needed): intent → entities → plan → analysts → evidence graph → decision, with mock-data disclosure in assumptions.
- **Bilingual queries**: English-first keyword taxonomy with Indonesian aliases, so `compare BTC with gold` and `bandingkan BTC dengan gold` resolve identically.

# Agent Platform

A **provider-agnostic cloud agent CLI + plugin platform**. Inspired by the
workflow of coding agents, but built from scratch with no dependency on any
specific agent product.

> **LLM providers are interchangeable brains. Plugins provide capabilities.
> The Agent Runtime orchestrates everything.**

Use Claude, DeepSeek, Qwen, any OpenAI-compatible API, local models, or your own
custom endpoint — without changing the agent, tools, or plugins.

---

## Demo

![Demo](assets/demo-web.gif)

## Architecture

```
                    WEB TERMINAL / CLI (src/cli, web/)
                           │
                           ▼
                 ┌──────────────────────┐
                 │      AGENT CORE      │
                 │  Agent Loop          │
                 │  Context Manager     │
                 │  Tool Registry       │
                 │  Permission System   │
                 │  Session Manager     │
                 │  Skill Manager       │
                 │  Subagent Manager    │
                 │  Hook Engine         │
                 └─────────┬────────────┘
                           │
      ┌────────────────────┼───────────────────────┐
      ▼                    ▼                       ▼
 PROVIDER LAYER      PLUGIN LAYER              RUNTIME
 (src/providers)     (src/plugins, plugins/)   (src/runtime, src/mcp)
 Claude / DeepSeek   MCP / Skills /            Shell / Filesystem
 Qwen / OpenAI       Commands / Agents /       DB (SQLite) / WebSocket
 Custom API          Hooks / Tools
```

Key boundaries:

- `src/types` — shared interfaces (no implementation).
- `src/providers` — `LLMProvider` implementations; the core never imports a
  specific vendor.
- `src/core` — agent loop, context manager, event bus, runtime assembler.
- `src/tools` — universal tool registry + filesystem/terminal/git/http tools.
- `src/plugins`, `src/skills`, `src/agents`, `src/commands`, `src/hooks` —
  extensibility subsystems.
- `src/mcp` — MCP (Model Context Protocol) client/manager.
- `src/sessions`, `src/db` — persistence behind repository interfaces.
- `src/cli`, `src/ws`, `web/` — CLI and WebSocket gateway/web UI clients.
- `plugins/` — example plugins (financial-analysis, gamedev), isolated from core.

---

## Quick start

Requires **Node.js >= 22.5** (uses the built-in `node:sqlite` and `fetch`).

```bash
pnpm install
pnpm test           # run the test suite (100 tests)
pnpm typecheck      # strict TypeScript check
pnpm build          # compile to dist/

# Run the CLI
node bin/agent.mjs --help
node bin/agent.mjs providers
node bin/agent.mjs plugins
node bin/agent.mjs run "inspect this repository"

# Start the WebSocket gateway + web UI
node bin/agent.mjs serve --port 8080
# open http://127.0.0.1:8080
```

The default configuration ships a **mock provider** (no API key needed), so the
agent loop works fully offline.

---

## Provider configuration

Providers live in `~/.agent/config.yaml` (or project `.agent/config.yaml`).
The `providers` list is the source of truth:

```yaml
providers:
  - name: deepseek
    kind: openai-compatible
    base_url: https://api.deepseek.com/v1
    api_key_env: DEEPSEEK_API_KEY
    model: deepseek-chat

  - name: qwen
    kind: openai-compatible
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api_key_env: DASHSCOPE_API_KEY
    model: qwen-plus

  - name: claude
    kind: anthropic
    api_key_env: ANTHROPIC_API_KEY
    model: claude-sonnet-4-5

  - name: my-provider
    kind: openai-compatible
    base_url: https://example.com/v1
    api_key_env: MY_API_KEY
    model: my-model
```

Supported kinds: `openai-compatible` (OpenAI, DeepSeek, Qwen, custom), `anthropic`, `mock`.

CLI management:

```bash
agent provider add <name> <kind> <base_url> <model> [api_key_env]
agent provider list
agent provider use deepseek
agent provider remove my-provider
```

Switching providers never changes plugins or agent logic.

---

## Plugin development

A plugin is a directory with a `manifest.yaml` and optional `entry.ts`:

```text
my-plugin/
├── manifest.yaml
├── entry.ts        # tools, hooks, commands (executable)
├── skills/
│   └── foo/SKILL.md
├── agents/
│   └── foo.md
```

`manifest.yaml`:

```yaml
name: my-plugin
version: 1.0.0
description: ...
permissions: [network, filesystem.read]
tools: [my_tool]
skills: [foo]
agents: [foo]
commands: [scan]
hooks: [after-log]
entry: entry.ts
```

`entry.ts` exports a `PluginModule` (`default` export or named `tools`/`hooks`/`commands`):

```ts
import type { PluginModule } from '../../src/types/plugin.js';

const entry: PluginModule = {
  tools: {
    my_tool: {
      description: '...',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissions: ['network'],
      async execute(input, ctx) {
        return { ok: true, output: 'done', data: input };
      },
    },
  },
  commands: {
    scan: async (args) => `scanned ${args}`,
  },
};
export default entry;
```

Plugin directories are discovered from `plugins/` (bundled), `~/.agent/plugins/`,
and any `pluginDirs` in config. Plugins never modify core code.

---

## Configuration hierarchy

Precedence (later wins):

```
defaults
  ↓
global  (~/.agent/config.yaml)
  ↓
project (.agent/config.yaml, AGENT.md)
  ↓
plugin
  ↓
agent override
  ↓
session
```

`AGENT.md` at the project root is injected as project instructions.

---

## Testing

```bash
pnpm test
```

100 tests cover: provider abstraction, provider switching (same plugin/workflow
on Provider A vs B), tool registry, permissions, plugin loading, MCP integration,
skills, subagents, hooks, sessions (SQLite persistence), context manager,
financial indicators, backtesting, and the bilingual intelligence layer
(intent classification, entity resolution, planning, crypto workflows).

---

## Known limitations

- **Provider live calls are not exercised in CI** — providers are verified with
  the deterministic `mock` provider and unit-level message conversion; live
  Anthropic/OpenAI streaming is implemented but requires real API keys.
- **Plugin isolation is process-level, not sandbox-level.** Plugin `entry.ts`
  runs in-process; treat plugins as trusted code. A permission model gates tool
  execution, but does not sandbox plugin code itself.
- **Market data / sentiment / macro providers are `mock` implementations**
  behind swappable interfaces (`MarketDataProvider`, sentiment/macro stubs).
- **Remote cloud workspace** is an abstraction + WebSocket gateway for the local
  runtime; actual remote-workspace execution (containers) is a stub interface,
  not yet implemented.
- **Browser tool** is declared but not yet implemented (HTTP tool is available).
- **No live trade execution** by design — the financial plugin is analytical only.

## Recommended next steps

1. Add live provider integration tests behind `*_API_KEY` env vars.
2. Implement a real market-data provider (e.g. Binance/Yahoo) behind
   `MarketDataProvider`.
3. Add the browser tool and container/remote-workspace execution.
4. Move the WebSocket gateway behind auth and add multi-session isolation.
5. Publish plugin bundles so compiled `dist/` loads compiled plugin JS.

---

## Contributors

Thanks to everyone who builds with this project! 🙏

<a href="https://github.com/irwanformal-cmd">
  <img src="https://github.com/irwanformal-cmd.png?size=100" width="50" height="50" style="border-radius:50%" alt="irwanformal-cmd" />
</a>

**[@irwanformal-cmd](https://github.com/irwanformal-cmd)** — creator & maintainer
