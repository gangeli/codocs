/**
 * Per-agent comment queue backed by SQLite.
 *
 * Ensures each agent processes comments one at a time, in order.
 * The queue is persistent so in-flight items survive a process crash.
 */

import type { Database } from 'sql.js';

export interface QueueItem {
  id: number;
  agentName: string;
  documentId: string;
  commentEvent: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export class QueueStore {
  constructor(private db: Database) {}

  /** Add a comment event to the queue. Returns the queue item ID. */
  enqueue(agentName: string, documentId: string, event: unknown): number {
    this.db.run(
      'INSERT INTO agent_queue (agent_name, document_id, comment_event) VALUES (?, ?, ?)',
      [agentName, documentId, JSON.stringify(event)],
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0] as number;
  }

  /**
   * Claim a specific pending row by id (pending -> processing). Returns the
   * row, or null if the id doesn't exist or isn't pending. Used by the
   * fork-per-comment path, which already knows the row it wants to claim.
   */
  markProcessing(id: number): QueueItem | null {
    // sql.js is single-threaded; SELECT + UPDATE is atomic within one call.
    const rows = this.db.exec(
      "SELECT id FROM agent_queue WHERE id = ? AND status = 'pending'",
      [id],
    );
    if (rows.length === 0 || rows[0].values.length === 0) return null;

    this.db.run(
      "UPDATE agent_queue SET status = 'processing', started_at = datetime('now') WHERE id = ?",
      [id],
    );
    return this.getById(id);
  }

  /** Claim the next pending item for the agent (pending -> processing). */
  dequeue(agentName: string): QueueItem | null {
    // sql.js is single-threaded, so SELECT + UPDATE is atomic.
    const rows = this.db.exec(
      "SELECT id FROM agent_queue WHERE agent_name = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
      [agentName],
    );
    if (rows.length === 0 || rows[0].values.length === 0) return null;

    const id = rows[0].values[0][0] as number;
    this.db.run(
      "UPDATE agent_queue SET status = 'processing', started_at = datetime('now') WHERE id = ?",
      [id],
    );
    return this.getById(id);
  }

  /** Peek at the next pending item without claiming it. */
  peek(agentName: string): QueueItem | null {
    const rows = this.db.exec(
      "SELECT * FROM agent_queue WHERE agent_name = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
      [agentName],
    );
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return this.rowToItem(rows[0].columns, rows[0].values[0]);
  }

  /** Mark an item as completed. */
  markCompleted(id: number): void {
    this.db.run(
      "UPDATE agent_queue SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  /** Mark an item as failed with an error message. */
  markFailed(id: number, error: string): void {
    this.db.run(
      "UPDATE agent_queue SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?",
      [error, id],
    );
  }

  /** Check if an agent has any item in 'processing' status. */
  isAgentBusy(agentName: string): boolean {
    const rows = this.db.exec(
      "SELECT 1 FROM agent_queue WHERE agent_name = ? AND status = 'processing' LIMIT 1",
      [agentName],
    );
    return rows.length > 0 && rows[0].values.length > 0;
  }

  /** Count pending items for an agent. */
  pendingCount(agentName: string): number {
    const rows = this.db.exec(
      "SELECT COUNT(*) FROM agent_queue WHERE agent_name = ? AND status = 'pending'",
      [agentName],
    );
    return (rows[0].values[0][0] as number) ?? 0;
  }

  /** Get distinct agent names that have pending items. */
  pendingAgents(): string[] {
    const rows = this.db.exec(
      "SELECT DISTINCT agent_name FROM agent_queue WHERE status = 'pending'",
    );
    if (rows.length === 0) return [];
    return rows[0].values.map((row) => row[0] as string);
  }

  /** Reset 'processing' items back to 'pending' (crash recovery). Returns count reset. */
  resetStaleProcessing(): number {
    this.db.run(
      "UPDATE agent_queue SET status = 'pending', started_at = NULL WHERE status = 'processing'",
    );
    return this.db.getRowsModified();
  }

  /** Remove completed/failed items older than the given age. Returns count removed. */
  purgeOld(olderThanSeconds: number): number {
    this.db.run(
      "DELETE FROM agent_queue WHERE status IN ('completed', 'failed') AND completed_at < datetime('now', '-' || ? || ' seconds')",
      [olderThanSeconds],
    );
    return this.db.getRowsModified();
  }

  private getById(id: number): QueueItem | null {
    const rows = this.db.exec('SELECT * FROM agent_queue WHERE id = ?', [id]);
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return this.rowToItem(rows[0].columns, rows[0].values[0]);
  }

  private rowToItem(columns: string[], values: unknown[]): QueueItem {
    const get = (col: string) => values[columns.indexOf(col)];
    return {
      id: get('id') as number,
      agentName: get('agent_name') as string,
      documentId: get('document_id') as string,
      commentEvent: JSON.parse(get('comment_event') as string),
      status: get('status') as QueueItem['status'],
      createdAt: get('created_at') as string,
      startedAt: (get('started_at') as string) ?? null,
      completedAt: (get('completed_at') as string) ?? null,
      error: (get('error') as string) ?? null,
    };
  }
}
