import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, AgentNameStore } from '@codocs/db';
import type { Database } from 'sql.js';
import { makeFallbackAgentResolver } from '../../src/agent/fallback-resolver.js';

describe('makeFallbackAgentResolver', () => {
  let db: Database;
  let store: AgentNameStore;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    store = new AgentNameStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('assigns a different agent to each comment thread', () => {
    let counter = 0;
    const generate = () => `gen-${++counter}`;
    const resolve = makeFallbackAgentResolver(store, generate);

    const a = resolve('doc-1', 'thread-A');
    const b = resolve('doc-1', 'thread-B');
    const c = resolve('doc-1', 'thread-C');

    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('reuses the same agent for replies on the same thread', () => {
    let counter = 0;
    const generate = () => `gen-${++counter}`;
    const resolve = makeFallbackAgentResolver(store, generate);

    const first = resolve('doc-1', 'thread-A');
    const reply1 = resolve('doc-1', 'thread-A');
    const reply2 = resolve('doc-1', 'thread-A');

    expect(reply1).toBe(first);
    expect(reply2).toBe(first);
    expect(counter).toBe(1);
  });

  it('keeps comment-thread agents separate across documents', () => {
    let counter = 0;
    const generate = () => `gen-${++counter}`;
    const resolve = makeFallbackAgentResolver(store, generate);

    const onDoc1 = resolve('doc-1', 'thread-A');
    const onDoc2 = resolve('doc-2', 'thread-A');

    expect(onDoc1).not.toBe(onDoc2);
  });

  it('falls back to a per-document slot when commentId is missing', () => {
    let counter = 0;
    const generate = () => `gen-${++counter}`;
    const resolve = makeFallbackAgentResolver(store, generate);

    const a = resolve('doc-1', undefined);
    const b = resolve('doc-1', undefined);
    const onDoc2 = resolve('doc-2', undefined);

    expect(a).toBe(b);
    expect(a).not.toBe(onDoc2);
  });

  it('reuses an existing stored name without regenerating', () => {
    store.setName('doc-1', 'comment:thread-A', 'preexisting-name');
    const generate = () => {
      throw new Error('generator should not be called');
    };
    const resolve = makeFallbackAgentResolver(store, generate);

    expect(resolve('doc-1', 'thread-A')).toBe('preexisting-name');
  });
});
