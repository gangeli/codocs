import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentOrchestrator } from '../../src/harness/orchestrator.js';
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

function createMockClient(callLog: CallLog[]): CodocsClient {
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
    run: vi.fn(async (prompt: string, sessionId: string | null) => {
      callLog.push({ method: 'agentRun', args: [sessionId ? 'resume' : 'new'] });
      return {
        sessionId: sessionId ?? 'new-session-id',
        exitCode: 0,
        stdout,
        stderr: '',
      };
    }),
    getActiveProcesses: () => [],
    killAll: () => [],
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

  beforeEach(async () => {
    callLog = [];
    db = await openDatabase(':memory:');
    queueStore = new QueueStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('posts thinking emoji, runs agent, then updates the thinking reply', async () => {
    const client = createMockClient(callLog);
    const replyClient = createMockReplyClient(callLog);
    const runner = createMockRunner(callLog, 'Here is my response');

    const orchestrator = new AgentOrchestrator({
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
    };

    const orchestrator = new AgentOrchestrator({
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
    const orchestrator = new AgentOrchestrator({
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

    const orchestrator = new AgentOrchestrator({
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

    const orchestrator = new AgentOrchestrator({
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
    };

    const orchestrator = new AgentOrchestrator({
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

    const orchestrator = new AgentOrchestrator({
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
});
