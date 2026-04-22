import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'sql.js';
import {
  openDatabase,
  CodocsSessionStore,
  QueueStore,
  CodeTaskStore,
} from '@codocs/db';
import { runStartupChecks, runHealthChecks, runChecks, applyFix, sortIssues } from '../../src/repair/runner.js';
import type { Check, Fix, Issue, RepairContext } from '../../src/repair/types.js';

function makeCtx(db: Database): RepairContext {
  return {
    db,
    sessionStore: new CodocsSessionStore(db),
    queueStore: new QueueStore(db),
    codeTaskStore: new CodeTaskStore(db),
    config: { client_id: 'x', client_secret: 'x', gcp_project_id: 'p', pubsub_topic: 't' },
    tokens: { access_token: 'a', refresh_token: 'r' },
    client: null,
    auth: null,
    cwd: '/tmp',
    targetDocIds: [],
    dbPath: ':memory:',
    debug: () => {},
  };
}

describe('repair/runner', () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('runStartupChecks returns no error issues on a clean system', async () => {
    const ctx = makeCtx(db);
    const issues = await runStartupChecks(ctx);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('runHealthChecks runs without throwing on a clean system', async () => {
    const ctx = makeCtx(db);
    const issues = await runHealthChecks(ctx);
    // No error-severity issues on a clean in-memory DB.
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('applyFix wraps thrown errors', async () => {
    const ctx = makeCtx(db);
    const throwingFix: Fix = {
      id: 'throws',
      label: 't',
      description: 'd',
      destructive: false,
      async apply() {
        throw new Error('boom');
      },
    };
    const issue: Issue = { code: 't', severity: 'error', title: 't', detail: 'd', fixes: [] };
    const result = await applyFix(throwingFix, ctx, issue);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/boom/);
  });

  it('applyFix passes through a successful result unchanged', async () => {
    const ctx = makeCtx(db);
    const okFix: Fix = {
      id: 'ok',
      label: 'o',
      description: 'd',
      destructive: false,
      async apply() {
        return { ok: true, message: 'done' };
      },
    };
    const issue: Issue = { code: 'o', severity: 'info', title: 'o', detail: 'd', fixes: [] };
    const result = await applyFix(okFix, ctx, issue);
    expect(result).toEqual({ ok: true, message: 'done' });
  });

  it('sortIssues orders by severity', () => {
    const issues: Issue[] = [
      { code: 'a', severity: 'info', title: 'a', detail: '', fixes: [] },
      { code: 'b', severity: 'error', title: 'b', detail: '', fixes: [] },
      { code: 'c', severity: 'warning', title: 'c', detail: '', fixes: [] },
    ];
    const sorted = sortIssues(issues);
    expect(sorted.map((i) => i.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('sortIssues preserves relative order of equal-severity issues', () => {
    const issues: Issue[] = [
      { code: 'err-1', severity: 'error', title: 'e1', detail: '', fixes: [] },
      { code: 'info-1', severity: 'info', title: 'i1', detail: '', fixes: [] },
      { code: 'err-2', severity: 'error', title: 'e2', detail: '', fixes: [] },
      { code: 'warn-1', severity: 'warning', title: 'w1', detail: '', fixes: [] },
      { code: 'err-3', severity: 'error', title: 'e3', detail: '', fixes: [] },
    ];
    const sorted = sortIssues(issues);
    expect(sorted.map((i) => i.code)).toEqual([
      'err-1',
      'err-2',
      'err-3',
      'warn-1',
      'info-1',
    ]);
  });

  it('converts check throws into internal-check-failed issues', async () => {
    const ctx = makeCtx(db);
    const throwing: Check = {
      id: 'throws',
      description: 'x',
      scope: 'both',
      async run() {
        throw new Error('kaboom');
      },
    };
    const issues = await runChecks([throwing], ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('internal-check-failed');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].title).toBe('Check "throws" threw');
    expect(issues[0].detail).toMatch(/kaboom/);
    expect(issues[0].fixes).toEqual([]);
  });
});
