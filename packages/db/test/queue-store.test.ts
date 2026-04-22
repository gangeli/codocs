import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../src/database.js';
import { QueueStore } from '../src/queue-store.js';
import type { Database } from 'sql.js';

/** Minimal CommentEvent-shaped object for testing. */
function makeEvent(overrides?: Record<string, unknown>) {
  return {
    eventType: 'google.workspace.documents.comment.v1.created',
    documentId: 'doc-123',
    comment: {
      id: 'comment-1',
      content: 'Fix this section',
      author: 'alice@example.com',
      quotedText: 'some quoted text',
      mentions: [],
    },
    eventTime: '2026-04-09T12:00:00Z',
    ...overrides,
  };
}

describe('QueueStore', () => {
  let db: Database;
  let store: QueueStore;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    store = new QueueStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('enqueue and peek returns a pending item', () => {
    const event = makeEvent();
    store.enqueue('alice', 'doc-123', event);

    const item = store.peek('alice');
    expect(item).not.toBeNull();
    expect(item!.agentName).toBe('alice');
    expect(item!.documentId).toBe('doc-123');
    expect(item!.status).toBe('pending');
    expect(item!.startedAt).toBeNull();
    expect(item!.completedAt).toBeNull();
    expect(item!.error).toBeNull();
  });

  it('enqueue returns incrementing IDs', () => {
    const id1 = store.enqueue('alice', 'doc-1', makeEvent());
    const id2 = store.enqueue('alice', 'doc-2', makeEvent());
    expect(id2).toBeGreaterThan(id1);
  });

  it('dequeue claims item and sets status to processing', () => {
    store.enqueue('alice', 'doc-123', makeEvent());

    const item = store.dequeue('alice');
    expect(item).not.toBeNull();
    expect(item!.status).toBe('processing');
    expect(item!.startedAt).toBeTruthy();
  });

  it('dequeue returns null on empty queue', () => {
    expect(store.dequeue('alice')).toBeNull();
  });

  it('dequeue returns items in FIFO order', () => {
    const id1 = store.enqueue('alice', 'doc-1', makeEvent({ documentId: 'doc-1' }));
    const id2 = store.enqueue('alice', 'doc-2', makeEvent({ documentId: 'doc-2' }));

    const first = store.dequeue('alice');
    const second = store.dequeue('alice');

    expect(first!.id).toBe(id1);
    expect(second!.id).toBe(id2);
  });

  it('dequeue is scoped to the requested agent', () => {
    store.enqueue('alice', 'doc-1', makeEvent());
    store.enqueue('bob', 'doc-2', makeEvent());

    const item = store.dequeue('alice');
    expect(item).not.toBeNull();
    expect(item!.agentName).toBe('alice');

    // Bob's item is still pending
    expect(store.dequeue('alice')).toBeNull();
    expect(store.dequeue('bob')).not.toBeNull();
  });

  it('dequeue skips already-processing items', () => {
    store.enqueue('alice', 'doc-1', makeEvent());
    store.enqueue('alice', 'doc-2', makeEvent({ documentId: 'doc-2' }));

    // First dequeue claims item 1
    const first = store.dequeue('alice');
    // Second dequeue should get item 2, not item 1 again
    const second = store.dequeue('alice');

    expect(first!.id).not.toBe(second!.id);
    expect(second!.documentId).toBe('doc-2');
  });

  it('isAgentBusy tracks processing state correctly', () => {
    expect(store.isAgentBusy('alice')).toBe(false);

    store.enqueue('alice', 'doc-1', makeEvent());
    expect(store.isAgentBusy('alice')).toBe(false); // pending, not processing

    const item = store.dequeue('alice');
    expect(store.isAgentBusy('alice')).toBe(true);

    store.markCompleted(item!.id);
    expect(store.isAgentBusy('alice')).toBe(false);
  });

  it('markCompleted sets status and completed_at', () => {
    const id = store.enqueue('alice', 'doc-1', makeEvent());
    store.dequeue('alice');
    store.markCompleted(id);

    // Peek should return null (no more pending)
    expect(store.peek('alice')).toBeNull();

    // Verify via raw SQL that status is correct
    const row = db.exec('SELECT status, completed_at FROM agent_queue WHERE id = ?', [id]);
    expect(row[0].values[0][0]).toBe('completed');
    expect(row[0].values[0][1]).toBeTruthy();
  });

  it('markFailed sets status and error message', () => {
    const id = store.enqueue('alice', 'doc-1', makeEvent());
    store.dequeue('alice');
    store.markFailed(id, 'Agent crashed');

    const row = db.exec('SELECT status, error, completed_at FROM agent_queue WHERE id = ?', [id]);
    expect(row[0].values[0][0]).toBe('failed');
    expect(row[0].values[0][1]).toBe('Agent crashed');
    expect(row[0].values[0][2]).toBeTruthy();
  });

  it('pendingCount returns correct count', () => {
    expect(store.pendingCount('alice')).toBe(0);

    store.enqueue('alice', 'doc-1', makeEvent());
    store.enqueue('alice', 'doc-2', makeEvent());
    expect(store.pendingCount('alice')).toBe(2);

    store.dequeue('alice'); // one moves to processing
    expect(store.pendingCount('alice')).toBe(1);
  });

  it('pendingAgents returns distinct agents with pending items', () => {
    store.enqueue('alice', 'doc-1', makeEvent());
    store.enqueue('bob', 'doc-2', makeEvent());
    store.enqueue('alice', 'doc-3', makeEvent());

    const agents = store.pendingAgents();
    expect(agents).toContain('alice');
    expect(agents).toContain('bob');
    expect(agents).toHaveLength(2);
  });

  it('pendingAgents excludes agents with only processing/completed items', () => {
    const id = store.enqueue('alice', 'doc-1', makeEvent());
    store.dequeue('alice'); // now processing
    store.markCompleted(id);

    expect(store.pendingAgents()).toHaveLength(0);
  });

  it('resetAllProcessing moves processing items back to pending', () => {
    store.enqueue('alice', 'doc-1', makeEvent());
    store.enqueue('alice', 'doc-2', makeEvent());
    store.dequeue('alice'); // item 1 -> processing

    const count = store.resetAllProcessing();
    expect(count).toBe(1);

    // Now alice has 2 pending items again
    expect(store.pendingCount('alice')).toBe(2);
    expect(store.isAgentBusy('alice')).toBe(false);
  });

  it('resetAllProcessing does not affect completed or failed items', () => {
    const id1 = store.enqueue('alice', 'doc-1', makeEvent());
    const id2 = store.enqueue('alice', 'doc-2', makeEvent());

    store.dequeue('alice');
    store.markCompleted(id1);
    store.dequeue('alice');
    store.markFailed(id2, 'error');

    const count = store.resetAllProcessing();
    expect(count).toBe(0);
  });

  it('purgeOld removes completed/failed items older than threshold', () => {
    const id = store.enqueue('alice', 'doc-1', makeEvent());
    store.dequeue('alice');
    store.markCompleted(id);

    // Backdate the completed_at to make it old
    db.run(
      "UPDATE agent_queue SET completed_at = datetime('now', '-2 hours') WHERE id = ?",
      [id],
    );

    // Purge items older than 1 hour
    const purged = store.purgeOld(3600);
    expect(purged).toBe(1);
  });

  it('purgeOld keeps pending and processing items regardless of age', () => {
    store.enqueue('alice', 'doc-1', makeEvent());
    // Backdate the created_at
    db.run("UPDATE agent_queue SET created_at = datetime('now', '-2 hours')");

    const purged = store.purgeOld(3600);
    expect(purged).toBe(0);
    expect(store.pendingCount('alice')).toBe(1);
  });

  it('CommentEvent JSON round-trip preserves all fields', () => {
    const event = makeEvent({
      thread: [
        { author: 'alice@example.com', content: 'original comment' },
        { author: 'bob@example.com', content: 'reply' },
      ],
    });

    store.enqueue('alice', 'doc-123', event);
    const item = store.dequeue('alice');

    expect(item!.commentEvent).toEqual(event);
  });
});
