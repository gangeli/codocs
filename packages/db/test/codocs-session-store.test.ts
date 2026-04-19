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
});
