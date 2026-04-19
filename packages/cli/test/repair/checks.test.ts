import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { Database } from 'sql.js';
import {
  openDatabase,
  CodocsSessionStore,
  QueueStore,
  CodeTaskStore,
} from '@codocs/db';
import {
  authTokensPresent,
  configHasGcp,
  targetDocIdWellformed,
  targetDocIdAccessible,
  sessionsWithBadDocIds,
  sessionsForMissingDirectories,
  staleQueueItems,
  oldCompletedQueueItems,
  staleCodeTasks,
} from '../../src/repair/checks.js';
import type { RepairContext } from '../../src/repair/types.js';

const VALID_DOC = '1'.repeat(44);
const BAD_DOC = '2'.repeat(45);

function makeCtx(db: Database, overrides: Partial<RepairContext> = {}): RepairContext {
  return {
    db,
    sessionStore: new CodocsSessionStore(db),
    queueStore: new QueueStore(db),
    codeTaskStore: new CodeTaskStore(db),
    config: { client_id: 'x', client_secret: 'x', gcp_project_id: 'proj', pubsub_topic: 'tp' },
    tokens: { access_token: 'a', refresh_token: 'r' },
    client: null,
    auth: null,
    cwd: '/tmp',
    targetDocIds: [],
    dbPath: ':memory:',
    debug: () => {},
    ...overrides,
  };
}

describe('repair/checks', () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('authTokensPresent', () => {
    it('returns nothing when tokens are present', async () => {
      const ctx = makeCtx(db);
      expect(await authTokensPresent.run(ctx)).toEqual([]);
    });

    it('returns an error issue when tokens are missing', async () => {
      const ctx = makeCtx(db, { tokens: null });
      const issues = await authTokensPresent.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('error');
      expect(issues[0].code).toBe('auth-tokens-missing');
    });
  });

  describe('configHasGcp', () => {
    it('reports missing keys', async () => {
      const ctx = makeCtx(db, {
        config: { client_id: 'x', client_secret: 'x' },
      });
      const issues = await configHasGcp.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].context).toMatchObject({ missing: ['gcp_project_id', 'pubsub_topic'] });
    });

    it('passes when everything is set', async () => {
      const ctx = makeCtx(db);
      expect(await configHasGcp.run(ctx)).toEqual([]);
    });
  });

  describe('targetDocIdWellformed', () => {
    it('flags a 45-char doc ID', async () => {
      const ctx = makeCtx(db, { targetDocIds: [BAD_DOC] });
      const issues = await targetDocIdWellformed.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('invalid-target-docid');
      expect(issues[0].context).toMatchObject({ docId: BAD_DOC });
    });

    it('passes a 44-char doc ID', async () => {
      const ctx = makeCtx(db, { targetDocIds: [VALID_DOC] });
      expect(await targetDocIdWellformed.run(ctx)).toEqual([]);
    });

    it('attaches session context when the bad doc came from a session', async () => {
      const store = new CodocsSessionStore(db);
      const session = store.upsert('/cwd', [BAD_DOC], 'claude');
      const ctx = makeCtx(db, { targetDocIds: [BAD_DOC] });
      const issues = await targetDocIdWellformed.run(ctx);
      expect(issues[0].context).toMatchObject({ sessionId: session.id });
      expect(issues[0].fixes.length).toBeGreaterThan(0);
    });
  });

  describe('targetDocIdAccessible', () => {
    it('skips when no client', async () => {
      const ctx = makeCtx(db, { targetDocIds: [VALID_DOC], client: null });
      expect(await targetDocIdAccessible.run(ctx)).toEqual([]);
    });

    it('flags 404 errors', async () => {
      const mockClient = {
        getDocument: vi.fn().mockRejectedValue(new Error('404 Not found')),
      } as any;
      const ctx = makeCtx(db, { targetDocIds: [VALID_DOC], client: mockClient });
      const issues = await targetDocIdAccessible.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].title).toMatch(/no longer exists/);
    });

    it('passes when getDocument succeeds', async () => {
      const mockClient = {
        getDocument: vi.fn().mockResolvedValue({ title: 'ok' }),
      } as any;
      const ctx = makeCtx(db, { targetDocIds: [VALID_DOC], client: mockClient });
      expect(await targetDocIdAccessible.run(ctx)).toEqual([]);
    });

    it('skips malformed IDs (wellformed check will flag)', async () => {
      const mockClient = { getDocument: vi.fn() };
      const ctx = makeCtx(db, { targetDocIds: [BAD_DOC], client: mockClient as any });
      expect(await targetDocIdAccessible.run(ctx)).toEqual([]);
      expect(mockClient.getDocument).not.toHaveBeenCalled();
    });
  });

  describe('sessionsWithBadDocIds', () => {
    it('flags every malformed doc across every session', async () => {
      const store = new CodocsSessionStore(db);
      store.upsert('/a', [BAD_DOC], 'claude');
      store.upsert('/b', [VALID_DOC], 'claude');
      const ctx = makeCtx(db);
      const issues = await sessionsWithBadDocIds.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('invalid-session-docid');
    });
  });

  describe('sessionsForMissingDirectories', () => {
    it('flags sessions pointing at non-existent dirs', async () => {
      const store = new CodocsSessionStore(db);
      store.upsert('/this/path/does/not/exist/ever', [VALID_DOC], 'claude');
      const ctx = makeCtx(db);
      const issues = await sessionsForMissingDirectories.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
    });

    it('passes existing dirs', async () => {
      const store = new CodocsSessionStore(db);
      // /tmp exists on macOS/Linux
      expect(existsSync('/tmp')).toBe(true);
      store.upsert('/tmp', [VALID_DOC], 'claude');
      const ctx = makeCtx(db);
      expect(await sessionsForMissingDirectories.run(ctx)).toEqual([]);
    });
  });

  describe('staleQueueItems', () => {
    it('returns nothing on a fresh queue', async () => {
      const ctx = makeCtx(db);
      expect(await staleQueueItems.run(ctx)).toEqual([]);
    });

    it('flags processing items older than 30 minutes', async () => {
      // Insert a processing row with an old started_at.
      db.run(
        `INSERT INTO agent_queue (agent_name, document_id, comment_event, status, started_at)
         VALUES ('alice', 'doc', '{}', 'processing', datetime('now', '-2 hours'))`,
      );
      const ctx = makeCtx(db);
      const issues = await staleQueueItems.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].context).toMatchObject({ count: 1 });
    });
  });

  describe('oldCompletedQueueItems', () => {
    it('flags old completed rows', async () => {
      db.run(
        `INSERT INTO agent_queue (agent_name, document_id, comment_event, status, completed_at)
         VALUES ('alice', 'doc', '{}', 'completed', datetime('now', '-60 days'))`,
      );
      const ctx = makeCtx(db);
      const issues = await oldCompletedQueueItems.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('info');
    });
  });

  describe('staleCodeTasks', () => {
    it('flags tasks older than 14 days', async () => {
      db.run(
        `INSERT INTO code_tasks (document_id, comment_id, agent_name, branch_name, worktree_path, base_branch, updated_at)
         VALUES ('d1', 'c1', 'alice', 'b', '/tmp', 'main', datetime('now', '-30 days'))`,
      );
      const ctx = makeCtx(db);
      const issues = await staleCodeTasks.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('stale-code-task');
    });
  });
});
