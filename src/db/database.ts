import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DatabaseOptions {
  path: string;
}

const MIGRATIONS: string[] = [
  // 001 — core tables
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    plugins TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    tool_call_id TEXT,
    name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
  `,
  // 002 — tool calls
  `
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_call_id TEXT,
    name TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    ok INTEGER,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
  `,
  // 003 — predictions/journal (financial plugin persistence)
  `
  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    timeframe TEXT,
    prediction TEXT NOT NULL,
    confidence REAL,
    reasoning TEXT NOT NULL DEFAULT '{}',
    indicators TEXT NOT NULL DEFAULT '{}',
    outcome TEXT,
    plugin TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  `,
  // 004 — providers/plugins/usage metadata
  `
  CREATE TABLE IF NOT EXISTS providers (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    config TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plugins (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    manifest TEXT NOT NULL,
    installed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    tool TEXT,
    latency_ms INTEGER,
    error TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // 005 — intelligence layer: persisted analyses + prediction evaluation
  `
  CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    query TEXT NOT NULL,
    subject TEXT,
    domain TEXT,
    intent TEXT,
    classification TEXT,
    status TEXT,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_analyses_session ON analyses(session_id);
  CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at);
  CREATE TABLE IF NOT EXISTS prediction_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prediction_id INTEGER NOT NULL,
    actual TEXT,
    direction_correct INTEGER,
    target_reached INTEGER,
    magnitude_error REAL,
    evaluated_at TEXT NOT NULL
  );
  `,
];

export class Database {
  private db: DatabaseSync;

  constructor(private options: DatabaseOptions) {
    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new DatabaseSync(options.path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
    let version = row.v;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]!);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString());
        this.db.exec('COMMIT');
        version = i + 1;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  raw(): DatabaseSync {
    return this.db;
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
