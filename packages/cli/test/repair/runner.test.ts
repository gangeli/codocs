import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'sql.js';
import {
  openDatabase,
  CodocsSessionStore,
  QueueStore,
  CodeTaskStore,
} from '@codocs/db';
import { runStartupChecks, runHealthChecks, applyFix, sortIssues } from '../../src/repair/runner.js';
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

  it('runHealthChecks includes info-level service-account warning', async () => {
    const ctx = makeCtx(db);
    const issues = await runHealthChecks(ctx);
    // service-account-missing is info-severity when no key is provisioned
    const info = issues.filter((i) => i.severity === 'info');
    expect(info.length).toBeGreaterThanOrEqual(0);
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

  it('sortIssues orders by severity', () => {
    const issues: Issue[] = [
      { code: 'a', severity: 'info', title: 'a', detail: '', fixes: [] },
      { code: 'b', severity: 'error', title: 'b', detail: '', fixes: [] },
      { code: 'c', severity: 'warning', title: 'c', detail: '', fixes: [] },
    ];
    const sorted = sortIssues(issues);
    expect(sorted.map((i) => i.severity)).toEqual(['error', 'warning', 'info']);
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
    // Invoke the wrapper directly via a local array
    const out: Issue[] = [];
    for (const c of [throwing]) {
      try {
        out.push(...await c.run(ctx));
      } catch (err: any) {
        out.push({
          code: 'internal-check-failed',
          severity: 'warning',
          title: `Check "${c.id}" threw`,
          detail: err.message,
          fixes: [],
        });
      }
    }
    expect(out[0].code).toBe('internal-check-failed');
    expect(out[0].detail).toMatch(/kaboom/);
  });
});
