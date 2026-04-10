import type { Database } from 'sql.js';

/**
 * Persists TUI settings per working directory.
 * Values are stored as JSON strings.
 */
export class SettingsStore {
  constructor(private db: Database) {}

  get(directory: string, key: string): string | null {
    const stmt = this.db.prepare(
      'SELECT value FROM settings WHERE directory = ? AND key = ?',
    );
    stmt.bind([directory, key]);
    if (stmt.step()) {
      const value = stmt.getAsObject().value as string;
      stmt.free();
      return value;
    }
    stmt.free();
    return null;
  }

  set(directory: string, key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (directory, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (directory, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [directory, key, value],
    );
  }

  /** Get all settings for a directory as a key-value map. */
  getAll(directory: string): Record<string, string> {
    const stmt = this.db.prepare(
      'SELECT key, value FROM settings WHERE directory = ?',
    );
    stmt.bind([directory]);
    const result: Record<string, string> = {};
    while (stmt.step()) {
      const row = stmt.getAsObject() as { key: string; value: string };
      result[row.key] = row.value;
    }
    stmt.free();
    return result;
  }

  /** Persist a full settings object (each top-level key stored separately). */
  saveAll<T extends object>(directory: string, settings: T): void {
    for (const [key, value] of Object.entries(settings)) {
      this.set(directory, key, JSON.stringify(value));
    }
  }

  /** Load a full settings object, merging with defaults. */
  loadAll<T extends object>(directory: string, defaults: T): T {
    const stored = this.getAll(directory);
    const result = { ...defaults };
    for (const [key, jsonValue] of Object.entries(stored)) {
      if (key in defaults) {
        try {
          (result as any)[key] = JSON.parse(jsonValue);
        } catch {
          // Ignore corrupt values, keep default
        }
      }
    }
    return result;
  }
}
