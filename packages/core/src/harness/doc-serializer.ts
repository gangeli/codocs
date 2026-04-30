/**
 * Per-document serializer — guarantees that no two tasks for the same
 * document run concurrently inside a single orchestrator process.
 *
 * Different documents remain fully parallel. The implementation is a
 * simple promise chain per document: each new task awaits the previous
 * task's settlement (success or failure) before running. Used by every
 * code path that can edit a Google Doc — fork-mode comment handling,
 * the legacy per-agent drain queue, and chat-tab message handling —
 * so that a doc never sees overlapping batchUpdate calls or a stale
 * read that races with another agent's merge.
 */
export class DocSerializer {
  private locks = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` serially with respect to other tasks on the same documentId.
   *
   * Returns a promise that resolves to `fn`'s result, or rejects with
   * `fn`'s error. A rejected task does not poison the chain — subsequent
   * tasks for the same document still run.
   */
  run<T>(documentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(documentId) ?? Promise.resolve();
    // Both branches run `fn`, so a rejected predecessor doesn't wedge the chain.
    const next: Promise<T> = prev.then(() => fn(), () => fn());
    this.locks.set(documentId, next);
    // Keep the cleanup chain off the unhandled-rejection path.
    next.catch(() => {}).finally(() => {
      if (this.locks.get(documentId) === next) {
        this.locks.delete(documentId);
      }
    });
    return next;
  }

  /** True if a task is currently scheduled or running for the document. */
  isBusy(documentId: string): boolean {
    return this.locks.has(documentId);
  }
}
