/**
 * Longevity / silent-failure tests for the Pub/Sub comment listener.
 *
 * Targets the production complaint: "after a long period of time, codocs
 * stops processing comments." The recent reconnect work covers the loud
 * cases — the subscription emits `close`, or `isOpen` flips false. These
 * tests probe the *quiet* cases that aren't covered:
 *
 *   L1  Loud close: subscription emits 'close'.
 *       Expectation: recovery fires; subsequent messages are delivered.
 *
 *   L2  Loud half-open: subscription stays alive but isOpen flips to false.
 *       Expectation: watchdog reconnects; subsequent messages are delivered.
 *
 *   L3  Silent error: subscription emits 'error' once and then nothing.
 *       isOpen stays true, no 'close' is emitted, no further messages
 *       flow. Expectation (current): NO recovery — this is the suspected
 *       production failure mode.
 *
 *   L4  Silent half-open: no events at all, isOpen stays true, messages
 *       just stop. Expectation (current): NO recovery without
 *       idleReconnectMs — also a suspected failure mode.
 *
 *   L5  Silent half-open WITH idleReconnectMs configured: same as L4 but
 *       the listener is told to reconnect after an idle window.
 *       Expectation: recovery fires after the idle window elapses.
 *
 * The scenarios advance fake timers to simulate hours of wall-clock so
 * the test stays fast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Message } from '@google-cloud/pubsub';

let currentSubscription: FakeSubscription | null = null;
const allSubscriptions: FakeSubscription[] = [];

class FakeSubscription extends EventEmitter {
  subName: string;
  closed = false;
  isOpen = true;
  constructor(name: string) {
    super();
    this.subName = name;
    currentSubscription = this;
    allSubscriptions.push(this);
  }
  async close() {
    this.closed = true;
    this.isOpen = false;
  }
}

vi.mock('@google-cloud/pubsub', () => ({
  PubSub: class {
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

import { listenForComments, type PubSubAuth } from '../../src/events/listener.js';
import type { CommentEvent } from '../../src/types.js';

const auth: PubSubAuth = {
  clientId: 'client-id',
  clientSecret: 'secret',
  refreshToken: 'refresh',
};

function makePubsubMessage(commentId: string, docId = 'doc-x'): Message & { ackCount: number } {
  const msg: any = {
    id: `msg-${commentId}`,
    publishTime: { toISOString: () => '2026-04-09T00:00:00.000Z' },
    attributes: {
      'ce-type': 'google.workspace.drive.comment.v3.created',
      'ce-time': '2026-04-09T00:00:00.000Z',
      'ce-subject': `googleapis.com/drive/v3/files/${docId}`,
    },
    data: Buffer.from(JSON.stringify({ comment: { id: commentId } })),
    ackCount: 0,
    ack() { this.ackCount++; },
  };
  return msg;
}

/**
 * Drain microtasks under fake timers. Vitest's fake timers replace
 * setImmediate, so we can't use it as an async barrier — use
 * advanceTimersByTimeAsync(0) which flushes the microtask queue and
 * any 0-delay timers in one shot.
 */
async function flushAsync(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('listener longevity', () => {
  beforeEach(() => {
    currentSubscription = null;
    allSubscriptions.length = 0;
    getCommentMock.mockReset();
    getCommentMock.mockImplementation(async (_docId: string, commentId: string) => ({
      id: commentId,
      content: `body for ${commentId}`,
      author: { displayName: 'Alice', emailAddress: 'alice@example.com' },
      createdTime: '2026-04-09T00:00:00.000Z',
      replies: [],
    }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── L1 — Loud close ──────────────────────────────────────────
  it('L1: recovers from a loud close and delivers a follow-up message', async () => {
    const events: CommentEvent[] = [];
    const reconnects: Array<{ attempt: number; reason: string }> = [];
    const handle = listenForComments(
      'proj-1', 'sub-1', auth,
      (e) => events.push(e),
      undefined,
      {
        reconnectInitialDelayMs: 0,
        reconnectMaxDelayMs: 0,
        healthCheckIntervalMs: 0,
        onReconnect: (info) => reconnects.push(info),
      },
    );

    const first = currentSubscription!;
    first.emit('message', makePubsubMessage('c-pre'));
    await flushAsync();

    first.emit('close');
    await vi.advanceTimersByTimeAsync(5);
    await flushAsync();

    expect(currentSubscription).not.toBe(first);
    expect(reconnects.length).toBeGreaterThanOrEqual(1);

    currentSubscription!.emit('message', makePubsubMessage('c-post'));
    await flushAsync();

    expect(events.map((e) => e.comment.id)).toEqual(['c-pre', 'c-post']);
    await handle.close();
  });

  // ─── L2 — Loud half-open (watchdog catches it) ────────────────
  it('L2: recovers from a half-open stream where isOpen flipped false', async () => {
    const events: CommentEvent[] = [];
    const reconnects: Array<{ attempt: number; reason: string }> = [];
    const handle = listenForComments(
      'proj-1', 'sub-1', auth,
      (e) => events.push(e),
      undefined,
      {
        reconnectInitialDelayMs: 0,
        reconnectMaxDelayMs: 0,
        healthCheckIntervalMs: 100,
        onReconnect: (info) => reconnects.push(info),
      },
    );

    const first = currentSubscription!;
    first.emit('message', makePubsubMessage('c-1'));
    await flushAsync();

    // Stream silently dies but the library notices and toggles isOpen.
    first.isOpen = false;

    await vi.advanceTimersByTimeAsync(200);
    await flushAsync();

    expect(currentSubscription).not.toBe(first);
    expect(reconnects[0]?.reason).toContain('not open');

    currentSubscription!.emit('message', makePubsubMessage('c-2'));
    await flushAsync();

    expect(events.map((e) => e.comment.id)).toEqual(['c-1', 'c-2']);
    await handle.close();
  });

  // ─── L3 — Silent error: error fires, then nothing ─────────────
  // Reflects what we suspect happens in production: the gRPC stream
  // surfaces a transient error, but the library never closes or marks
  // the subscription stale, so nothing reconnects.
  //
  // EXPECTED (after fix): the listener treats a stream error as a
  // signal to recycle the subscription, so a follow-up message is
  // delivered through a fresh subscription.
  it('L3: recovers after a stream error that is not followed by close', async () => {
    const events: CommentEvent[] = [];
    const errs: Error[] = [];
    const reconnects: Array<{ attempt: number; reason: string }> = [];
    const handle = listenForComments(
      'proj-1', 'sub-1', auth,
      (e) => events.push(e),
      (err) => errs.push(err),
      {
        reconnectInitialDelayMs: 0,
        reconnectMaxDelayMs: 0,
        healthCheckIntervalMs: 100,
        onReconnect: (info) => reconnects.push(info),
      },
    );

    const first = currentSubscription!;
    first.emit('message', makePubsubMessage('c-1'));
    await flushAsync();

    // Library reports a transient error but does NOT emit 'close' and
    // does NOT toggle isOpen. The stream is effectively dead but looks
    // healthy from the library's perspective.
    first.emit('error', new Error('14 UNAVAILABLE: stream broken'));

    // Advance a few minutes; the listener should have recycled by then.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await flushAsync();

    expect(errs).toHaveLength(1);
    expect(currentSubscription).not.toBe(first);
    expect(reconnects.length).toBeGreaterThanOrEqual(1);

    currentSubscription!.emit('message', makePubsubMessage('c-2'));
    await flushAsync();
    expect(events.map((e) => e.comment.id)).toEqual(['c-1', 'c-2']);

    await handle.close();
  });

  // ─── L4 — Pure silent half-open (current production config) ────
  // Mirrors serve.ts: no idleReconnectMs is passed, so the watchdog
  // can ONLY detect !isOpen. If isOpen stays true while messages stop
  // arriving, nothing recovers. This is the regression we want to
  // surface — and the production-equivalent reproduction.
  //
  // EXPECTED (after fix): with production-equivalent settings, the
  // listener should still recover from a long idle stretch on its
  // own — either because serve.ts gains a sane idleReconnectMs
  // default, or because the listener does so internally.
  it('L4: with production-equivalent options, recovers from a long silent half-open stretch', async () => {
    const events: CommentEvent[] = [];
    const reconnects: Array<{ attempt: number; reason: string }> = [];
    const handle = listenForComments(
      'proj-1', 'sub-1', auth,
      (e) => events.push(e),
      undefined,
      {
        // Mirror serve.ts: no idleReconnectMs is passed there either,
        // so we omit it here. healthCheckIntervalMs default is 60s.
        reconnectInitialDelayMs: 1000,
        reconnectMaxDelayMs: 60_000,
        onReconnect: (info) => reconnects.push(info),
      },
    );

    const first = currentSubscription!;
    first.emit('message', makePubsubMessage('c-1'));
    await flushAsync();

    // Stream silently dies. No 'close', no 'error', isOpen still true.
    // Real-world cause: gRPC stream goes half-open after laptop sleep,
    // network change, refresh-token expiry the library swallows, etc.
    //
    // Advance 6 hours.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await flushAsync();

    // After 6 hours of silence, the listener should have given up on
    // the original subscription and reconnected at least once.
    expect(currentSubscription).not.toBe(first);
    expect(reconnects.length).toBeGreaterThanOrEqual(1);

    currentSubscription!.emit('message', makePubsubMessage('c-2'));
    await flushAsync();
    expect(events.map((e) => e.comment.id)).toEqual(['c-1', 'c-2']);

    await handle.close();
  });

  // ─── L5 — The fix: enable idleReconnectMs ─────────────────────
  it('L5: with idleReconnectMs configured, the listener recycles a silent half-open stream', async () => {
    const events: CommentEvent[] = [];
    const reconnects: Array<{ attempt: number; reason: string }> = [];
    const handle = listenForComments(
      'proj-1', 'sub-1', auth,
      (e) => events.push(e),
      undefined,
      {
        reconnectInitialDelayMs: 0,
        reconnectMaxDelayMs: 0,
        healthCheckIntervalMs: 1000,
        idleReconnectMs: 30 * 60 * 1000, // 30 minutes
        onReconnect: (info) => reconnects.push(info),
      },
    );

    const first = currentSubscription!;
    first.emit('message', makePubsubMessage('c-1'));
    await flushAsync();

    // Stream silently dies. Advance past the idle window.
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    await flushAsync();

    // Recovery should have fired via the idle path.
    expect(currentSubscription).not.toBe(first);
    expect(reconnects[0]?.reason).toContain('idle');

    currentSubscription!.emit('message', makePubsubMessage('c-2'));
    await flushAsync();

    expect(events.map((e) => e.comment.id)).toEqual(['c-1', 'c-2']);
    await handle.close();
  });
});
