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

  db.run(SCHEMA);

  return db;
}

/**
 * Persist the database to disk. Call this after mutations
 * if you want durability (sql.js operates in-memory).
 */
export function saveDatabase(db: Database, path?: string): void {
  const dbPath = path ?? defaultDbPath();
  const data = db.export();
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, Buffer.from(data));
}
