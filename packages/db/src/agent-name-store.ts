/**
 * Persistent store for generated agent names.
 *
 * Maps (documentId, role) → agentName so that resuming a document
 * reuses the same cute name instead of generating a new one.
 */

import type { Database } from 'sql.js';

export class AgentNameStore {
  constructor(private db: Database) {}

  /**
   * Get the stored agent name for a given document and role.
   * Returns null if no name has been generated yet.
   */
  getName(documentId: string, role: string): string | null {
    const stmt = this.db.prepare(
      `SELECT agent_name FROM agent_names WHERE document_id = ? AND role = ?`,
    );
    stmt.bind([documentId, role]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();
    return row.agent_name as string;
  }

  /**
   * Store a generated agent name for a document and role.
   * No-ops if a name already exists (first write wins).
   */
  setName(documentId: string, role: string, agentName: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO agent_names (document_id, role, agent_name)
       VALUES (?, ?, ?)`,
      [documentId, role, agentName],
    );
  }

  /**
   * Get or create an agent name for a document and role.
   * Uses the provided generator function if no name exists yet.
   */
  getOrCreate(documentId: string, role: string, generate: () => string): string {
    const existing = this.getName(documentId, role);
    if (existing) return existing;

    const name = generate();
    this.setName(documentId, role, name);
    return name;
  }
}
