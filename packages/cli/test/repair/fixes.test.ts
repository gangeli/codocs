import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'sql.js';
import {
  openDatabase,
  CodocsSessionStore,
  QueueStore,
  CodeTaskStore,
} from '@codocs/db';
import {
  deleteSessionFix,
  stripDocIdFromSessionFix,
  resetStaleQueueFix,
  purgeOldQueueFix,
  markCodeTaskCompletedFix,
} from '../../src/repair/fixes.js';
import type { Issue, RepairContext } from '../../src/repair/types.js';

const VALID_DOC_A = '1'.repeat(44);
const VALID_DOC_B = '2'.repeat(44);
const BAD_DOC = '3'.repeat(45);

function makeCtx(db: Database): RepairContext {
  return {
    db,
    sessionStore: new CodocsSessionStore(db),
    queueStore: new QueueStore(db),
    codeTaskStore: new CodeTaskStore(db),
    config: { client_id: 'x', client_secret: 'x' },
    tokens: null,
    client: null,
    auth: null,
    cwd: '/tmp',
    targetDocIds: [],
    dbPath: ':memory:',
    debug: () => {},
  };
}

function issue(context: Record<string, unknown>): Issue {
  return {
    code: 'test',
    severity: 'error',
    title: 't',
    detail: 'd',
    context,
    fixes: [],
  };
}

describe('repair/fixes', () => {
  let db: Database;
  let ctx: RepairContext;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    ctx = makeCtx(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('deleteSessionFix', () => {
    it('deletes the session', async () => {
      const s = ctx.sessionStore.upsert('/cwd', [VALID_DOC_A], 'claude');
      const result = await deleteSessionFix.apply(ctx, issue({ sessionId: s.id }));
      expect(result.ok).toBe(true);
      expect(ctx.sessionStore.get(s.id)).toBeNull();
    });

    it('reports when session not found', async () => {
      const result = await deleteSessionFix.apply(ctx, issue({ sessionId: 'nope' }));
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not found/);
    });

    it('fails without sessionId context', async () => {
      const result = await deleteSessionFix.apply(ctx, issue({}));
      expect(result.ok).toBe(false);
    });
  });

  describe('stripDocIdFromSessionFix', () => {
    it('removes the bad doc and keeps the rest', async () => {
      const s = ctx.sessionStore.upsert('/cwd', [VALID_DOC_A, BAD_DOC], 'claude');
      const result = await stripDocIdFromSessionFix.apply(ctx, issue({
        sessionId: s.id, docId: BAD_DOC,
      }));
      expect(result.ok).toBe(true);
      const after = ctx.sessionStore.get(s.id);
      expect(after!.docIds).toEqual([VALID_DOC_A]);
    });

    it('deletes session when last doc is stripped', async () => {
      const s = ctx.sessionStore.upsert('/cwd', [BAD_DOC], 'claude');
      const result = await stripDocIdFromSessionFix.apply(ctx, issue({
        sessionId: s.id, docId: BAD_DOC,
      }));
      expect(result.ok).toBe(true);
      expect(ctx.sessionStore.get(s.id)).toBeNull();
      expect(result.message).toMatch(/deleted empty session/);
    });

    it('fails when doc not in session', async () => {
      const s = ctx.sessionStore.upsert('/cwd', [VALID_DOC_A], 'claude');
      const result = await stripDocIdFromSessionFix.apply(ctx, issue({
        sessionId: s.id, docId: VALID_DOC_B,
      }));
      expect(result.ok).toBe(false);
    });
  });

  describe('queue fixes', () => {
    it('resetStaleQueueFix resets processing items', async () => {
      ctx.queueStore.enqueue('alice', VALID_DOC_A, { event: 1 });
      ctx.queueStore.dequeue('alice');
      const result = await resetStaleQueueFix.apply(ctx, issue({}));
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/Reset 1/);
      expect(ctx.queueStore.isAgentBusy('alice')).toBe(false);
      expect(ctx.queueStore.peek('alice')).not.toBeNull();
      const reclaimed = ctx.queueStore.dequeue('alice');
      expect(reclaimed).not.toBeNull();
    });

    it('resetStaleQueueFix handles empty queue', async () => {
      const result = await resetStaleQueueFix.apply(ctx, issue({}));
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/Nothing to reset/);
    });

    it('purgeOldQueueFix is non-destructive on fresh queue', async () => {
      const result = await purgeOldQueueFix.apply(ctx, issue({}));
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/Nothing to purge/);
    });

    it('purgeOldQueueFix removes 60-day-old items but keeps recent ones', async () => {
      const recentId = ctx.queueStore.enqueue('alice', VALID_DOC_A, { event: 1 });
      ctx.queueStore.markCompleted(recentId);
      const oldId = ctx.queueStore.enqueue('alice', VALID_DOC_A, { event: 2 });
      ctx.queueStore.markCompleted(oldId);
      ctx.db.run(
        "UPDATE agent_queue SET completed_at = datetime('now','-60 days') WHERE id = ?",
        [oldId],
      );

      const result = await purgeOldQueueFix.apply(ctx, issue({}));
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/Purged 1/);

      const rows = ctx.db.exec('SELECT id FROM agent_queue ORDER BY id ASC');
      const remainingIds = rows[0]?.values.map((r) => r[0] as number) ?? [];
      expect(remainingIds).toEqual([recentId]);
    });
  });

  describe('markCodeTaskCompletedFix', () => {
    it('marks active task as completed', async () => {
      const id = ctx.codeTaskStore.create({
        documentId: VALID_DOC_A,
        commentId: 'c1',
        agentName: 'alice',
        branchName: 'feat/x',
        worktreePath: '/tmp/wt',
        baseBranch: 'main',
      });
      const result = await markCodeTaskCompletedFix.apply(ctx, issue({ codeTaskId: id }));
      expect(result.ok).toBe(true);
      // active tasks for alice should now be empty
      expect(ctx.codeTaskStore.getActiveByAgent('alice')).toHaveLength(0);
    });

    it('fails without codeTaskId', async () => {
      const result = await markCodeTaskCompletedFix.apply(ctx, issue({}));
      expect(result.ok).toBe(false);
    });
  });
});
