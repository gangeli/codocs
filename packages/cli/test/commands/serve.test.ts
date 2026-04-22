import { describe, it, expect, vi } from 'vitest';
import { metaRestartShutdown, type MetaRestartShutdownCtx } from '../../src/commands/meta-restart.js';

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
