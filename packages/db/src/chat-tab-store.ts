/**
 * Tracks chat tab sessions: maps Google Doc tabs to chat conversations
 * with message history.
 */

import type { Database } from 'sql.js';

export interface ChatTab {
  id: number;
  documentId: string;
  tabId: string;
  title: string;
  agentName: string;
  sourceCommentId: string | null;
  activeCommentId: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  chatTabId: number;
  role: 'user' | 'agent' | 'system';
  content: string;
  createdAt: string;
}

export class ChatTabStore {
  constructor(private db: Database) {}

  /** Create a new chat tab record. Returns the row ID. */
  create(tab: {
    documentId: string;
    tabId: string;
    title: string;
    agentName: string;
    sourceCommentId?: string;
  }): number {
    this.db.run(
      `INSERT INTO chat_tabs (document_id, tab_id, title, agent_name, source_comment_id)
       VALUES (?, ?, ?, ?, ?)`,
      [tab.documentId, tab.tabId, tab.title, tab.agentName, tab.sourceCommentId ?? null],
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0] as number;
  }

  /** Look up a chat tab by document and tab ID. */
  getByTab(documentId: string, tabId: string): ChatTab | null {
    const rows = this.db.exec(
      'SELECT * FROM chat_tabs WHERE document_id = ? AND tab_id = ?',
      [documentId, tabId],
    );
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return this.rowToTab(rows[0].columns, rows[0].values[0]);
  }

  /** Find a chat tab by its active input comment ID. */
  getByActiveComment(commentId: string): ChatTab | null {
    const rows = this.db.exec(
      'SELECT * FROM chat_tabs WHERE active_comment_id = ?',
      [commentId],
    );
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return this.rowToTab(rows[0].columns, rows[0].values[0]);
  }

  /** Find a chat tab that was forked from a specific source comment. */
  getBySourceComment(documentId: string, commentId: string): ChatTab | null {
    const rows = this.db.exec(
      'SELECT * FROM chat_tabs WHERE document_id = ? AND source_comment_id = ?',
      [documentId, commentId],
    );
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return this.rowToTab(rows[0].columns, rows[0].values[0]);
  }

  /** Get all active chat tabs for a document. */
  getActiveByDocument(documentId: string): ChatTab[] {
    const rows = this.db.exec(
      "SELECT * FROM chat_tabs WHERE document_id = ? AND status = 'active' ORDER BY created_at DESC",
      [documentId],
    );
    if (rows.length === 0) return [];
    return rows[0].values.map((row) => this.rowToTab(rows[0].columns, row));
  }

  /** Update the active input comment ID for a chat tab. */
  updateActiveComment(id: number, commentId: string): void {
    this.db.run(
      "UPDATE chat_tabs SET active_comment_id = ?, updated_at = datetime('now') WHERE id = ?",
      [commentId, id],
    );
  }

  /** Archive (soft-close) a chat tab. */
  archive(id: number): void {
    this.db.run(
      "UPDATE chat_tabs SET status = 'archived', updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  // ── Message operations ──────────────────────────────────────────

  /** Append a message to the chat history. Returns the message ID. */
  addMessage(chatTabId: number, role: ChatMessage['role'], content: string): number {
    this.db.run(
      'INSERT INTO chat_messages (chat_tab_id, role, content) VALUES (?, ?, ?)',
      [chatTabId, role, content],
    );
    // Also touch the chat tab's updated_at
    this.db.run(
      "UPDATE chat_tabs SET updated_at = datetime('now') WHERE id = ?",
      [chatTabId],
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0] as number;
  }

  /** Get chat messages in chronological order, optionally limited. */
  getMessages(chatTabId: number, limit?: number): ChatMessage[] {
    const sql = limit
      ? 'SELECT * FROM chat_messages WHERE chat_tab_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT * FROM chat_messages WHERE chat_tab_id = ? ORDER BY created_at ASC';
    const params = limit ? [chatTabId, limit] : [chatTabId];
    const rows = this.db.exec(sql, params);
    if (rows.length === 0) return [];
    return rows[0].values.map((row) => this.rowToMessage(rows[0].columns, row));
  }

  // ── Row mappers ─────────────────────────────────────────────────

  private rowToTab(columns: string[], values: unknown[]): ChatTab {
    const get = (col: string) => values[columns.indexOf(col)];
    return {
      id: get('id') as number,
      documentId: get('document_id') as string,
      tabId: get('tab_id') as string,
      title: get('title') as string,
      agentName: get('agent_name') as string,
      sourceCommentId: (get('source_comment_id') as string) ?? null,
      activeCommentId: (get('active_comment_id') as string) ?? null,
      status: get('status') as ChatTab['status'],
      createdAt: get('created_at') as string,
      updatedAt: get('updated_at') as string,
    };
  }

  private rowToMessage(columns: string[], values: unknown[]): ChatMessage {
    const get = (col: string) => values[columns.indexOf(col)];
    return {
      id: get('id') as number,
      chatTabId: get('chat_tab_id') as number,
      role: get('role') as ChatMessage['role'],
      content: get('content') as string,
      createdAt: get('created_at') as string,
    };
  }
}
