/**
 * SQLite database connection for codocs session storage.
 *
 * Default path: ~/.local/share/codocs/sessions.db
 * Respects XDG_DATA_HOME environment variable.
 */

import initSqlJs, { type Database } from 'sql.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

export type { Database } from 'sql.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_sessions (
    agent_name     TEXT NOT NULL,
    document_id    TEXT NOT NULL,
    session_id     TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_name, document_id)
  );

  CREATE TABLE IF NOT EXISTS agent_names (
    document_id    TEXT NOT NULL,
    role           TEXT NOT NULL,
    agent_name     TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, role)
  );

  CREATE TABLE IF NOT EXISTS agent_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name    TEXT NOT NULL,
    document_id   TEXT NOT NULL,
    comment_event TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT,
    completed_at  TEXT,
    error         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_queue_agent_status
    ON agent_queue (agent_name, status, created_at);

  CREATE TABLE IF NOT EXISTS settings (
    directory     TEXT NOT NULL,
    key           TEXT NOT NULL,
    value         TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (directory, key)
  );

  CREATE TABLE IF NOT EXISTS code_tasks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id    TEXT NOT NULL,
    comment_id     TEXT NOT NULL,
    agent_name     TEXT NOT NULL,
    branch_name    TEXT NOT NULL,
    worktree_path  TEXT NOT NULL,
    pr_number      INTEGER,
    pr_url         TEXT,
    base_branch    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (document_id, comment_id)
  );

  CREATE INDEX IF NOT EXISTS idx_code_tasks_lookup
    ON code_tasks (document_id, comment_id);

  CREATE TABLE IF NOT EXISTS mermaid_mappings (
    document_id    TEXT NOT NULL,
    source_hash    TEXT NOT NULL,
    mermaid_source TEXT NOT NULL,
    drive_file_id  TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, source_hash)
  );

  CREATE TABLE IF NOT EXISTS chat_tabs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id       TEXT NOT NULL,
    tab_id            TEXT NOT NULL,
    title             TEXT NOT NULL,
    agent_name        TEXT NOT NULL,
    source_comment_id TEXT,
    active_comment_id TEXT,
    status            TEXT NOT NULL DEFAULT 'active',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (document_id, tab_id)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_tabs_document
    ON chat_tabs (document_id, status);

  CREATE INDEX IF NOT EXISTS idx_chat_tabs_active_comment
    ON chat_tabs (active_comment_id);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_tab_id     INTEGER NOT NULL REFERENCES chat_tabs(id),
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_tab
    ON chat_messages (chat_tab_id, created_at);

  CREATE TABLE IF NOT EXISTS codocs_sessions (
    id             TEXT PRIMARY KEY,
    directory      TEXT NOT NULL,
    doc_ids        TEXT NOT NULL,
    doc_title      TEXT,
    agent_type     TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_codocs_sessions_directory
    ON codocs_sessions (directory, last_used_at DESC);
`;

function getDataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'codocs');
}

function defaultDbPath(): string {
  return join(getDataDir(), 'sessions.db');
}

/**
 * Open (or create) the SQLite database and run migrations.
 *
 * @param path - Override the default database path. Use ':memory:' for in-memory (tests).
 */
export async function openDatabase(path?: string): Promise<Database> {
  const dbPath = path ?? defaultDbPath();

  const SQL = await initSqlJs();

  let db: Database;
  if (dbPath !== ':memory:' && existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);

  // Additive migration: drive_file_id was added after the initial release.
  // CREATE TABLE IF NOT EXISTS leaves an existing table's columns untouched,
  // so an ALTER is needed for older databases. Must run before any index
  // that references the column.
  try {
    db.run('ALTER TABLE mermaid_mappings ADD COLUMN drive_file_id TEXT');
  } catch {
    // Already added — ignore.
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_mermaid_mappings_file
      ON mermaid_mappings (document_id, drive_file_id);
  `);

  return db;
}

/**
 * Persist the database to disk. Call this after mutations
 * if you want durability (sql.js operates in-memory).
 */
export function saveDatabase(db: Database, path?: string): void {
  const dbPath = path ?? defaultDbPath();
  if (dbPath === ':memory:') return;
  const data = db.export();
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, Buffer.from(data));
}
