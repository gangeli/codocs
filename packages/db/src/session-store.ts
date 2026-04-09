/**
 * CRUD operations for agent session mappings in SQLite.
 */

import type { Database } from 'sql.js';

export interface SessionMapping {
  agentName: string;
  documentId: string;
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export class SessionStore {
  constructor(private db: Database) {}

  getSession(agentName: string, documentId: string): SessionMapping | null {
    const stmt = this.db.prepare(
      `SELECT agent_name, document_id, session_id, created_at, last_used_at
       FROM agent_sessions
       WHERE agent_name = ? AND document_id = ?`,
    );
    stmt.bind([agentName, documentId]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();

    return {
      agentName: row.agent_name as string,
      documentId: row.document_id as string,
      sessionId: row.session_id as string,
      createdAt: row.created_at as string,
      lastUsedAt: row.last_used_at as string,
    };
  }

  upsertSession(agentName: string, documentId: string, sessionId: string): void {
    this.db.run(
      `INSERT INTO agent_sessions (agent_name, document_id, session_id)
       VALUES (?, ?, ?)
       ON CONFLICT (agent_name, document_id)
       DO UPDATE SET session_id = excluded.session_id, last_used_at = datetime('now')`,
      [agentName, documentId, sessionId],
    );
  }

  touchSession(agentName: string, documentId: string): void {
    this.db.run(
      `UPDATE agent_sessions SET last_used_at = datetime('now')
       WHERE agent_name = ? AND document_id = ?`,
      [agentName, documentId],
    );
  }

  deleteSession(agentName: string, documentId: string): void {
    this.db.run(
      `DELETE FROM agent_sessions WHERE agent_name = ? AND document_id = ?`,
      [agentName, documentId],
    );
  }
}
