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
