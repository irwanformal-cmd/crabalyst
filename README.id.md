# 🦀 Crabalyst

> **Lima analis kepiting yang mengawasi pasar agar kamu tidak perlu.**
> 🇮🇩 Bahasa Indonesia — 🇬🇧 [English (utama)](README.md)

**Platform agen pemantau pasar kripto dwibahasa (Inggris utama, alias Indonesia)**: CLI + sistem plugin yang agnostik terhadap provider, dihubungkan ke lapisan market-intelligence live (pelacakan whale, teknikal, sentimen, makro, risiko) melalui WebSocket gateway ke dashboard web real-time. Terinspirasi alur kerja coding agent, tetapi dibangun dari nol tanpa ketergantungan pada produk agen tertentu.

> **Provider LLM hanyalah otak yang bisa diganti. Plugin menyediakan kemampuan.
> Agent Runtime mengatur semuanya — Intelligence Layer mengubah noise pasar menjadi keputusan berbasis bukti.**

Gunakan Claude, DeepSeek, Qwen, API apa pun yang kompatibel dengan OpenAI, model lokal, atau endpoint kustom — tanpa mengubah agen, tools, atau plugin. Bertanya bisa dalam bahasa Inggris **atau** Indonesia (`why is BTC dropping?` / `kenapa BTC turun?` sama-sama bisa).

## Pemantau pasar

```
  Stream publik Binance           Intelligence Layer              Dashboard web
  @kline_1m + @aggTrade ──► analis whale / teknikal / sentimen ──► WS gateway ──► chart live
  (tanpa API key, read-only)  makro / risiko + evidence graph       + kantor kepiting 🦀
```

- **Candle live 1 menit** (stream publik Binance, tick-by-tick) + radar trade whale tiap 250ms, ditandai jujur saat mock/offline.
- **Pipeline intelijen deterministik** (tanpa LLM pun jalan): intent → entitas → rencana → analis → evidence graph → keputusan, dengan pengungkapan data mock di asumsi.
- **Query dwibahasa**: taksonomi keyword Inggris-utama dengan alias Indonesia, sehingga `compare BTC with gold` dan `bandingkan BTC dengan gold` menghasilkan resolusi yang sama.

## Arsitektur

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

Batasan utama:

- `src/types` — interface bersama (tanpa implementasi).
- `src/providers` — implementasi `LLMProvider`; core tidak pernah mengimpor vendor tertentu.
- `src/core` — agent loop, context manager, event bus, perakit runtime.
- `src/tools` — registry tool universal + tools filesystem/terminal/git/http.
- `src/plugins`, `src/skills`, `src/agents`, `src/commands`, `src/hooks` — subsistem ekstensibilitas.
- `src/mcp` — klien/manajer MCP (Model Context Protocol).
- `src/sessions`, `src/db` — persistensi di balik interface repository.
- `src/cli`, `src/ws`, `web/` — klien CLI dan WebSocket gateway/UI web.
- `plugins/` — plugin contoh (financial-analysis, gamedev), terisolasi dari core.

## Mulai cepat

Butuh **Node.js >= 22.5** (menggunakan `node:sqlite` dan `fetch` bawaan).

```bash
pnpm install
pnpm test           # jalankan test suite (100 tests)
pnpm typecheck      # cek TypeScript strict
pnpm build          # kompilasi ke dist/

# Jalankan CLI
node bin/agent.mjs --help
node bin/agent.mjs providers
node bin/agent.mjs plugins
node bin/agent.mjs run "inspect this repository"

# Jalankan WebSocket gateway + UI web
node bin/agent.mjs serve --port 8080
# buka http://127.0.0.1:8080
```

Konfigurasi bawaan memakai **mock provider** (tanpa API key), sehingga agent loop
berfungsi penuh secara offline.

## Konfigurasi provider

Provider tinggal di `~/.agent/config.yaml` (atau `.agent/config.yaml` level proyek).
Daftar `providers` adalah sumber kebenaran:

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
```

Jenis yang didukung: `openai-compatible` (OpenAI, DeepSeek, Qwen, kustom), `anthropic`, `mock`.

Manajemen CLI:

```bash
agent provider add <name> <kind> <base_url> <model> [api_key_env]
agent provider list
agent provider use deepseek
agent provider remove my-provider
```

Ganti provider tidak pernah mengubah plugin atau logika agen.

## Pengembangan plugin

Plugin adalah direktori berisi `manifest.yaml` dan opsional `entry.ts`:

```text
my-plugin/
├── manifest.yaml
├── entry.ts        # tools, hooks, commands (eksekutabel)
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

Direktori plugin ditemukan dari `plugins/` (bawaan), `~/.agent/plugins/`,
dan `pluginDirs` mana pun di config. Plugin tidak pernah mengubah kode core.

## Hirarki konfigurasi

Prioritas (yang belakangan menang):

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

`AGENT.md` di root proyek disuntikkan sebagai instruksi proyek.

## Pengujian

```bash
pnpm test
```

100 tests mencakup: abstraksi provider, switching provider (plugin/alur kerja sama
di Provider A vs B), registry tool, permission, loading plugin, integrasi MCP,
skills, subagent, hooks, session (persistensi SQLite), context manager,
indikator finansial, backtesting, dan intelligence layer dwibahasa
(klasifikasi intent, resolusi entitas, planning, alur kerja kripto).

## Keterbatasan yang diketahui

- **Panggilan live provider tidak diuji di CI** — provider diverifikasi dengan
  provider `mock` yang deterministik dan konversi pesan level unit; streaming
  Anthropic/OpenAI live sudah diimplementasikan tetapi butuh API key asli.
- **Isolasi plugin setara proses, bukan sandbox.** `entry.ts` plugin berjalan
  in-process; perlakukan plugin sebagai kode tepercaya. Model permission mengatur
  eksekusi tool, tetapi tidak men-sandbox kode plugin itu sendiri.
- **Provider data pasar / sentimen / makro adalah implementasi `mock`**
  di balik interface yang bisa diganti (`MarketDataProvider`, stub sentimen/makro).
- **Remote cloud workspace** adalah abstraksi + WebSocket gateway untuk runtime
  lokal; eksekusi remote-workspace aktual (kontainer) masih interface stub,
  belum diimplementasikan.
- **Browser tool** dideklarasikan tetapi belum diimplementasikan (HTTP tool tersedia).
- **Tanpa eksekusi trade live** memang disengaja — plugin finansial hanya analitis.

## Lisensi

MIT — lihat [LICENSE](LICENSE).
