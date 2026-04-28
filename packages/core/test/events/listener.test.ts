import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Message } from '@google-cloud/pubsub';

// Capture the most recent fake subscription so tests can drive messages/errors.
let currentSubscription: FakeSubscription | null = null;

class FakeSubscription extends EventEmitter {
  subName: string;
  closed = false;
  isOpen = true;
  constructor(name: string) {
    super();
    this.subName = name;
    currentSubscription = this;
  }
  async close() {
    this.closed = true;
    this.isOpen = false;
  }
}

const pubsubCtorSpy = vi.fn();

vi.mock('@google-cloud/pubsub', () => ({
  PubSub: class {
    constructor(opts: any) {
      pubsubCtorSpy(opts);
    }
    subscription(name: string) {
      return new FakeSubscription(name);
    }
  },
}));

const getCommentMock = vi.fn();
vi.mock('../../src/client/drive-api.js', () => ({
  DriveApi: class {
    getComment = getCommentMock;
  },
}));
vi.mock('../../src/auth/index.js', () => ({
  createAuth: () => ({}),
}));

import {
  extractMentions,
  extractDocumentId,
  parseEventStub,
  listenForComments,
  type PubSubAuth,
} from '../../src/events/listener.js';
import type { CommentEvent } from '../../src/types.js';

function makeMessage(
  attributes: Record<string, string>,
  data: Buffer | Record<string, any>,
): Message {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  return {
    attributes,
    data: buffer,
  } as unknown as Message;
}

describe('extractMentions', () => {
  it('returns empty for text without mentions', () => {
    expect(extractMentions('Hello world')).toEqual([]);
  });

  it('extracts @-style mentions', () => {
    expect(extractMentions('Hey @alice@example.com check this')).toEqual([
      'alice@example.com',
    ]);
  });

  it('extracts +-style mentions', () => {
    expect(extractMentions('cc +bob@corp.co')).toEqual(['bob@corp.co']);
  });

  it('extracts multiple mentions', () => {
    const result = extractMentions(
      '@alice@example.com please review with +bob@corp.co',
    );
    expect(result).toEqual(['alice@example.com', 'bob@corp.co']);
  });

  it('handles mentions with dots and hyphens in local part', () => {
    expect(extractMentions('+first.last-name@sub.domain.org')).toEqual([
      'first.last-name@sub.domain.org',
    ]);
  });

  it('returns empty for @ without a valid email', () => {
    expect(extractMentions('email me @ sometime')).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(extractMentions('')).toEqual([]);
  });

  it('returns duplicates when the same mention appears twice (no dedupe)', () => {
    expect(
      extractMentions('@alice@example.com then +alice@example.com again'),
    ).toEqual(['alice@example.com', 'alice@example.com']);
  });
});

describe('extractDocumentId', () => {
  it('extracts from ce-subject (primary path)', () => {
    const msg = makeMessage(
      {
        'ce-subject':
          'googleapis.com/drive/v3/files/1DkgMuvq1aFDI3Hyo1gyJT1fmRfa7TE81jD4lFPMZXM4',
      },
      {},
    );
    expect(extractDocumentId(msg, {})).toBe(
      '1DkgMuvq1aFDI3Hyo1gyJT1fmRfa7TE81jD4lFPMZXM4',
    );
  });

  it('falls back to payload.comment.fileId', () => {
    const msg = makeMessage({}, {});
    expect(extractDocumentId(msg, { comment: { fileId: 'abc123' } })).toBe(
      'abc123',
    );
  });

  it('falls back to ce-source documents path', () => {
    const msg = makeMessage(
      { 'ce-source': '//docs.googleapis.com/documents/xyz789' },
      {},
    );
    expect(extractDocumentId(msg, {})).toBe('xyz789');
  });

  it('prefers ce-subject over payload', () => {
    const msg = makeMessage(
      { 'ce-subject': 'googleapis.com/drive/v3/files/from-subject' },
      {},
    );
    expect(
      extractDocumentId(msg, { comment: { fileId: 'from-payload' } }),
    ).toBe('from-subject');
  });

  it('returns empty when nothing matches', () => {
    const msg = makeMessage({}, {});
    expect(extractDocumentId(msg, {})).toBe('');
  });
});

describe('parseEventStub', () => {
  it('parses a valid comment event', () => {
    const msg = makeMessage(
      {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-time': '2026-04-09T01:37:04.009Z',
        'ce-subject': 'googleapis.com/drive/v3/files/doc123',
      },
      { comment: { id: 'comment-abc', fileId: 'doc123' } },
    );
    const result = parseEventStub(msg);
    expect(result).toEqual({
      eventType: 'google.workspace.drive.comment.v3.created',
      documentId: 'doc123',
      commentId: 'comment-abc',
      eventTime: '2026-04-09T01:37:04.009Z',
    });
  });

  it('parses a reply event with commentId from payload.reply.commentId', () => {
    const msg = makeMessage(
      {
        'ce-type': 'google.workspace.drive.reply.v3.created',
        'ce-time': '2026-04-09T02:00:00.000Z',
        'ce-subject': 'googleapis.com/drive/v3/files/doc-reply',
      },
      { reply: { commentId: 'parent-comment-99' } },
    );
    const result = parseEventStub(msg);
    expect(result).toEqual({
      eventType: 'google.workspace.drive.reply.v3.created',
      documentId: 'doc-reply',
      commentId: 'parent-comment-99',
      eventTime: '2026-04-09T02:00:00.000Z',
    });
  });

  it('accepts comment events with missing commentId (returns empty string)', () => {
    const msg = makeMessage(
      {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc123',
      },
      { comment: { fileId: 'doc123' } },
    );
    const result = parseEventStub(msg);
    expect(result).not.toBeNull();
    expect(result!.documentId).toBe('doc123');
    expect(result!.commentId).toBe('');
  });

  it('returns null for non-comment, non-reply events', () => {
    const msg = makeMessage(
      { 'ce-type': 'google.workspace.drive.file.v3.updated' },
      {},
    );
    expect(parseEventStub(msg)).toBeNull();
  });

  it('returns null when missing document ID', () => {
    const msg = makeMessage(
      { 'ce-type': 'google.workspace.drive.comment.v3.created' },
      { comment: { id: 'c1' } },
    );
    expect(parseEventStub(msg)).toBeNull();
  });

  it('handles malformed JSON data gracefully', () => {
    const msg = makeMessage(
      {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc123',
      },
      Buffer.from('not json'),
    );
    const result = parseEventStub(msg);
    expect(result).not.toBeNull();
    expect(result!.documentId).toBe('doc123');
    expect(result!.commentId).toBe('');
  });

  it('uses event_type attribute as fallback', () => {
    const msg = makeMessage(
      {
        event_type: 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc456',
      },
      { comment: { id: 'c2', fileId: 'doc456' } },
    );
    const result = parseEventStub(msg);
    expect(result).not.toBeNull();
    expect(result!.documentId).toBe('doc456');
  });
});

describe('listenForComments', () => {
  const auth: PubSubAuth = {
    clientId: 'client-id-abc',
    clientSecret: 'secret',
    refreshToken: 'refresh',
  };

  beforeEach(() => {
    pubsubCtorSpy.mockReset();
    getCommentMock.mockReset();
    currentSubscription = null;
  });

  function makePubsubMessage(opts: {
    attributes: Record<string, string>;
    data?: Buffer | Record<string, any>;
  }): Message & { ackCount: number } {
    const data = Buffer.isBuffer(opts.data)
      ? opts.data
      : Buffer.from(JSON.stringify(opts.data ?? {}));
    const msg: any = {
      id: 'msg-1',
      publishTime: { toISOString: () => '2026-04-09T00:00:00.000Z' },
      attributes: opts.attributes,
      data,
      ackCount: 0,
      ack() {
        this.ackCount++;
      },
    };
    return msg;
  }

  it('resolves full subscription name when a bare name is given', () => {
    const handle = listenForComments('proj-1', 'my-sub', auth, () => {});
    expect(currentSubscription!.subName).toBe('projects/proj-1/subscriptions/my-sub');
    handle.close();
  });

  it('passes a fully-qualified subscription name through unchanged', () => {
    const handle = listenForComments(
      'proj-1',
      'projects/other/subscriptions/full-sub',
      auth,
      () => {},
    );
    expect(currentSubscription!.subName).toBe('projects/other/subscriptions/full-sub');
    handle.close();
  });

  it('invokes onComment for a human-authored comment and acks the message', async () => {
    const events: CommentEvent[] = [];
    getCommentMock.mockResolvedValue({
      id: 'c1',
      content: 'Please review',
      author: { displayName: 'Alice', emailAddress: 'alice@example.com' },
      createdTime: '2026-04-09T00:00:00.000Z',
      quotedFileContent: { value: 'quoted snippet' },
      replies: [],
    });

    const handle = listenForComments(
      'proj-1',
      'sub-1',
      auth,
      (e) => events.push(e),
      undefined,
      { botEmails: ['bot@example.com'] },
    );
    const msg = makePubsubMessage({
      attributes: {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-time': '2026-04-09T00:00:00.000Z',
        'ce-subject': 'googleapis.com/drive/v3/files/doc-1',
      },
      data: { comment: { id: 'c1' } },
    });
    currentSubscription!.emit('message', msg);
    // handler is async — wait for microtasks + the getComment promise.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(getCommentMock).toHaveBeenCalledWith('doc-1', 'c1');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventType: 'google.workspace.drive.comment.v3.created',
      documentId: 'doc-1',
      comment: {
        id: 'c1',
        content: 'Please review',
        author: 'Alice',
        quotedText: 'quoted snippet',
        createdTime: '2026-04-09T00:00:00.000Z',
        mentions: [],
      },
      eventTime: '2026-04-09T00:00:00.000Z',
      thread: undefined,
    });
    expect((msg as any).ackCount).toBe(1);
    handle.close();
  });

  it('skips bot-authored comments but still acks', async () => {
    const events: CommentEvent[] = [];
    getCommentMock.mockResolvedValue({
      id: 'c2',
      content: '🤔',
      author: { displayName: 'Bot', emailAddress: 'bot@example.com' },
      replies: [],
    });

    const handle = listenForComments(
      'proj-1',
      'sub-1',
      auth,
      (e) => events.push(e),
      undefined,
      { botEmails: ['bot@example.com'] },
    );
    const msg = makePubsubMessage({
      attributes: {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc-1',
      },
      data: { comment: { id: 'c2' } },
    });
    currentSubscription!.emit('message', msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(0);
    expect((msg as any).ackCount).toBe(1);
    handle.close();
  });

  it('ignores non-comment events and acks', async () => {
    const events: CommentEvent[] = [];
    const handle = listenForComments(
      'proj-1',
      'sub-1',
      auth,
      (e) => events.push(e),
    );
    const msg = makePubsubMessage({
      attributes: { 'ce-type': 'google.workspace.drive.file.v3.updated' },
    });
    currentSubscription!.emit('message', msg);
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(0);
    expect(getCommentMock).not.toHaveBeenCalled();
    expect((msg as any).ackCount).toBe(1);
    handle.close();
  });

  it('falls back to a stub CommentEvent when Drive getComment fails', async () => {
    const events: CommentEvent[] = [];
    getCommentMock.mockRejectedValue(new Error('boom'));

    const handle = listenForComments(
      'proj-1',
      'sub-1',
      auth,
      (e) => events.push(e),
    );
    const msg = makePubsubMessage({
      attributes: {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc-f',
      },
      data: { comment: { id: 'cf' } },
    });
    currentSubscription!.emit('message', msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect(events[0].documentId).toBe('doc-f');
    expect(events[0].comment.id).toBe('cf');
    expect(events[0].comment.content).toBeUndefined();
    expect((msg as any).ackCount).toBe(1);
    handle.close();
  });

  it('forwards subscription errors to onError', () => {
    const errs: Error[] = [];
    const handle = listenForComments(
      'proj-1',
      'sub-1',
      auth,
      () => {},
      (e) => errs.push(e),
    );
    const err = new Error('subscription failed');
    currentSubscription!.emit('error', err);
    expect(errs).toEqual([err]);
    handle.close();
  });

  it('close() removes listeners and closes the subscription', async () => {
    const handle = listenForComments('proj-1', 'sub-1', auth, () => {});
    const sub = currentSubscription!;
    expect(sub.listenerCount('message')).toBe(1);
    expect(sub.listenerCount('error')).toBe(1);

    await handle.close();

    expect(sub.listenerCount('message')).toBe(0);
    expect(sub.listenerCount('error')).toBe(0);
    expect(sub.closed).toBe(true);
  });

  it("reconnects when the subscription emits 'close' (non-manual)", async () => {
    const reconnects: Array<{ attempt: number; reason: string }> = [];
    const handle = listenForComments(
      'proj-1',
      'sub-1',
      auth,
      () => {},
      undefined,
      {
        reconnectInitialDelayMs: 0,
        reconnectMaxDelayMs: 0,
        healthCheckIntervalMs: 0,
        onReconnect: (info) => reconnects.push(info),
      },
    );
    const firstSub = currentSubscription!;
    expect(firstSub.listenerCount('close')).toBe(1);

    firstSub.emit('close');
    // Allow the 0ms timeout + the async reconnect() body to run.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));

    expect(currentSubscription).not.toBe(firstSub);
    expect(currentSubscription!.subName).toBe('projects/proj-1/subscriptions/sub-1');
    expect(currentSubscription!.listenerCount('message')).toBe(1);
    expect(reconnects).toEqual([
      { attempt: 1, reason: 'subscription emitted close' },
    ]);
    expect(firstSub.closed).toBe(true);
    await handle.close();
  });

  it("recycles via the watchdog when subscription.isOpen becomes false", async () => {
    vi.useFakeTimers();
    try {
      const reconnects: Array<{ attempt: number; reason: string }> = [];
      const handle = listenForComments(
        'proj-1',
        'sub-1',
        auth,
        () => {},
        undefined,
        {
          reconnectInitialDelayMs: 0,
          healthCheckIntervalMs: 50,
          onReconnect: (info) => reconnects.push(info),
        },
      );
      const firstSub = currentSubscription!;
      // Simulate the gRPC stream silently dying without emitting 'close'.
      firstSub.isOpen = false;

      vi.advanceTimersByTime(60);
      // Drain reconnect timer + async close.
      await vi.advanceTimersByTimeAsync(10);

      expect(currentSubscription).not.toBe(firstSub);
      expect(reconnects[0]?.reason).toBe('health check: not open');
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual close cancels any pending reconnect', async () => {
    const reconnects: Array<{ attempt: number; reason: string }> = [];
    const handle = listenForComments(
      'proj-1',
      'sub-1',
      auth,
      () => {},
      undefined,
      {
        reconnectInitialDelayMs: 50,
        healthCheckIntervalMs: 0,
        onReconnect: (info) => reconnects.push(info),
      },
    );
    const firstSub = currentSubscription!;
    firstSub.emit('close');
    await handle.close();
    // Wait past the would-be reconnect delay.
    await new Promise((r) => setTimeout(r, 100));

    expect(reconnects).toEqual([]);
    expect(currentSubscription).toBe(firstSub);
  });

  it('treats tracked own-reply IDs as bot and suppresses the event', async () => {
    const events: CommentEvent[] = [];
    // Comment whose last reply has id 'reply-self-1' — the tracker says
    // it's one of ours, so the classifier should mark as bot.
    getCommentMock.mockResolvedValue({
      id: 'c3',
      content: 'Hello',
      author: { displayName: 'Gabor', emailAddress: 'user@example.com' },
      replies: [
        {
          id: 'reply-self-1',
          content: '🤔',
          author: { displayName: 'Gabor', emailAddress: 'user@example.com' },
        },
      ],
    });

    const tracker = { has: (id: string) => id === 'reply-self-1' };
    const handle = listenForComments(
      'proj-1',
      'sub-1',
      auth,
      (e) => events.push(e),
      undefined,
      { replyTracker: tracker },
    );
    const msg = makePubsubMessage({
      attributes: {
        'ce-type': 'google.workspace.drive.reply.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc-r',
      },
      data: { comment: { id: 'c3' } },
    });
    currentSubscription!.emit('message', msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(0);
    expect((msg as any).ackCount).toBe(1);
    handle.close();
  });
});
