import type { AgentNameStore } from '@codocs/db';

/**
 * Build a fallback-agent resolver that gives each comment thread its own
 * generated agent name. Replies on the same thread (sharing `commentId`)
 * resolve to the same name because the underlying store is keyed by
 * `(documentId, role)`. When `commentId` is absent the resolver falls
 * back to a single per-document slot.
 */
export function makeFallbackAgentResolver(
  store: AgentNameStore,
  generate: () => string,
): (documentId: string, commentId?: string) => string {
  return (documentId, commentId) => {
    const role = commentId ? `comment:${commentId}` : 'fallback';
    return store.getOrCreate(documentId, role, generate);
  };
}
