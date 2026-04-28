import { describe, it, expect } from 'vitest';
import {
  acquireServerLock,
  type ServerHeartbeat,
  type ServerLockClient,
} from '../../src/commands/server-lock.js';

/**
 * In-memory ServerLockClient that records calls so tests can assert on
 * what was set / queried. `getReturns` controls the response of the next
 * `getServerHeartbeat` call; `failGet` / `failSet` inject errors.
 */
function makeClient(opts?: {
  initial?: ServerHeartbeat | null;
  failGet?: Error;
  failSet?: Error;
}): {
  client: ServerLockClient;
  setCalls: Array<{ docId: string; serverHash: string }>;
  getCalls: string[];
} {
  let stored = opts?.initial ?? null;
  const setCalls: Array<{ docId: string; serverHash: string }> = [];
  const getCalls: string[] = [];

  const client: ServerLockClient = {
    async getServerHeartbeat(docId) {
      getCalls.push(docId);
      if (opts?.failGet) throw opts.failGet;
      return stored;
    },
    async setServerHeartbeat(docId, serverHash) {
      if (opts?.failSet) throw opts.failSet;
      setCalls.push({ docId, serverHash });
      stored = { timestamp: 1_000_000, serverHash };
    },
  };

  return { client, setCalls, getCalls };
}

describe('acquireServerLock', () => {
  const STALE_MS = 45_000;
  const NOW = 2_000_000;

  it('claims the lock when no heartbeat exists', async () => {
    const { client, setCalls } = makeClient({ initial: null });

    const result = await acquireServerLock(client, 'doc-A', 'hash-1', {
      staleMs: STALE_MS,
      now: () => NOW,
    });

    expect(result).toEqual({ kind: 'acquired', forced: false });
    expect(setCalls).toEqual([{ docId: 'doc-A', serverHash: 'hash-1' }]);
  });

  it('claims the lock when an existing heartbeat is stale', async () => {
    const { client, setCalls } = makeClient({
      initial: { timestamp: NOW - STALE_MS - 1, serverHash: 'old' },
    });

    const result = await acquireServerLock(client, 'doc-A', 'hash-new', {
      staleMs: STALE_MS,
      now: () => NOW,
    });

    expect(result).toEqual({ kind: 'acquired', forced: false });
    expect(setCalls).toEqual([{ docId: 'doc-A', serverHash: 'hash-new' }]);
  });

  it('reports "locked" when a fresh heartbeat is held by another server', async () => {
    const { client, setCalls } = makeClient({
      initial: { timestamp: NOW - 5_000, serverHash: 'other-server' },
    });

    const result = await acquireServerLock(client, 'doc-A', 'hash-new', {
      staleMs: STALE_MS,
      now: () => NOW,
    });

    expect(result.kind).toBe('locked');
    if (result.kind === 'locked') {
      expect(result.ageMs).toBe(5_000);
      expect(result.otherHash).toBe('other-server');
    }
    // Must NOT overwrite the other server's heartbeat.
    expect(setCalls).toEqual([]);
  });

  it('treats the boundary (age == staleMs) as stale and claims the lock', async () => {
    // Anything strictly less than staleMs is "fresh" — equality is stale.
    const { client, setCalls } = makeClient({
      initial: { timestamp: NOW - STALE_MS, serverHash: 'old' },
    });

    const result = await acquireServerLock(client, 'doc-A', 'hash-new', {
      staleMs: STALE_MS,
      now: () => NOW,
    });

    expect(result.kind).toBe('acquired');
    expect(setCalls.length).toBe(1);
  });

  describe('with --force-unlock', () => {
    it('claims the lock even when a fresh heartbeat exists, and reports forced=true', async () => {
      const { client, setCalls } = makeClient({
        initial: { timestamp: NOW - 1_000, serverHash: 'other-server' },
      });

      const result = await acquireServerLock(client, 'doc-A', 'hash-new', {
        staleMs: STALE_MS,
        force: true,
        now: () => NOW,
      });

      expect(result).toEqual({ kind: 'acquired', forced: true });
      // The other server's heartbeat is overwritten.
      expect(setCalls).toEqual([{ docId: 'doc-A', serverHash: 'hash-new' }]);
    });

    it('does not flag forced=true when there was nothing to bypass', async () => {
      const { client } = makeClient({ initial: null });

      const result = await acquireServerLock(client, 'doc-A', 'hash-new', {
        staleMs: STALE_MS,
        force: true,
        now: () => NOW,
      });

      // No prior holder — `forced` is false even though the flag was set,
      // so the CLI doesn't print a misleading "bypassed" message.
      expect(result).toEqual({ kind: 'acquired', forced: false });
    });

    it('does not flag forced=true when the prior heartbeat was already stale', async () => {
      const { client } = makeClient({
        initial: { timestamp: NOW - STALE_MS - 1, serverHash: 'crashed' },
      });

      const result = await acquireServerLock(client, 'doc-A', 'hash-new', {
        staleMs: STALE_MS,
        force: true,
        now: () => NOW,
      });

      expect(result).toEqual({ kind: 'acquired', forced: false });
    });
  });

  describe('error paths', () => {
    it('returns kind=error when getServerHeartbeat throws', async () => {
      const { client, setCalls } = makeClient({
        failGet: new Error('drive 503'),
      });

      const result = await acquireServerLock(client, 'doc-A', 'hash-1', {
        staleMs: STALE_MS,
        now: () => NOW,
      });

      expect(result).toEqual({ kind: 'error', message: 'drive 503' });
      expect(setCalls).toEqual([]);
    });

    it('returns kind=error when setServerHeartbeat throws', async () => {
      const { client } = makeClient({
        initial: null,
        failSet: new Error('appProperties write blocked'),
      });

      const result = await acquireServerLock(client, 'doc-A', 'hash-1', {
        staleMs: STALE_MS,
        now: () => NOW,
      });

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toBe('appProperties write blocked');
      }
    });
  });
});
