import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  session_id?: string;
  agent_id?: string;
  provider?: string;
  model?: string;
  tool?: string;
  latency_ms?: number;
  tokens?: unknown;
  [key: string]: unknown;
}

const REDACT_KEYS = new Set([
  'api_key', 'apikey', 'api-key', 'authorization', 'token', 'secret',
  'password', 'passwd', 'api_key_env',
]);

/**
 * Structured logger that never writes secrets. A redaction pass scrubs known
 * secret-bearing keys and common secret shapes (e.g. `sk-...`).
 */
export class Logger {
  private minLevel: LogLevel = 'info';
  private logDir?: string;
  private redactPatterns: RegExp[] = [];

  constructor(private name = 'agent') {}

  configure(opts?: { level?: LogLevel; dir?: string; redact?: string[] }) {
    if (opts?.level) this.minLevel = opts.level;
    if (opts?.dir) {
      this.logDir = opts.dir;
      mkdirSync(this.logDir, { recursive: true });
    }
    const extra = opts?.redact ?? [];
    this.redactPatterns = [
      /(sk-[A-Za-z0-9_-]{8,})/g,
      /(Bearer\s+[A-Za-z0-9._-]+)/gi,
      /(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      ...extra.map((k) => new RegExp(String(k), 'gi')),
    ];
  }

  setLevel(level: LogLevel) {
    this.minLevel = level;
  }

  debug(msg: string, fields?: Record<string, unknown>) { this.write('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>) { this.write('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>) { this.write('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>) { this.write('error', msg, fields); }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      message: this.redact(message),
      ...this.scrub(fields ?? {}),
    };
    const line = JSON.stringify(entry);
    // Structured logs go to stderr so stdout stays reserved for command output.
    console.error(line);
    if (this.logDir) {
      try {
        appendFileSync(join(this.logDir, `${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
      } catch {
        /* logging must never crash the agent */
      }
    }
  }

  private redact(value: string): string {
    let out = value;
    for (const re of this.redactPatterns) out = out.replace(re, '[REDACTED]');
    return out;
  }

  private scrub(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      if (REDACT_KEYS.has(lower) || this.redactPatterns.some((re) => re.test(k))) {
        out[k] = '[REDACTED]';
        continue;
      }
      if (typeof v === 'string') out[k] = this.redact(v);
      else out[k] = v;
    }
    return out;
  }
}
