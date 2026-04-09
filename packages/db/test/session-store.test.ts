import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../src/database.js';
import { SessionStore } from '../src/session-store.js';
import type { Database } from 'sql.js';

describe('SessionStore', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    store = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns null for nonexistent session', () => {
    const result = store.getSession('coder', 'doc-123');
    expect(result).toBeNull();
  });

  it('creates and retrieves a session', () => {
    store.upsertSession('coder', 'doc-123', 'session-abc');
    const result = store.getSession('coder', 'doc-123');

    expect(result).not.toBeNull();
    expect(result!.agentName).toBe('coder');
    expect(result!.documentId).toBe('doc-123');
    expect(result!.sessionId).toBe('session-abc');
    expect(result!.createdAt).toBeTruthy();
    expect(result!.lastUsedAt).toBeTruthy();
  });

  it('upserts an existing session with new session ID', () => {
    store.upsertSession('coder', 'doc-123', 'session-old');
    store.upsertSession('coder', 'doc-123', 'session-new');

    const result = store.getSession('coder', 'doc-123');
    expect(result!.sessionId).toBe('session-new');
  });

  it('maintains separate sessions per agent per document', () => {
    store.upsertSession('coder', 'doc-1', 'session-1');
    store.upsertSession('reviewer', 'doc-1', 'session-2');
    store.upsertSession('coder', 'doc-2', 'session-3');

    expect(store.getSession('coder', 'doc-1')!.sessionId).toBe('session-1');
    expect(store.getSession('reviewer', 'doc-1')!.sessionId).toBe('session-2');
    expect(store.getSession('coder', 'doc-2')!.sessionId).toBe('session-3');
  });

  it('touches last_used_at without changing session_id', () => {
    store.upsertSession('coder', 'doc-123', 'session-abc');
    const before = store.getSession('coder', 'doc-123')!;

    store.touchSession('coder', 'doc-123');
    const after = store.getSession('coder', 'doc-123')!;

    expect(after.sessionId).toBe('session-abc');
    expect(after.lastUsedAt).toBeTruthy();
  });

  it('deletes a session', () => {
    store.upsertSession('coder', 'doc-123', 'session-abc');
    store.deleteSession('coder', 'doc-123');

    expect(store.getSession('coder', 'doc-123')).toBeNull();
  });

  it('delete is a no-op for nonexistent session', () => {
    store.deleteSession('coder', 'doc-123');
  });
});
