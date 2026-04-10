/**
 * Tracks code modification tasks: maps Google Doc comment threads
 * to git branches, worktrees, and draft PRs.
 */

import type { Database } from 'sql.js';

export interface CodeTask {
  id: number;
  documentId: string;
  commentId: string;
  agentName: string;
  branchName: string;
  worktreePath: string;
  prNumber: number | null;
  prUrl: string | null;
  baseBranch: string;
  status: 'active' | 'completed';
  createdAt: string;
  updatedAt: string;
}

export class CodeTaskStore {
  constructor(private db: Database) {}

  /** Look up an existing code task for a comment thread. */
  getByComment(documentId: string, commentId: string): CodeTask | null {
    const rows = this.db.exec(
      'SELECT * FROM code_tasks WHERE document_id = ? AND comment_id = ?',
      [documentId, commentId],
    );
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return this.rowToTask(rows[0].columns, rows[0].values[0]);
  }

  /** Create a new code task. Returns the row ID. */
  create(task: {
    documentId: string;
    commentId: string;
    agentName: string;
    branchName: string;
    worktreePath: string;
    baseBranch: string;
  }): number {
    this.db.run(
      `INSERT INTO code_tasks (document_id, comment_id, agent_name, branch_name, worktree_path, base_branch)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [task.documentId, task.commentId, task.agentName, task.branchName, task.worktreePath, task.baseBranch],
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0] as number;
  }

  /** Update PR info after creating a draft PR. */
  updatePR(id: number, prNumber: number, prUrl: string): void {
    this.db.run(
      "UPDATE code_tasks SET pr_number = ?, pr_url = ?, updated_at = datetime('now') WHERE id = ?",
      [prNumber, prUrl, id],
    );
  }

  /** Mark a code task as completed (PR merged/closed). */
  markCompleted(id: number): void {
    this.db.run(
      "UPDATE code_tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  /** Get all active code tasks for an agent. */
  getActiveByAgent(agentName: string): CodeTask[] {
    const rows = this.db.exec(
      "SELECT * FROM code_tasks WHERE agent_name = ? AND status = 'active'",
      [agentName],
    );
    if (rows.length === 0) return [];
    return rows[0].values.map((row) => this.rowToTask(rows[0].columns, row));
  }

  /** Get stale tasks older than the given number of days. */
  getStale(olderThanDays: number): CodeTask[] {
    const rows = this.db.exec(
      "SELECT * FROM code_tasks WHERE status = 'active' AND updated_at < datetime('now', '-' || ? || ' days')",
      [olderThanDays],
    );
    if (rows.length === 0) return [];
    return rows[0].values.map((row) => this.rowToTask(rows[0].columns, row));
  }

  private rowToTask(columns: string[], values: unknown[]): CodeTask {
    const get = (col: string) => values[columns.indexOf(col)];
    return {
      id: get('id') as number,
      documentId: get('document_id') as string,
      commentId: get('comment_id') as string,
      agentName: get('agent_name') as string,
      branchName: get('branch_name') as string,
      worktreePath: get('worktree_path') as string,
      prNumber: (get('pr_number') as number) ?? null,
      prUrl: (get('pr_url') as string) ?? null,
      baseBranch: get('base_branch') as string,
      status: get('status') as CodeTask['status'],
      createdAt: get('created_at') as string,
      updatedAt: get('updated_at') as string,
    };
  }
}
