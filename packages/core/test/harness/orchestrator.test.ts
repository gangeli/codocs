import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentOrchestrator } from '../../src/harness/orchestrator.js';
import { ReplyTracker } from '../../src/events/reply-tracker.js';
import { classifyComment } from '../../src/events/classify.js';
import type { CommentEvent } from '../../src/types.js';
import type { AgentRunner, AgentRunResult, ActiveAgent } from '../../src/harness/agent.js';
import type { SessionStore, SessionMapping } from '../../src/harness/types.js';
import type { CodocsClient } from '../../src/client/index.js';
import { openDatabase, QueueStore } from '@codocs/db';
import type { Database } from 'sql.js';

/** Track all calls made to mocks in order. */
interface CallLog {
  method: string;
  args: any[];
}

function createMockClient(callLog: CallLog[], opts?: { canAccess?: boolean }): CodocsClient {
  return {
    getDocument: vi.fn(async (docId: string) => {
      callLog.push({ method: 'getDocument', args: [docId] });
      return {
        body: {
          content: [
            {
              startIndex: 1,
              endIndex: 20,
              paragraph: {
                elements: [{ startIndex: 1, endIndex: 20, textRun: { content: 'Hello World content' } }],
              },
            },
          ],
        },
      };
    }),
    getAttributions: vi.fn(async () => {
      callLog.push({ method: 'getAttributions', args: [] });
      return [];
    }),
    readMarkdown: vi.fn(async () => '# Test\n\nHello World content\n'),
    writeMarkdown: vi.fn(async () => {}),
    addComment: vi.fn(async () => 'comment-1'),
    replyToComment: vi.fn(async (docId: string, commentId: string, content: string) => {
      callLog.push({ method: 'replyToComment', args: [docId, commentId, content] });
      return 'reply-123';
    }),
    updateReply: vi.fn(async (docId: string, commentId: string, replyId: string, content: string) => {
      callLog.push({ method: 'updateReply', args: [docId, commentId, replyId, content] });
    }),
    batchUpdate: vi.fn(async () => {
      callLog.push({ method: 'batchUpdate', args: [] });
    }),
    ensureShared: vi.fn(async () => {}),
    removePermission: vi.fn(async () => {}),
    canAccess: vi.fn(async () => opts?.canAccess ?? true),
  } as unknown as CodocsClient;
}

function createMockReplyClient(callLog: CallLog[]): CodocsClient {
  return {
    replyToComment: vi.fn(async (docId: string, commentId: string, content: string) => {
      callLog.push({ method: 'reply:replyToComment', args: [docId, commentId, content] });
      return 'thinking-reply-456';
    }),
    updateReply: vi.fn(async (docId: string, commentId: string, replyId: string, content: string) => {
      callLog.push({ method: 'reply:updateReply', args: [docId, commentId, replyId, content] });
    }),
    deleteReply: vi.fn(async (docId: string, commentId: string, replyId: string) => {
      callLog.push({ method: 'reply:deleteReply', args: [docId, commentId, replyId] });
    }),
  } as unknown as CodocsClient;
}

function createMockRunner(callLog: CallLog[], stdout = 'Agent response text'): AgentRunner {
  return {
    name: 'mock',
    run: vi.fn(async (prompt: string, sessionId: string | null, opts?: any) => {
      callLog.push({ method: 'agentRun', args: [sessionId ? 'resume' : 'new', opts] });
      return {
        sessionId: sessionId ?? 'new-session-id',
        exitCode: 0,
        stdout,
        stderr: '',
      };
    }),
    getActiveProcesses: () => [],
    killAll: () => [],
    getCapabilities: () => ({
      supportsSessionResume: false,
      supportsSessionFork: false,
      models: [],
      harnessSettings: [],
      supportsPermissionMode: false,
    }),
  };
}

function createMockSessionStore(): SessionStore {
  const store = new Map<string, SessionMapping>();
  return {
    getSession: (agent, doc) => store.get(`${agent}:${doc}`) ?? null,
    upsertSession: (agent, doc, sessionId) => {
      store.set(`${agent}:${doc}`, {
        agentName: agent,
        documentId: doc,
        sessionId,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
    },
    touchSession: () => {},
    deleteSession: (agent, doc) => { store.delete(`${agent}:${doc}`); },
  };
}

function makeCommentEvent(overrides?: Partial<CommentEvent>): CommentEvent {
  return {
    eventType: 'google.workspace.drive.comment.v3.created',
    documentId: 'doc-123',
    comment: {
      id: 'comment-abc',
      content: 'Please fix this section',
      author: 'user@example.com',
      quotedText: 'Hello World',
      createdTime: new Date().toISOString(),
      mentions: [],
    },
    eventTime: new Date().toISOString(),
    ...overrides,
  };
}


/** Wait for async queue drain. */
const drain = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe('AgentOrchestrator E2E', () => {
  let callLog: CallLog[];
  let db: Database;
  let queueStore: QueueStore;
  // Track every orchestrator so we can cancel their idle-debounce timers
  // before db.close(). Otherwise the 3s setTimeout scheduled by
  // checkIdle() fires across test boundaries and hits a closed sql.js db.
  let orchestrators: AgentOrchestrator[];

  function createOrchestrator(config: ConstructorParameters<typeof AgentOrchestrator>[0]): AgentOrchestrator {
    const o = new AgentOrchestrator(config);
    orchestrators.push(o);
    return o;
  }

  beforeEach(async () => {
    callLog = [];
    orchestrators = [];
    db = await openDatabase(':memory:');
    queueStore = new QueueStore(db);
  });

  afterEach(() => {
    for (const o of orchestrators) o.cancelIdleCheck();
    db.close();
  });

  it('posts thinking emoji, runs agent, then updates the thinking reply', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog, 'Here is my response');

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    // Verify the call sequence
    const methods = callLog.map((c) => c.method);

    // 1. Should fetch document + attributions first
    expect(methods).toContain('getDocument');
    expect(methods).toContain('getAttributions');

    // 2. Should post thinking emoji via replyClient
    const thinkingCall = callLog.find(
      (c) => c.method === 'reply:replyToComment' && c.args[2] === '\u{1F914}',
    );
    expect(thinkingCall).toBeDefined();

    // 3. Should run the agent
    expect(methods).toContain('agentRun');

    // 4. Should delete the thinking reply and post a new one with the response
    const deleteCall = callLog.find((c) => c.method === 'reply:deleteReply');
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.args[2]).toBe('thinking-reply-456'); // the thinking reply ID

    const finalReply = callLog.filter((c) => c.method === 'reply:replyToComment');
    expect(finalReply.length).toBe(2); // thinking emoji + final response
    expect(finalReply[1].args[2]).toBe('Here is my response');

    // 5. Thinking emoji should come BEFORE agent run
    const thinkingIdx = callLog.indexOf(thinkingCall!);
    const agentIdx = callLog.findIndex((c) => c.method === 'agentRun');
    expect(thinkingIdx).toBeLessThan(agentIdx);

    // 6. Delete + re-post should come AFTER agent run
    const deleteIdx = callLog.indexOf(deleteCall!);
    expect(deleteIdx).toBeGreaterThan(agentIdx);
  });

  it('updates thinking reply with error message when agent fails', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const failingRunner: AgentRunner = {
      name: 'mock',
      run: vi.fn(async () => { throw new Error('agent crashed'); }),
      getActiveProcesses: () => [],
      killAll: () => [],
      getCapabilities: () => ({ supportsSessionResume: false, supportsSessionFork: false, models: [], harnessSettings: [], supportsPermissionMode: false }),
    };

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: failingRunner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    // Thinking reply should be deleted and replaced with error message
    const deleteCall = callLog.find((c) => c.method === 'reply:deleteReply');
    expect(deleteCall).toBeDefined();

    const replyCalls = callLog.filter((c) => c.method === 'reply:replyToComment');
    expect(replyCalls.length).toBe(2); // thinking emoji + error
    expect(replyCalls[1].args[2]).toContain('Error');
    expect(replyCalls[1].args[2]).toContain('agent crashed');
  });

  it('still posts reply when deleteReply fails', async () => {
    const client = createMockClient(callLog);
    const replyClient = {
      replyToComment: vi.fn(async (docId: string, commentId: string, content: string) => {
        callLog.push({ method: 'reply:replyToComment', args: [docId, commentId, content] });
        return 'thinking-reply-456';
      }),
      deleteReply: vi.fn(async () => {
        throw new Error('delete not allowed');
      }),
    } as unknown as CodocsClient;

    const runner = createMockRunner(callLog, 'My response');
    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    // Even though delete failed, the final reply should still be posted
    const replyCalls = callLog.filter((c) => c.method === 'reply:replyToComment');
    expect(replyCalls.length).toBe(2); // thinking emoji + final reply
    expect(replyCalls[1].args[2]).toBe('My response');
  });

  it('skips comments with no content', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog);

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    const event = makeCommentEvent();
    event.comment.content = '';

    const result = await orchestrator.handleComment(event);

    expect(result.editSummary).toBe('No content');
    // No thinking emoji should be posted
    expect(callLog.filter((c) => c.method === 'reply:replyToComment')).toHaveLength(0);
    // No agent should run
    expect(callLog.filter((c) => c.method === 'agentRun')).toHaveLength(0);
  });

  it('uses default message when agent produces no stdout', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog, ''); // empty stdout

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    // Should delete thinking reply and post default message, not empty string
    const replyCalls = callLog.filter((c) => c.method === 'reply:replyToComment');
    expect(replyCalls.length).toBe(2); // thinking emoji + default message
    expect(replyCalls[1].args[2]).toMatch(/Done|no changes/i);
    expect(replyCalls[1].args[2].length).toBeGreaterThan(0);
  });

  it('includes thread history in prompt for replies', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    let capturedPrompt = '';
    const runner: AgentRunner = {
      name: 'mock',
      run: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        callLog.push({ method: 'agentRun', args: ['new'] });
        return { sessionId: 'sess-1', exitCode: 0, stdout: 'response', stderr: '' };
      }),
      getActiveProcesses: () => [],
      killAll: () => [],
      getCapabilities: () => ({ supportsSessionResume: false, supportsSessionFork: false, models: [], harnessSettings: [], supportsPermissionMode: false }),
    };

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    const event = makeCommentEvent({
      thread: [
        { author: 'user@example.com', content: 'Please fix this', createdTime: '2024-01-01' },
        { author: 'bot@example.com', content: 'Done, fixed it', createdTime: '2024-01-02' },
        { author: 'user@example.com', content: 'Actually, change it back', createdTime: '2024-01-03' },
      ],
    });
    event.comment.content = 'Actually, change it back';

    await orchestrator.handleComment(event);
    await orchestrator.waitForIdle();

    // Prompt should contain thread history
    expect(capturedPrompt).toContain('ongoing conversation');
    expect(capturedPrompt).toContain('Please fix this');
    expect(capturedPrompt).toContain('Done, fixed it');
    expect(capturedPrompt).toContain('Actually, change it back');
  });

  it('resumes existing session for the same comment thread', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog, 'response');
    const sessionStore = createMockSessionStore();

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore,
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    // First comment
    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();
    const firstRunCall = callLog.find((c) => c.method === 'agentRun');
    expect(firstRunCall!.args[0]).toBe('new'); // new session

    callLog.length = 0;

    // Second comment on same thread — should resume
    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();
    const secondRunCall = callLog.find((c) => c.method === 'agentRun');
    expect(secondRunCall!.args[0]).toBe('resume'); // resumed session
  });

  it('passes model to agent runner when configured', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog);

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
      model: 'sonnet',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    const agentCall = callLog.find((c) => c.method === 'agentRun');
    expect(agentCall).toBeDefined();
    expect(agentCall!.args[1]).toHaveProperty('model', 'sonnet');
  });

  it('passes model from a callback to agent runner', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog);

    let currentModel: string | undefined = 'haiku';
    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
      model: () => currentModel,
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    const agentCall = callLog.find((c) => c.method === 'agentRun');
    expect(agentCall!.args[1]).toHaveProperty('model', 'haiku');
  });

  it('does not pass model when not configured', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog);

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    const agentCall = callLog.find((c) => c.method === 'agentRun');
    expect(agentCall!.args[1]).toHaveProperty('model', undefined);
  });

  it('skips reply when user has lost access to the document', async () => {
    const client = createMockClient(callLog, { canAccess: false });
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog);

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    // Should NOT post any reply or run the agent
    const replyMethods = callLog.filter((c) => c.method.startsWith('reply:'));
    expect(replyMethods).toHaveLength(0);

    const agentCalls = callLog.filter((c) => c.method === 'agentRun');
    expect(agentCalls).toHaveLength(0);
  });

  it('does not check access when replyClient is the same as client', async () => {
    const client = createMockClient(callLog, { canAccess: false });
    const runner = createMockRunner(callLog, 'response');

    // No separate replyClient — client is used for both
    const orchestrator = createOrchestrator({
      client,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    // canAccess should not have been called since replyClient === client
    expect((client.canAccess as any)).not.toHaveBeenCalled();

    // Agent should still run
    const agentCalls = callLog.filter((c) => c.method === 'agentRun');
    expect(agentCalls).toHaveLength(1);
  });

  // Regression: while a previous comment is still processing, a newly queued
  // comment should still get a thinking-emoji reply so the user sees the
  // system has picked it up. Previously the emoji was only posted when the
  // agent actually started the item, leaving queued items visually unackd.
  it('posts a thinking emoji for a comment that is queued behind another', async () => {
    const client = createMockClient(callLog);
    let replyCounter = 0;
    const replyClient = {
      replyToComment: vi.fn(async (docId: string, commentId: string, content: string) => {
        callLog.push({ method: 'reply:replyToComment', args: [docId, commentId, content] });
        return `reply-${++replyCounter}`;
      }),
      deleteReply: vi.fn(async (docId: string, commentId: string, replyId: string) => {
        callLog.push({ method: 'reply:deleteReply', args: [docId, commentId, replyId] });
      }),
      updateReply: vi.fn(async () => {}),
    } as unknown as CodocsClient;

    // Gate the agent run on an external promise so the first comment stays
    // "in flight" while we fire the second.
    let releaseFirst!: () => void;
    const firstRunStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let runCallCount = 0;
    const runner: AgentRunner = {
      name: 'mock',
      run: vi.fn(async (_prompt: string, sessionId: string | null) => {
        runCallCount++;
        callLog.push({ method: 'agentRun', args: [sessionId ? 'resume' : 'new'] });
        if (runCallCount === 1) {
          // Hold the first agent until the test releases it
          await firstRunStarted;
        }
        return { sessionId: sessionId ?? 'sess-1', exitCode: 0, stdout: 'ok', stderr: '' };
      }),
      getActiveProcesses: () => [],
      killAll: () => [],
      getCapabilities: () => ({ supportsSessionResume: false, supportsSessionFork: false, models: [], harnessSettings: [], supportsPermissionMode: false }),
    };

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    // Fire the first comment — it will block inside the agent runner.
    const first = makeCommentEvent();
    first.comment.id = 'comment-first';
    await orchestrator.handleComment(first);

    // Fire the second comment while the first is still running.
    const second = makeCommentEvent();
    second.comment.id = 'comment-second';
    await orchestrator.handleComment(second);

    // Give the event loop a chance to post the second thinking emoji.
    await drain(50);

    // Both comments should have received a thinking emoji by now, even
    // though only the first has started running.
    const thinkingReplies = callLog.filter(
      (c) => c.method === 'reply:replyToComment' && c.args[2] === '\u{1F914}',
    );
    const thinkingCommentIds = thinkingReplies.map((c) => c.args[1]);
    expect(thinkingCommentIds).toContain('comment-first');
    expect(thinkingCommentIds).toContain('comment-second');

    // Now let the first run finish and drain the queue fully.
    releaseFirst();
    await orchestrator.waitForIdle();

    // Each comment's thinking emoji should eventually be replaced by a
    // final reply — no stray thinking emojis left behind.
    const allReplyIdsPosted = callLog
      .filter((c) => c.method === 'reply:replyToComment' && c.args[2] === '\u{1F914}')
      .map((_c, i) => `reply-${i + 1}`);
    const deletedReplyIds = callLog
      .filter((c) => c.method === 'reply:deleteReply')
      .map((c) => c.args[2]);
    for (const id of allReplyIdsPosted) {
      expect(deletedReplyIds).toContain(id);
    }
  });

  // Regression: without a service account, codocs replies using the user's
  // own OAuth credentials, making its replies indistinguishable from the
  // user's by author. The ReplyTracker records the IDs of codocs's replies
  // so the listener can filter out the self-triggered events instead of
  // treating them as new user comments and looping.
  it('records posted reply IDs in ReplyTracker, which then flags self-replies as bot', async () => {
    const client = createMockClient(callLog);
    // Give each reply a distinct ID so the tracker can be verified per-call.
    let replyCounter = 0;
    const replyClient = {
      replyToComment: async (docId: string, commentId: string, content: string) => {
        callLog.push({ method: 'reply:replyToComment', args: [docId, commentId, content] });
        return `self-reply-${++replyCounter}`;
      },
      deleteReply: async (docId: string, commentId: string, replyId: string) => {
        callLog.push({ method: 'reply:deleteReply', args: [docId, commentId, replyId] });
      },
      updateReply: async () => {},
    } as unknown as CodocsClient;
    const runner = createMockRunner(callLog, 'Fixed.');
    const replyTracker = new ReplyTracker();

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      replyTracker,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: runner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    // Both the thinking reply and the final reply must be in the tracker.
    expect(replyTracker.has('self-reply-1')).toBe(true);
    expect(replyTracker.has('self-reply-2')).toBe(true);

    // Simulate the follow-up Pub/Sub event: same thread, the last reply is
    // codocs's own final reply. With an empty botEmails list (no service
    // account) and author identical to the user, only the tracker can
    // distinguish this from a new human comment.
    const followUpComment = {
      id: 'comment-abc',
      author: { displayName: 'Gabor', emailAddress: 'user@example.com' },
      replies: [
        { id: 'self-reply-1', author: { displayName: 'Gabor', emailAddress: 'user@example.com' } },
        { id: 'self-reply-2', author: { displayName: 'Gabor', emailAddress: 'user@example.com' } },
      ],
    };
    const origin = classifyComment(followUpComment, {
      botEmails: [],
      ownReplyIds: replyTracker,
    });
    expect(origin.type).toBe('bot');
  });
});

/**
 * Gated fork-capable mock runner: every call blocks on an externally-released
 * promise so tests can deterministically observe "N runs are in flight before
 * any completes". The returned child session ID encodes whether the call was
 * a fork (fork-of-<parent>-<n>), a resume (<parent>), or fresh (new-<n>).
 */
interface ForkRunCall {
  sessionId: string | null;
  forkSession: boolean;
  child: string;
  prompt: string;
}
interface ForkRunner {
  runner: AgentRunner;
  calls: ForkRunCall[];
  releaseAll: () => void;
  releaseOne: () => void;
  inFlight: () => number;
}
function createForkMockRunner(opts?: { supportsSessionFork?: boolean }): ForkRunner {
  const supportsSessionFork = opts?.supportsSessionFork ?? true;
  const calls: ForkRunCall[] = [];
  const gates: Array<(exitCode?: number) => void> = [];
  let counter = 0;
  const runner: AgentRunner = {
    name: 'mock-fork',
    run: vi.fn(async (prompt, sessionId, runOpts) => {
      const idx = counter++;
      const forking = !!(runOpts as any)?.forkSession && !!sessionId;
      const child = forking
        ? `fork-${sessionId}-${idx}`
        : sessionId ?? `new-${idx}`;
      calls.push({
        sessionId,
        forkSession: !!(runOpts as any)?.forkSession,
        child,
        prompt,
      });
      const exitCode = await new Promise<number>((r) => gates.push((code) => r(code ?? 0)));
      return { sessionId: child, exitCode, stdout: 'ok', stderr: '' };
    }),
    getActiveProcesses: () => [],
    killAll: () => [],
    getCapabilities: () => ({
      supportsSessionResume: true,
      supportsSessionFork,
      models: [],
      harnessSettings: [],
      supportsPermissionMode: false,
    }),
  };
  return {
    runner,
    calls,
    releaseAll: () => { while (gates.length) gates.shift()!(); },
    releaseOne: () => { gates.shift()?.(); },
    inFlight: () => gates.length,
  };
}

/** Yield the event loop so scheduled promises and timers can run. */
async function settle(ms = 50) {
  await new Promise<void>((r) => setTimeout(r, ms));
}

describe('AgentOrchestrator fork-per-comment', () => {
  let callLog: CallLog[];
  let db: Database;
  let queueStore: QueueStore;
  let orchestrators: AgentOrchestrator[];

  function createOrchestrator(config: ConstructorParameters<typeof AgentOrchestrator>[0]): AgentOrchestrator {
    const o = new AgentOrchestrator(config);
    orchestrators.push(o);
    return o;
  }

  beforeEach(async () => {
    callLog = [];
    orchestrators = [];
    db = await openDatabase(':memory:');
    queueStore = new QueueStore(db);
  });

  afterEach(() => {
    for (const o of orchestrators) o.cancelIdleCheck();
    db.close();
  });

  it('runs two new-thread comments for the same agent concurrently', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const fr = createForkMockRunner();

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: fr.runner,
      fallbackAgent: 'test-agent',
    });

    const a = makeCommentEvent();
    a.comment.id = 'thread-a';
    const b = makeCommentEvent();
    b.comment.id = 'thread-b';

    await orchestrator.handleComment(a);
    await orchestrator.handleComment(b);
    await settle();

    // Both agent runs should be in flight simultaneously.
    expect(fr.inFlight()).toBe(2);
    expect(fr.calls.length).toBe(2);

    fr.releaseAll();
    await orchestrator.waitForIdle();
  });

  it('forks from the base session for a brand-new thread, resumes for follow-ups', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const fr = createForkMockRunner();
    const sessionStore = createMockSessionStore();
    // Pre-seed a base session the orchestrator should fork from.
    sessionStore.upsertSession('test-agent', 'doc-123:base', 'root');

    const orchestrator = createOrchestrator({
      client,
      replyClient,
      sessionStore,
      queueStore,
      agentRunner: fr.runner,
      fallbackAgent: 'test-agent',
    });

    // First comment on a brand-new thread should fork from base.
    const first = makeCommentEvent();
    first.comment.id = 'thread-a';
    await orchestrator.handleComment(first);
    await settle();
    expect(fr.calls[0]).toMatchObject({ sessionId: 'root', forkSession: true });
    fr.releaseOne();
    await orchestrator.waitForIdle();

    // The thread now has its own session (the fork child), so the follow-up
    // should resume the thread, not re-fork from the base.
    const followUp = makeCommentEvent();
    followUp.comment.id = 'thread-a';
    await orchestrator.handleComment(followUp);
    await settle();
    const followUpCall = fr.calls[1];
    expect(followUpCall.sessionId).toBe(fr.calls[0].child); // thread chain
    expect(followUpCall.forkSession).toBe(false);
    fr.releaseOne();
    await orchestrator.waitForIdle();
  });

  it('advances base on successful edits; preserves it on no-op runs', async () => {
    const sessionStore = createMockSessionStore();
    sessionStore.upsertSession('test-agent', 'doc-123:base', 'root');

    // Run 1: agent produces no changes (default runner stdout is unchanged
    // from the starting file, so computeDocDiff reports hasChanges=false).
    {
      const client = createMockClient([]);
      const replyClient = createMockReplyClient([]);
      const fr = createForkMockRunner();
      const orchestrator = createOrchestrator({
        client, replyClient, sessionStore, queueStore,
        agentRunner: fr.runner, fallbackAgent: 'test-agent',
      });
      await orchestrator.handleComment(makeCommentEvent());
      await settle();
      fr.releaseAll();
      await orchestrator.waitForIdle();

      // No batchUpdate was invoked (nothing changed on disk).
      // Base should still be the original root.
      expect(sessionStore.getSession('test-agent', 'doc-123:base')?.sessionId).toBe('root');
    }
  });

  it('does not overwrite base when a fork fails; retries fresh without a parent', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const sessionStore = createMockSessionStore();
    sessionStore.upsertSession('test-agent', 'doc-123:base', 'root');

    // Runner: first call fails (exit 1), second call succeeds (retry).
    const calls: Array<{ sessionId: string | null; forkSession: boolean }> = [];
    let runCount = 0;
    const runner: AgentRunner = {
      name: 'mock-fork',
      run: vi.fn(async (_p, sessionId, runOpts) => {
        calls.push({ sessionId, forkSession: !!(runOpts as any)?.forkSession });
        runCount++;
        const exit = runCount === 1 ? 1 : 0;
        return { sessionId: sessionId ?? `new-${runCount}`, exitCode: exit, stdout: 'ok', stderr: '' };
      }),
      getActiveProcesses: () => [],
      killAll: () => [],
      getCapabilities: () => ({
        supportsSessionResume: true, supportsSessionFork: true,
        models: [], harnessSettings: [], supportsPermissionMode: false,
      }),
    };

    const orchestrator = createOrchestrator({
      client, replyClient, sessionStore, queueStore,
      agentRunner: runner, fallbackAgent: 'test-agent',
    });

    await orchestrator.handleComment(makeCommentEvent());
    await orchestrator.waitForIdle();

    // First call tried to fork from root; second (retry) ran fresh.
    expect(calls[0]).toEqual({ sessionId: 'root', forkSession: true });
    expect(calls[1]).toEqual({ sessionId: null, forkSession: false });

    // Base was NOT overwritten by the failed fork child.
    expect(sessionStore.getSession('test-agent', 'doc-123:base')?.sessionId).toBe('root');
  });

  it('non-fork runner (supportsSessionFork: false) still serializes per agent', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const fr = createForkMockRunner({ supportsSessionFork: false });

    const orchestrator = createOrchestrator({
      client, replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: fr.runner,
      fallbackAgent: 'test-agent',
    });

    const a = makeCommentEvent();
    a.comment.id = 'thread-a';
    const b = makeCommentEvent();
    b.comment.id = 'thread-b';

    await orchestrator.handleComment(a);
    await orchestrator.handleComment(b);
    await settle();

    // Legacy queue: only the first agent call should be in flight.
    expect(fr.inFlight()).toBe(1);
    expect(fr.calls.length).toBe(1);

    fr.releaseOne();
    await settle();
    // After the first resolves, the second drains.
    expect(fr.inFlight()).toBe(1);
    expect(fr.calls.length).toBe(2);

    fr.releaseOne();
    await orchestrator.waitForIdle();
  });

  it('waitForIdle waits for every in-flight fork, not just the first', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const fr = createForkMockRunner();

    const orchestrator = createOrchestrator({
      client, replyClient,
      sessionStore: createMockSessionStore(),
      queueStore,
      agentRunner: fr.runner,
      fallbackAgent: 'test-agent',
    });

    for (let i = 0; i < 5; i++) {
      const e = makeCommentEvent();
      e.comment.id = `thread-${i}`;
      await orchestrator.handleComment(e);
    }
    await settle();
    expect(fr.inFlight()).toBe(5);

    let done = false;
    const idle = orchestrator.waitForIdle().then(() => { done = true; });

    // Release 4 of 5 — waitForIdle must still be pending.
    for (let i = 0; i < 4; i++) fr.releaseOne();
    await settle();
    expect(done).toBe(false);

    // Release the last one — waitForIdle resolves.
    fr.releaseOne();
    await idle;
    expect(done).toBe(true);
  });

  it('recoverQueue fork-spawns every pending item concurrently', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const fr = createForkMockRunner();
    const sessionStore = createMockSessionStore();

    // Pre-seed 3 pending rows, same agent, distinct thread IDs.
    for (let i = 0; i < 3; i++) {
      const e = makeCommentEvent();
      e.comment.id = `thread-recover-${i}`;
      queueStore.enqueue('test-agent', 'doc-123', e);
    }

    const orchestrator = createOrchestrator({
      client, replyClient, sessionStore, queueStore,
      agentRunner: fr.runner,
      fallbackAgent: 'test-agent',
    });

    await orchestrator.recoverQueue();
    await settle();

    // All three recovered items should be running concurrently.
    expect(fr.inFlight()).toBe(3);

    fr.releaseAll();
    await orchestrator.waitForIdle();
  });
});
