import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase, SessionStore, QueueStore } from '@codocs/db';
import type { Database } from 'sql.js';
import type { AgentRunner, AgentRunResult, AgentRunOptions } from '../../src/harness/agent.js';
import type { CommentEvent } from '../../src/types.js';
import { AgentOrchestrator } from '../../src/harness/orchestrator.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeEvent(overrides?: Partial<CommentEvent>): CommentEvent {
  return {
    eventType: 'google.workspace.documents.comment.v1.created',
    documentId: 'doc-123',
    comment: {
      id: 'comment-1',
      content: 'Fix this section',
      author: 'user@example.com',
      quotedText: 'Hello World',
      mentions: [],
    },
    eventTime: '2026-04-09T12:00:00Z',
    ...overrides,
  };
}

function makeResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    exitCode: 0,
    stdout: 'Done',
    stderr: '',
    ...overrides,
  };
}

/** Minimal Google Doc with some text. */
function makeDoc(text: string) {
  return {
    body: {
      content: [
        {
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 1 + text.length,
                textRun: { content: text },
              },
            ],
          },
        },
      ],
    },
  };
}

/**
 * Creates a mock runner where each `run()` call returns a promise
 * the test can resolve manually. This lets us control timing for
 * concurrency tests.
 */
function createControllableRunner() {
  const calls: Array<{
    prompt: string;
    sessionId: string | null;
    resolve: (r: AgentRunResult) => void;
    reject: (err: Error) => void;
  }> = [];

  const runner: AgentRunner = {
    name: 'test',
    run: vi.fn((prompt: string, sessionId: string | null, _opts?: AgentRunOptions) => {
      return new Promise<AgentRunResult>((resolve, reject) => {
        calls.push({ prompt, sessionId, resolve, reject });
      });
    }),
    getActiveProcesses: () => [],
    killAll: () => [],
    getCapabilities: () => ({ supportsSessionResume: false, models: [], harnessSettings: [], supportsPermissionMode: false }),
  };

  return { runner, calls };
}

/** Creates a mock CodocsClient with the minimum methods the orchestrator uses. */
function createMockClient(docText = 'Hello World') {
  const doc = makeDoc(docText);
  return {
    getDocument: vi.fn().mockResolvedValue(doc),
    getAttributions: vi.fn().mockResolvedValue([
      {
        agentName: 'alice',
        namedRangeId: 'range-1',
        ranges: [{ startIndex: 1, endIndex: 1 + docText.length }],
        text: docText,
      },
    ]),
    replyToComment: vi.fn().mockResolvedValue('reply-1'),
    updateReply: vi.fn().mockResolvedValue(undefined),
    batchUpdate: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('AgentOrchestrator queue integration', () => {
  let db: Database;
  let sessionStore: SessionStore;
  let queueStore: QueueStore;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    sessionStore = new SessionStore(db);
    queueStore = new QueueStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('processes a single comment normally', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
    });

    const handlePromise = orchestrator.handleComment(makeEvent());

    // Wait for the agent to be called
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(makeResult());

    const result = await handlePromise;
    expect(result.agentName).toBe('alice');
    expect(result.editSummary).not.toBe('Queued');
  });

  it('serializes two comments for the same agent', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
    });

    // Fire two comments concurrently
    const p1 = orchestrator.handleComment(makeEvent({ comment: { id: 'c1', content: 'First', mentions: [] } }));
    const p2 = orchestrator.handleComment(makeEvent({ comment: { id: 'c2', content: 'Second', mentions: [] } }));

    // Only the first should be running
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].prompt).toContain('First');

    // Second should report as queued
    const result2 = await p2;
    expect(result2.editSummary).toBe('Queued');

    // Resolve first call
    calls[0].resolve(makeResult());
    await p1;

    // Now the second should start
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].prompt).toContain('Second');
    calls[1].resolve(makeResult());

    // Queue should be drained
    await vi.waitFor(() => expect(queueStore.pendingCount('alice')).toBe(0));
    expect(queueStore.isAgentBusy('alice')).toBe(false);
  });

  it('runs two comments for different agents in parallel', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();

    // Return different attributions per document so they get different agents
    client.getAttributions.mockImplementation(async (docId: string) => {
      const agentName = docId === 'doc-alice' ? 'alice' : 'bob';
      return [{
        agentName,
        namedRangeId: `range-${agentName}`,
        ranges: [{ startIndex: 1, endIndex: 12 }],
        text: 'Hello World',
      }];
    });

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
    });

    orchestrator.handleComment(makeEvent({
      documentId: 'doc-alice',
      comment: { id: 'c1', content: 'For Alice', quotedText: 'Hello World', mentions: [] },
    }));
    orchestrator.handleComment(makeEvent({
      documentId: 'doc-bob',
      comment: { id: 'c2', content: 'For Bob', quotedText: 'Hello World', mentions: [] },
    }));

    // Both should be running in parallel
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    calls[0].resolve(makeResult());
    calls[1].resolve(makeResult());
  });

  it('queued item gets fresh document state', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient('Hello World');

    let getDocCallCount = 0;
    client.getDocument.mockImplementation(async () => {
      getDocCallCount++;
      // After the first comment processes, the doc has changed
      if (getDocCallCount <= 2) return makeDoc('Hello World');
      return makeDoc('Hello World Updated');
    });

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
    });

    orchestrator.handleComment(makeEvent({ comment: { id: 'c1', content: 'First', mentions: [] } }));
    orchestrator.handleComment(makeEvent({ comment: { id: 'c2', content: 'Second', mentions: [] } }));

    // First comment starts
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(makeResult());

    // Second comment starts — it should fetch the document again
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(makeResult());

    // getDocument should have been called for both comments independently
    // (at least 2 calls for first comment's processing + at least 1 for second)
    await vi.waitFor(() => expect(client.getDocument.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('session carries over within a comment thread', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
    });

    const sessionId = 'session-persistent';

    // First comment on thread
    orchestrator.handleComment(makeEvent({
      comment: { id: 'thread-1', content: 'First message', mentions: [] },
    }));

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // First call has no session (new thread)
    expect(calls[0].sessionId).toBeNull();
    calls[0].resolve(makeResult({ sessionId }));

    // Second comment on same thread (queued, then processed)
    orchestrator.handleComment(makeEvent({
      comment: { id: 'thread-1', content: 'Follow up', mentions: [] },
      thread: [
        { author: 'user@example.com', content: 'First message' },
        { author: 'user@example.com', content: 'Follow up' },
      ],
    }));

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // Second call should resume the session from the first
    expect(calls[1].sessionId).toBe(sessionId);
    calls[1].resolve(makeResult({ sessionId }));
  });

  it('agent failure marks item as failed and continues to next', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
    });

    orchestrator.handleComment(makeEvent({ comment: { id: 'c1', content: 'Will fail', mentions: [] } }));
    orchestrator.handleComment(makeEvent({ comment: { id: 'c2', content: 'Will succeed', mentions: [] } }));

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // First agent call fails
    calls[0].reject(new Error('Agent crashed'));

    // Second should still start
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(makeResult());

    // Wait for drain to complete
    await vi.waitFor(() => expect(queueStore.isAgentBusy('alice')).toBe(false));

    // Check that the failed item is marked in the DB
    const rows = db.exec("SELECT status, error FROM agent_queue WHERE id = 1");
    expect(rows[0].values[0][0]).toBe('failed');
    expect(rows[0].values[0][1]).toContain('Agent crashed');
  });

  it('handleComment returns Queued for second concurrent call', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
    });

    const p1 = orchestrator.handleComment(makeEvent({ comment: { id: 'c1', content: 'First', quotedText: 'Hello World', mentions: [] } }));
    const p2 = orchestrator.handleComment(makeEvent({ comment: { id: 'c2', content: 'Second', quotedText: 'Hello World', mentions: [] } }));

    // p2 should resolve immediately with 'Queued'
    const result2 = await p2;
    expect(result2.editSummary).toBe('Queued');
    expect(result2.agentName).toBe('alice');

    // Clean up
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(makeResult());
    await p1;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(makeResult());
  });

  it('recoverQueue resets stale items and drains them', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();

    // Simulate a crash: insert items directly into the queue
    queueStore.enqueue('alice', 'doc-123', makeEvent({ comment: { id: 'c1', content: 'Stale', mentions: [] } }));
    queueStore.dequeue('alice'); // mark as processing (simulating in-flight when crash happened)
    queueStore.enqueue('alice', 'doc-123', makeEvent({ comment: { id: 'c2', content: 'Pending', mentions: [] } }));

    expect(queueStore.isAgentBusy('alice')).toBe(true);
    expect(queueStore.pendingCount('alice')).toBe(1);

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
    });

    // Recover should reset stale processing and drain
    await orchestrator.recoverQueue();

    // Both items should now be processing sequentially
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(makeResult());

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(makeResult());

    await vi.waitFor(() => {
      expect(queueStore.pendingCount('alice')).toBe(0);
      expect(queueStore.isAgentBusy('alice')).toBe(false);
    });
  });

  it('fires onIdle after all agents finish processing', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();
    const onIdle = vi.fn();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
      onIdle,
      idleDebounceMs: 50,
    });

    orchestrator.handleComment(makeEvent({ comment: { id: 'c1', content: 'Do it', mentions: [] } }));

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(makeResult());

    // Wait for drain to complete + debounce
    await vi.waitFor(() => expect(onIdle).toHaveBeenCalledTimes(1), { timeout: 1000 });
    orchestrator.cancelIdleCheck();
  });

  it('does not fire onIdle on startup when nothing has happened', async () => {
    const { runner } = createControllableRunner();
    const client = createMockClient();
    const onIdle = vi.fn();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
      onIdle,
      idleDebounceMs: 10,
    });

    // Wait a bit — onIdle should not fire on a fresh orchestrator
    await new Promise((r) => setTimeout(r, 50));
    expect(onIdle).not.toHaveBeenCalled();
    orchestrator.cancelIdleCheck();
  });

  it('does not double-fire onIdle without a new busy cycle', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();
    const onIdle = vi.fn();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
      onIdle,
      idleDebounceMs: 50,
    });

    orchestrator.handleComment(makeEvent({ comment: { id: 'c1', content: 'First', mentions: [] } }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(makeResult());

    // Wait for onIdle to fire
    await vi.waitFor(() => expect(onIdle).toHaveBeenCalledTimes(1), { timeout: 1000 });

    // Wait more — should not fire again
    await new Promise((r) => setTimeout(r, 100));
    expect(onIdle).toHaveBeenCalledTimes(1);
    orchestrator.cancelIdleCheck();
  });

  it('fires onIdle again after a second busy→idle cycle', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();
    const onIdle = vi.fn();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
      onIdle,
      idleDebounceMs: 50,
    });

    // First cycle
    orchestrator.handleComment(makeEvent({ comment: { id: 'c1', content: 'First', mentions: [] } }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(makeResult());
    await vi.waitFor(() => expect(onIdle).toHaveBeenCalledTimes(1), { timeout: 1000 });

    // Second cycle
    orchestrator.handleComment(makeEvent({ comment: { id: 'c2', content: 'Second', mentions: [] } }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(makeResult());
    await vi.waitFor(() => expect(onIdle).toHaveBeenCalledTimes(2), { timeout: 1000 });
    orchestrator.cancelIdleCheck();
  });

  it('cancelIdleCheck prevents pending idle callback from firing', async () => {
    const { runner, calls } = createControllableRunner();
    const client = createMockClient();
    const onIdle = vi.fn();

    const orchestrator = new AgentOrchestrator({
      client: client as any,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'fallback',
      onIdle,
      idleDebounceMs: 200,
    });

    orchestrator.handleComment(makeEvent({ comment: { id: 'c1', content: 'Work', mentions: [] } }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(makeResult());
    await vi.waitFor(() => expect(queueStore.isAgentBusy('alice')).toBe(false));

    // Cancel before debounce fires
    orchestrator.cancelIdleCheck();
    await new Promise((r) => setTimeout(r, 400));
    expect(onIdle).not.toHaveBeenCalled();
  });
});
