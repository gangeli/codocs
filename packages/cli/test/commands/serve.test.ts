import { describe, it, expect, vi } from 'vitest';
import { metaRestartShutdown, type MetaRestartShutdownCtx } from '../../src/commands/meta-restart.js';
import {
  buildRestartArgs,
  extractDocId,
  formatCommentEvent,
  isAgentType,
  fallbackDocName,
} from '../../src/commands/serve.js';
import type { CommentEvent } from '@codocs/core';

/**
 * Build a minimal ctx suitable for exercising metaRestartShutdown. Records
 * which heartbeats were cleared so the test can assert on them.
 */
function makeCtx(overrides?: {
  docIds?: string[];
  clearServerHeartbeat?: (docId: string) => Promise<void>;
}): {
  ctx: MetaRestartShutdownCtx;
  cleared: string[];
  listenerClosed: () => boolean;
  dbClosed: () => boolean;
  cancelIdleCalled: () => boolean;
} {
  const cleared: string[] = [];
  let listenerClosed = false;
  let dbClosed = false;
  let cancelIdleCalled = false;

  const ctx: MetaRestartShutdownCtx = {
    orchestrator: {
      cancelIdleCheck: () => { cancelIdleCalled = true; },
    },
    renewalTimer: setInterval(() => {}, 60_000),
    heartbeatTimer: setInterval(() => {}, 60_000),
    listener: { close: async () => { listenerClosed = true; } },
    db: { close: () => { dbClosed = true; } },
    lockClient: {
      clearServerHeartbeat: overrides?.clearServerHeartbeat ?? (async (docId) => {
        cleared.push(docId);
      }),
    },
    docIds: overrides?.docIds ?? ['doc-one', 'doc-two'],
  };

  return {
    ctx,
    cleared,
    listenerClosed: () => listenerClosed,
    dbClosed: () => dbClosed,
    cancelIdleCalled: () => cancelIdleCalled,
  };
}

describe('metaRestartShutdown', () => {
  // Regression: --meta restart was re-exec'ing the server without releasing
  // the Drive heartbeat, so the new child saw the previous server's fresh
  // heartbeat and bailed with "duplicate server". The shutdown path must
  // clear the heartbeat for every doc before the parent exits.
  it('clears the server heartbeat for every doc', async () => {
    const { ctx, cleared } = makeCtx({ docIds: ['doc-A', 'doc-B'] });

    await metaRestartShutdown(ctx);

    expect(cleared).toEqual(['doc-A', 'doc-B']);
  });

  it('executes shutdown steps in the required order', async () => {
    const order: string[] = [];

    const realClearInterval = globalThis.clearInterval;
    const clearIntervalSpy = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation((handle: any) => {
        order.push('clearInterval');
        return realClearInterval(handle);
      });

    const ctx: MetaRestartShutdownCtx = {
      orchestrator: {
        cancelIdleCheck: () => { order.push('cancelIdleCheck'); },
      },
      renewalTimer: null,
      heartbeatTimer: setInterval(() => {}, 60_000),
      listener: {
        close: async () => { order.push('listenerClose'); },
      },
      db: {
        close: () => { order.push('dbClose'); },
      },
      lockClient: {
        clearServerHeartbeat: async (_docId: string) => {
          order.push('clearServerHeartbeat');
        },
      },
      docIds: ['doc-A'],
    };

    await metaRestartShutdown(ctx);

    expect(order).toEqual([
      'cancelIdleCheck',
      'clearInterval',
      'clearServerHeartbeat',
      'listenerClose',
      'dbClose',
    ]);

    clearIntervalSpy.mockRestore();
  });

  it('still closes listener and db even if heartbeat clearing throws', async () => {
    const { ctx, listenerClosed, dbClosed } = makeCtx({
      clearServerHeartbeat: async () => { throw new Error('network down'); },
    });

    await metaRestartShutdown(ctx);

    expect(listenerClosed()).toBe(true);
    expect(dbClosed()).toBe(true);
  });

  it('performs the standard shutdown steps (cancel idle, close listener, close db)', async () => {
    const { ctx, listenerClosed, dbClosed, cancelIdleCalled } = makeCtx();

    await metaRestartShutdown(ctx);

    expect(cancelIdleCalled()).toBe(true);
    expect(listenerClosed()).toBe(true);
    expect(dbClosed()).toBe(true);
  });
});

describe('buildRestartArgs', () => {
  it('appends --resume <sessionId> when no existing --resume is present', () => {
    const out = buildRestartArgs(['--debug', '--meta'], 'sess-1');
    expect(out).toEqual(['--debug', '--meta', '--resume', 'sess-1']);
  });

  it('strips an existing --resume <value> and replaces with the new one', () => {
    const out = buildRestartArgs(['--resume', 'old-sess', '--debug'], 'sess-new');
    expect(out).toEqual(['--debug', '--resume', 'sess-new']);
  });

  it('strips --resume=value form', () => {
    const out = buildRestartArgs(['--resume=old', '--debug'], 'sess-new');
    expect(out).toEqual(['--debug', '--resume', 'sess-new']);
  });

  it('handles --resume at the end with no following value', () => {
    const out = buildRestartArgs(['--debug', '--resume'], 'sess-new');
    expect(out).toEqual(['--debug', '--resume', 'sess-new']);
  });

  it('treats --resume immediately followed by another --flag as valueless', () => {
    const out = buildRestartArgs(['--resume', '--meta'], 'sess-new');
    // '--meta' starts with '--', so it's not the value of --resume; keep it.
    expect(out).toEqual(['--meta', '--resume', 'sess-new']);
  });

  it('preserves non-resume args in order', () => {
    const out = buildRestartArgs(
      ['doc-abc', '--agent', 'claude', '--debug'],
      'sess-new',
    );
    expect(out).toEqual(['doc-abc', '--agent', 'claude', '--debug', '--resume', 'sess-new']);
  });
});

describe('extractDocId (serve)', () => {
  it('returns input unchanged when not a URL', () => {
    expect(extractDocId('raw-id-123')).toBe('raw-id-123');
  });

  it('extracts from a /document/d/<id>/edit URL', () => {
    expect(
      extractDocId('https://docs.google.com/document/d/abc_-123/edit'),
    ).toBe('abc_-123');
  });
});

describe('isAgentType', () => {
  it('returns true for known agents', () => {
    expect(isAgentType('claude')).toBe(true);
    expect(isAgentType('codex')).toBe(true);
    expect(isAgentType('cursor')).toBe(true);
    expect(isAgentType('opencode')).toBe(true);
  });

  it('returns false for unknown values', () => {
    expect(isAgentType('gpt-5')).toBe(false);
    expect(isAgentType('')).toBe(false);
  });
});

describe('fallbackDocName', () => {
  it('returns "Codocs YYYY-MM-DD" using today', () => {
    const name = fallbackDocName();
    expect(name).toMatch(/^Codocs \d{4}-\d{2}-\d{2}$/);
    const today = new Date().toISOString().slice(0, 10);
    expect(name).toBe(`Codocs ${today}`);
  });
});

describe('formatCommentEvent', () => {
  function makeEvent(overrides: Partial<CommentEvent['comment']> = {}): CommentEvent {
    return {
      eventType: 'google.workspace.drive.comment.v3.created',
      documentId: 'doc-abc',
      eventTime: '2026-04-09T12:34:56.000Z',
      comment: {
        id: 'c1',
        author: 'Alice',
        content: 'Hello world',
        mentions: [],
        ...overrides,
      },
    };
  }

  it('includes doc ID, author, and content', () => {
    const out = formatCommentEvent(makeEvent());
    expect(out).toContain('doc-abc');
    expect(out).toContain('Author: Alice');
    expect(out).toContain('Content: Hello world');
  });

  it('includes quotedText when present', () => {
    const out = formatCommentEvent(makeEvent({ quotedText: 'snippet' }));
    expect(out).toContain('On: "snippet"');
  });

  it('omits quotedText line when absent', () => {
    const out = formatCommentEvent(makeEvent());
    expect(out).not.toContain('On:');
  });

  it('includes mentions when present', () => {
    const out = formatCommentEvent(
      makeEvent({ mentions: ['alice@example.com', 'bob@example.com'] }),
    );
    expect(out).toContain('Mentions: alice@example.com, bob@example.com');
  });

  it('omits mentions when empty', () => {
    const out = formatCommentEvent(makeEvent());
    expect(out).not.toContain('Mentions:');
  });

  it('falls back to "Unknown" author when missing', () => {
    const out = formatCommentEvent(makeEvent({ author: undefined }));
    expect(out).toContain('Author: Unknown');
  });

  it('renders "unknown time" when eventTime is missing', () => {
    const out = formatCommentEvent({
      eventType: 't',
      documentId: 'doc-x',
      eventTime: '',
      comment: { id: 'c', content: 'x', mentions: [], author: 'A' },
    });
    expect(out).toContain('unknown time');
  });
});
