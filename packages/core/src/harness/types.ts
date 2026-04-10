/**
 * Types used by the harness that may be implemented by external packages.
 * This avoids @codocs/core depending on @codocs/db directly.
 */

/** Session mapping returned by the session store. */
export interface SessionMapping {
  agentName: string;
  documentId: string;
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

/** Interface for session storage. Implemented by @codocs/db SessionStore. */
export interface SessionStore {
  getSession(agentName: string, documentId: string): SessionMapping | null;
  upsertSession(agentName: string, documentId: string, sessionId: string): void;
  touchSession(agentName: string, documentId: string): void;
  deleteSession(agentName: string, documentId: string): void;
}

/** A single item in the per-agent comment queue. */
export interface QueueItem {
  id: number;
  agentName: string;
  documentId: string;
  /** The full CommentEvent, deserialized from JSON storage. */
  commentEvent: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

/** Interface for the per-agent comment queue. Implemented by @codocs/db QueueStore. */
export interface QueueStore {
  /** Add a comment event to the queue. Returns the queue item ID. */
  enqueue(agentName: string, documentId: string, event: unknown): number;
  /** Claim the next pending item for the agent (pending -> processing). */
  dequeue(agentName: string): QueueItem | null;
  /** Peek at the next pending item without claiming it. */
  peek(agentName: string): QueueItem | null;
  /** Mark an item as completed. */
  markCompleted(id: number): void;
  /** Mark an item as failed with an error message. */
  markFailed(id: number, error: string): void;
  /** Check if an agent has any item in 'processing' status. */
  isAgentBusy(agentName: string): boolean;
  /** Count pending items for an agent. */
  pendingCount(agentName: string): number;
  /** Get distinct agent names that have pending items. */
  pendingAgents(): string[];
  /** Reset 'processing' items back to 'pending' (crash recovery). Returns count reset. */
  resetStaleProcessing(): number;
  /** Remove completed/failed items older than the given age. Returns count removed. */
  purgeOld(olderThanSeconds: number): number;
}
