import type { Database } from 'sql.js';

export interface CodocsSession {
  id: string;
  directory: string;
  docIds: string[];
  docTitle: string | null;
  agentType: string;
  createdAt: string;
  lastUsedAt: string;
}

export class CodocsSessionStore {
  constructor(private db: Database) {}

  private generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  private rowToSession(row: Record<string, unknown>): CodocsSession {
    return {
      id: row.id as string,
      directory: row.directory as string,
      docIds: JSON.parse(row.doc_ids as string),
      docTitle: (row.doc_title as string) ?? null,
      agentType: row.agent_type as string,
      createdAt: row.created_at as string,
      lastUsedAt: row.last_used_at as string,
    };
  }

  /**
   * Create or update a session. If the same directory + doc IDs combo exists,
   * reuse that session (update last_used_at and agent_type).
   */
  upsert(directory: string, docIds: string[], agentType: string, docTitle?: string): CodocsSession {
    const docIdsJson = JSON.stringify(docIds.slice().sort());

    // Check for existing session with same directory + doc IDs
    const stmt = this.db.prepare(
      `SELECT * FROM codocs_sessions WHERE directory = ? AND doc_ids = ?`,
    );
    stmt.bind([directory, docIdsJson]);

    if (stmt.step()) {
      const existing = this.rowToSession(stmt.getAsObject());
      stmt.free();

      // Update last_used_at and agent_type
      this.db.run(
        `UPDATE codocs_sessions
         SET last_used_at = datetime('now'), agent_type = ?
         WHERE id = ?`,
        [agentType, existing.id],
      );

      return { ...existing, agentType, lastUsedAt: new Date().toISOString() };
    }
    stmt.free();

    // Create new session
    const id = this.generateId();
    this.db.run(
      `INSERT INTO codocs_sessions (id, directory, doc_ids, doc_title, agent_type)
       VALUES (?, ?, ?, ?, ?)`,
      [id, directory, docIdsJson, docTitle ?? null, agentType],
    );

    return {
      id,
      directory,
      docIds,
      docTitle: docTitle ?? null,
      agentType,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
  }

  get(id: string): CodocsSession | null {
    const stmt = this.db.prepare(
      `SELECT * FROM codocs_sessions WHERE id = ?`,
    );
    stmt.bind([id]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const session = this.rowToSession(stmt.getAsObject());
    stmt.free();
    return session;
  }

  listByDirectory(directory: string, limit = 5): CodocsSession[] {
    const stmt = this.db.prepare(
      `SELECT * FROM codocs_sessions
       WHERE directory = ?
       ORDER BY last_used_at DESC
       LIMIT ?`,
    );
    stmt.bind([directory, limit]);

    const results: CodocsSession[] = [];
    while (stmt.step()) {
      results.push(this.rowToSession(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  /** List every session, newest first. Used by repair/health checks. */
  listAll(): CodocsSession[] {
    const stmt = this.db.prepare(
      `SELECT * FROM codocs_sessions ORDER BY last_used_at DESC`,
    );
    const results: CodocsSession[] = [];
    while (stmt.step()) {
      results.push(this.rowToSession(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  setDocTitle(id: string, title: string): void {
    this.db.run(
      `UPDATE codocs_sessions SET doc_title = ? WHERE id = ?`,
      [title, id],
    );
  }

  /** Replace the doc ID list on a session. */
  setDocIds(id: string, docIds: string[]): void {
    const docIdsJson = JSON.stringify(docIds.slice().sort());
    this.db.run(
      `UPDATE codocs_sessions SET doc_ids = ? WHERE id = ?`,
      [docIdsJson, id],
    );
  }

  /** Delete a session permanently. Returns true if a row was deleted. */
  delete(id: string): boolean {
    this.db.run(`DELETE FROM codocs_sessions WHERE id = ?`, [id]);
    return this.db.getRowsModified() > 0;
  }
}
