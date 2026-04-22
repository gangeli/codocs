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
  expiredSubscriptions,
} from '../../src/repair/checks.js';
import type { RepairContext } from '../../src/repair/types.js';

vi.mock('@codocs/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codocs/core')>();
  return {
    ...actual,
    listSubscriptions: vi.fn(),
  };
});

import { listSubscriptions } from '@codocs/core';

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

    it('reports only gcp_project_id when pubsub_topic is set but gcp_project_id is missing', async () => {
      const ctx = makeCtx(db, {
        config: { client_id: 'x', client_secret: 'x', pubsub_topic: 't' } as any,
      });
      const issues = await configHasGcp.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].context).toEqual({ missing: ['gcp_project_id'] });
    });

    it('reports only pubsub_topic when gcp_project_id is set but pubsub_topic is missing', async () => {
      const ctx = makeCtx(db, {
        config: { client_id: 'x', client_secret: 'x', gcp_project_id: 'p' } as any,
      });
      const issues = await configHasGcp.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].context).toEqual({ missing: ['pubsub_topic'] });
    });

    it('treats empty-string values as missing', async () => {
      const ctx = makeCtx(db, {
        config: { client_id: 'x', client_secret: 'x', gcp_project_id: '', pubsub_topic: '' },
      });
      const issues = await configHasGcp.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].context).toEqual({ missing: ['gcp_project_id', 'pubsub_topic'] });
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
      expect(issues[0].fixes.map((f) => f.id)).toEqual([
        'strip-docid-from-session',
        'delete-session',
      ]);
    });

    it('offers quit-program when the bad doc was not from a session', async () => {
      const ctx = makeCtx(db, { targetDocIds: [BAD_DOC] });
      const issues = await targetDocIdWellformed.run(ctx);
      expect(issues[0].fixes.map((f) => f.id)).toEqual(['quit-program']);
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

    it('emits a reachability warning when getDocument rejects', async () => {
      const store = new CodocsSessionStore(db);
      store.upsert('/tmp', [VALID_DOC], 'claude');
      const mockClient = {
        getDocument: vi.fn().mockRejectedValue(new Error('404 Not found')),
      } as any;
      const ctx = makeCtx(db, { client: mockClient });
      const issues = await sessionsWithBadDocIds.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].code).toBe('unreachable-session-docid');
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
      const queueStore = new QueueStore(db);
      const id = queueStore.enqueue('alice', 'doc', { event: 1 });
      queueStore.dequeue('alice');
      db.run(
        "UPDATE agent_queue SET started_at = datetime('now','-2 hours') WHERE id = ?",
        [id],
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

    it('does not flag recently-completed rows', async () => {
      db.run(
        `INSERT INTO agent_queue (agent_name, document_id, comment_event, status, completed_at)
         VALUES ('alice', 'doc', '{}', 'completed', datetime('now', '-1 days'))`,
      );
      const ctx = makeCtx(db);
      expect(await oldCompletedQueueItems.run(ctx)).toEqual([]);
    });
  });

  describe('staleCodeTasks', () => {
    it('flags tasks older than 14 days', async () => {
      db.run(
        `INSERT INTO code_tasks (document_id, comment_id, agent_name, branch_name, worktree_path, base_branch, updated_at)
         VALUES ('d1', 'c1', 'alice', 'b', '/tmp', 'main', datetime('now', '-30 days'))`,
      );
      const rows = db.exec('SELECT id FROM code_tasks');
      const expectedId = rows[0]?.values[0]?.[0] as number;
      const ctx = makeCtx(db);
      const issues = await staleCodeTasks.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('stale-code-task');
      expect(issues[0].context).toMatchObject({ codeTaskId: expectedId });
    });
  });

  describe('expiredSubscriptions', () => {
    beforeEach(() => {
      (listSubscriptions as any).mockReset();
    });

    it('flags expired subscriptions', async () => {
      const store = new CodocsSessionStore(db);
      store.upsert('/tmp', [VALID_DOC], 'claude');
      (listSubscriptions as any).mockResolvedValue([
        {
          name: 'subscriptions/abc',
          expireTime: new Date(Date.now() - 60_000).toISOString(),
        },
      ]);
      const ctx = makeCtx(db, { auth: {} as any });
      const issues = await expiredSubscriptions.run(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('expired-subscription');
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].context).toMatchObject({
        subscriptionName: 'subscriptions/abc',
        docId: VALID_DOC,
      });
    });

    it('does not flag non-expired subscriptions', async () => {
      const store = new CodocsSessionStore(db);
      store.upsert('/tmp', [VALID_DOC], 'claude');
      (listSubscriptions as any).mockResolvedValue([
        {
          name: 'subscriptions/future',
          expireTime: new Date(Date.now() + 60_000).toISOString(),
        },
      ]);
      const ctx = makeCtx(db, { auth: {} as any });
      expect(await expiredSubscriptions.run(ctx)).toEqual([]);
    });

    it('swallows listSubscriptions rejection without crashing', async () => {
      const store = new CodocsSessionStore(db);
      store.upsert('/tmp', [VALID_DOC], 'claude');
      (listSubscriptions as any).mockRejectedValue(new Error('API down'));
      const ctx = makeCtx(db, { auth: {} as any });
      await expect(expiredSubscriptions.run(ctx)).resolves.toEqual([]);
    });
  });
});
