/**
 * Runner — registry of checks plus execution helpers.
 *
 * `runStartupChecks` is called from serve before connecting to anything;
 * it runs only checks whose scope is 'startup' or 'both'. `runHealthChecks`
 * runs all checks and is the entry point for `codocs repair`.
 */

import type { Check, Fix, FixResult, Issue, RepairContext } from './types.js';
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
} from './checks.js';

export const ALL_CHECKS: Check[] = [
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
];

export async function runStartupChecks(ctx: RepairContext): Promise<Issue[]> {
  const relevant = ALL_CHECKS.filter((c) => c.scope === 'startup' || c.scope === 'both');
  return runChecks(relevant, ctx);
}

export async function runHealthChecks(ctx: RepairContext): Promise<Issue[]> {
  return runChecks(ALL_CHECKS, ctx);
}

async function runChecks(checks: Check[], ctx: RepairContext): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const check of checks) {
    try {
      const found = await check.run(ctx);
      out.push(...found);
    } catch (err: any) {
      out.push({
        code: 'internal-check-failed',
        severity: 'warning',
        title: `Check "${check.id}" threw`,
        detail: err?.message ?? String(err),
        fixes: [],
      });
    }
  }
  return out;
}

export async function applyFix(
  fix: Fix,
  ctx: RepairContext,
  issue: Issue,
): Promise<FixResult> {
  try {
    return await fix.apply(ctx, issue);
  } catch (err: any) {
    return { ok: false, message: `Fix threw: ${err?.message ?? err}` };
  }
}

export function sortIssues(issues: Issue[]): Issue[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...issues].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
