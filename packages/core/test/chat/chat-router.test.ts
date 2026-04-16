import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeComment } from '../../src/chat/chat-router.js';
import { CHAT_INPUT_ANCHOR, CHAT_COMMENT_PREFIX } from '../../src/chat/chat-tab-manager.js';
import type { CommentEvent } from '../../src/types.js';
import type { ChatTabStore, ChatTab } from '@codocs/db';
import type { CodocsClient } from '../../src/client/index.js';

function makeEvent(overrides: Partial<CommentEvent['comment']> = {}): CommentEvent {
  return {
    eventType: 'comment.created',
    documentId: 'doc-1',
    comment: {
      id: 'comment-1',
      content: 'Hello',
      mentions: [],
      ...overrides,
    },
    eventTime: new Date().toISOString(),
  };
}

function makeChatTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 1,
    documentId: 'doc-1',
    tabId: 'tab-abc',
    title: 'Test Chat',
    agentName: 'planner',
    sourceCommentId: null,
    activeCommentId: null,
    status: 'active',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function mockChatTabStore(tabs: ChatTab[] = []): ChatTabStore {
  return {
    getByActiveComment: vi.fn((commentId: string) =>
      tabs.find((t) => t.activeCommentId === commentId) ?? null,
    ),
    getActiveByDocument: vi.fn((_docId: string) => tabs),
    getByTab: vi.fn(),
    getBySourceComment: vi.fn(),
    create: vi.fn(),
    updateActiveComment: vi.fn(),
    addMessage: vi.fn(),
    getMessages: vi.fn(() => []),
    archive: vi.fn(),
  } as unknown as ChatTabStore;
}

function mockClient(): CodocsClient {
  return {
    getDocumentWithTabs: vi.fn(async () => ({
      tabs: [{
        tabProperties: { tabId: 'tab-abc' },
        documentTab: {
          body: {
            content: [{
              paragraph: {
                elements: [{ textRun: { content: CHAT_INPUT_ANCHOR + '\n' } }],
              },
              startIndex: 1,
              endIndex: 50,
            }],
          },
        },
      }],
    })),
  } as unknown as CodocsClient;
}

describe('routeComment', () => {
  it('routes to doc when no chat tabs exist', async () => {
    const store = mockChatTabStore([]);
    const result = await routeComment(makeEvent(), store, mockClient());
    expect(result.type).toBe('doc');
  });

  it('routes to chat when comment ID matches active comment', async () => {
    const tab = makeChatTab({ activeCommentId: 'comment-1' });
    const store = mockChatTabStore([tab]);
    const result = await routeComment(
      makeEvent({ id: 'comment-1' }),
      store,
      mockClient(),
    );
    expect(result.type).toBe('chat');
    if (result.type === 'chat') {
      expect(result.chatTab.tabId).toBe('tab-abc');
    }
  });

  it('routes to chat when quotedText contains anchor marker', async () => {
    const tab = makeChatTab();
    const store = mockChatTabStore([tab]);
    const result = await routeComment(
      makeEvent({ quotedText: CHAT_INPUT_ANCHOR }),
      store,
      mockClient(),
    );
    expect(result.type).toBe('chat');
  });

  it('routes to doc when quotedText is empty (even with active chat tabs)', async () => {
    const tab = makeChatTab();
    const store = mockChatTabStore([tab]);
    const result = await routeComment(
      makeEvent({ quotedText: '', id: 'other-comment' }),
      store,
      mockClient(),
    );
    expect(result.type).toBe('doc');
  });

  it('routes to doc when quotedText is too short for content matching', async () => {
    const tab = makeChatTab();
    const store = mockChatTabStore([tab]);
    const result = await routeComment(
      makeEvent({ quotedText: 'ab', id: 'other-comment' }),
      store,
      mockClient(),
    );
    expect(result.type).toBe('doc');
  });

  it('routes to chat via content matching when quotedText matches tab content', async () => {
    const tab = makeChatTab();
    const store = mockChatTabStore([tab]);
    const client = mockClient();

    const result = await routeComment(
      makeEvent({
        quotedText: CHAT_INPUT_ANCHOR,
        id: 'other-comment',
      }),
      store,
      client,
    );
    expect(result.type).toBe('chat');
  });

  it('does not route empty quotedText on main doc to chat tab', async () => {
    // Critical edge case: empty selection on main doc should NOT go to chat
    const tab = makeChatTab({ activeCommentId: 'input-comment-42' });
    const store = mockChatTabStore([tab]);
    const result = await routeComment(
      makeEvent({ quotedText: '', id: 'random-comment' }),
      store,
      mockClient(),
    );
    expect(result.type).toBe('doc');
  });

  it('handles multiple chat tabs - routes via active comment ID', async () => {
    const tab1 = makeChatTab({ id: 1, tabId: 'tab-1', activeCommentId: 'input-1' });
    const tab2 = makeChatTab({ id: 2, tabId: 'tab-2', activeCommentId: 'input-2' });
    const store = mockChatTabStore([tab1, tab2]);

    const result = await routeComment(
      makeEvent({ id: 'input-2' }),
      store,
      mockClient(),
    );
    expect(result.type).toBe('chat');
    if (result.type === 'chat') {
      expect(result.chatTab.tabId).toBe('tab-2');
    }
  });

  it('routes to chat via comment prefix', async () => {
    const tab = makeChatTab();
    const store = mockChatTabStore([tab]);
    const result = await routeComment(
      makeEvent({ content: `${CHAT_COMMENT_PREFIX} Reply here`, id: 'other' }),
      store,
      mockClient(),
    );
    expect(result.type).toBe('chat');
  });
});
