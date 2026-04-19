/**
 * Tracks reply IDs that codocs itself has posted.
 *
 * When codocs posts replies using the user's own OAuth credentials (no
 * service account configured), its replies are indistinguishable from the
 * user's by author alone — same display name, same email. Without this
 * tracker the listener would re-process those replies as fresh human
 * comments, triggering an infinite self-reply loop.
 *
 * The tracker is an in-process LRU set: bounded memory, trivially cheap
 * lookups. After a crash-and-restart the tracker is empty, so a reply
 * posted before the crash may still trigger one extra handle — but the
 * loop cannot sustain because the new reply's ID will then be tracked.
 */
export class ReplyTracker {
  private readonly ids: Set<string> = new Set();
  private readonly order: string[] = [];
  private readonly cap: number;

  constructor(cap: number = 1000) {
    this.cap = cap;
  }

  add(id: string | null | undefined): void {
    if (!id || this.ids.has(id)) return;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > this.cap) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.ids.delete(evicted);
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }
}
