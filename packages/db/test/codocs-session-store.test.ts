import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'sql.js';
import { openDatabase } from '../src/database.js';
import { CodocsSessionStore } from '../src/codocs-session-store.js';

describe('CodocsSessionStore', () => {
  let db: Database;
  let store: CodocsSessionStore;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    store = new CodocsSessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('listAll', () => {
    it('returns every session, newest first', () => {
      store.upsert('/a', ['d1'], 'claude');
      store.upsert('/b', ['d2'], 'claude');
      const all = store.listAll();
      expect(all).toHaveLength(2);
    });

    it('returns empty for fresh DB', () => {
      expect(store.listAll()).toEqual([]);
    });
  });

  describe('setDocIds', () => {
    it('replaces the doc ID list', () => {
      const s = store.upsert('/a', ['old-id'], 'claude');
      store.setDocIds(s.id, ['new-id-1', 'new-id-2']);
      const after = store.get(s.id);
      // upsert + setDocIds both sort JSON arrays
      expect(after!.docIds.sort()).toEqual(['new-id-1', 'new-id-2']);
    });
  });

  describe('delete', () => {
    it('removes the session and returns true', () => {
      const s = store.upsert('/a', ['d1'], 'claude');
      expect(store.delete(s.id)).toBe(true);
      expect(store.get(s.id)).toBeNull();
    });

    it('returns false for unknown id', () => {
      expect(store.delete('does-not-exist')).toBe(false);
    });
  });

  describe('upsert existing-session detection', () => {
    it('reuses session when directory + doc IDs match (in any order) and updates agent_type + last_used_at', () => {
      const first = store.upsert('/a', ['d1', 'd2'], 'claude');
      db.run(
        `UPDATE codocs_sessions SET last_used_at = '2020-01-01 00:00:00' WHERE id = ?`,
        [first.id],
      );
      const beforeRow = store.get(first.id)!;
      expect(beforeRow.lastUsedAt).toBe('2020-01-01 00:00:00');

      const second = store.upsert('/a', ['d2', 'd1'], 'opus');
      expect(second.id).toBe(first.id);

      const afterRow = store.get(first.id)!;
      expect(afterRow.agentType).toBe('opus');
      expect(afterRow.lastUsedAt > beforeRow.lastUsedAt).toBe(true);
    });

    it('creates a distinct session for a different directory even with the same doc IDs', () => {
      const a = store.upsert('/a', ['d1', 'd2'], 'claude');
      const b = store.upsert('/b', ['d1', 'd2'], 'claude');
      expect(b.id).not.toBe(a.id);
    });
  });

  describe('listByDirectory', () => {
    it('returns only sessions in the directory, newest first, and respects LIMIT', () => {
      const a1 = store.upsert('/a', ['d1'], 'claude');
      const a2 = store.upsert('/a', ['d2'], 'claude');
      const b1 = store.upsert('/b', ['d3'], 'claude');

      db.run(
        `UPDATE codocs_sessions SET last_used_at = '2020-01-01 00:00:01' WHERE id = ?`,
        [a1.id],
      );
      db.run(
        `UPDATE codocs_sessions SET last_used_at = '2020-01-01 00:00:03' WHERE id = ?`,
        [a2.id],
      );
      db.run(
        `UPDATE codocs_sessions SET last_used_at = '2020-01-01 00:00:02' WHERE id = ?`,
        [b1.id],
      );

      const listedA = store.listByDirectory('/a', 5);
      expect(listedA).toHaveLength(2);
      expect(listedA[0].id).toBe(a2.id);
      expect(listedA[1].id).toBe(a1.id);
      expect(listedA.every((s) => s.directory === '/a')).toBe(true);

      const listedOne = store.listByDirectory('/a', 1);
      expect(listedOne).toHaveLength(1);
      expect(listedOne[0].id).toBe(a2.id);
    });
  });

  describe('setDocTitle', () => {
    it('persists the title and is visible via get', () => {
      const s = store.upsert('/a', ['d1'], 'claude');
      expect(store.get(s.id)!.docTitle).toBeNull();
      store.setDocTitle(s.id, 'Design Doc');
      expect(store.get(s.id)!.docTitle).toBe('Design Doc');
    });
  });

  describe('get success-shape', () => {
    it('returns the full session shape with all fields', () => {
      const created = store.upsert('/a', ['d1', 'd2'], 'claude', 'Title');
      const fetched = store.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.directory).toBe('/a');
      expect(fetched!.docIds.sort()).toEqual(['d1', 'd2']);
      expect(fetched!.docTitle).toBe('Title');
      expect(fetched!.agentType).toBe('claude');
      expect(typeof fetched!.createdAt).toBe('string');
      expect(fetched!.createdAt.length).toBeGreaterThan(0);
      expect(typeof fetched!.lastUsedAt).toBe('string');
      expect(fetched!.lastUsedAt.length).toBeGreaterThan(0);
    });
  });
});
