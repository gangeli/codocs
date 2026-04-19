/**
 * Library of fixer functions. Each fix is self-contained and applied with
 * issue.context providing the targets (session ID, doc ID, queue item, etc.).
 *
 * Non-destructive fixes (e.g. resetStaleProcessing) can be auto-applied.
 * Destructive fixes require user confirmation in the TUI or --auto=false.
 */

import { saveDatabase } from '@codocs/db';
import { deleteSubscription } from '@codocs/core';
import type { Fix, FixResult, RepairContext, Issue } from './types.js';

function persist(ctx: RepairContext): void {
  saveDatabase(ctx.db, ctx.dbPath);
}

function readContext<T>(issue: Issue, key: string): T | undefined {
  return issue.context?.[key] as T | undefined;
}

// ── Session fixes ──────────────────────────────────────────────

export const deleteSessionFix: Fix = {
  id: 'delete-session',
  label: 'Delete this session',
  description: 'Remove the session entry from the local database. Cannot be undone.',
  destructive: true,
  async apply(ctx, issue): Promise<FixResult> {
    const sessionId = readContext<string>(issue, 'sessionId');
    if (!sessionId) return { ok: false, message: 'No sessionId in issue context' };
    const deleted = ctx.sessionStore.delete(sessionId);
    if (!deleted) return { ok: false, message: `Session ${sessionId} not found` };
    persist(ctx);
    ctx.debug(`Deleted session ${sessionId}`);
    return { ok: true, message: `Deleted session ${sessionId}` };
  },
};

export const stripDocIdFromSessionFix: Fix = {
  id: 'strip-docid-from-session',
  label: 'Remove this doc from the session',
  description: 'Drop the malformed doc ID from the session but keep the other docs (if any).',
  destructive: true,
  async apply(ctx, issue): Promise<FixResult> {
    const sessionId = readContext<string>(issue, 'sessionId');
    const badDocId = readContext<string>(issue, 'docId');
    if (!sessionId || !badDocId) {
      return { ok: false, message: 'Missing sessionId or docId in issue context' };
    }
    const session = ctx.sessionStore.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };
    const remaining = session.docIds.filter((d) => d !== badDocId);
    if (remaining.length === session.docIds.length) {
      return { ok: false, message: `Doc ${badDocId} was not in session ${sessionId}` };
    }
    if (remaining.length === 0) {
      ctx.sessionStore.delete(sessionId);
      persist(ctx);
      return {
        ok: true,
        message: `Removed last doc; deleted empty session ${sessionId}`,
      };
    }
    ctx.sessionStore.setDocIds(sessionId, remaining);
    persist(ctx);
    return {
      ok: true,
      message: `Removed doc ${badDocId} from session ${sessionId}`,
    };
  },
};

// ── Queue fixes ────────────────────────────────────────────────

export const resetStaleQueueFix: Fix = {
  id: 'reset-stale-queue',
  label: 'Reset stuck queue items',
  description: "Move items stuck in 'processing' back to 'pending' so they can be retried.",
  destructive: false,
  async apply(ctx): Promise<FixResult> {
    const count = ctx.queueStore.resetStaleProcessing();
    persist(ctx);
    return {
      ok: true,
      message: count > 0 ? `Reset ${count} stuck item(s)` : 'Nothing to reset',
    };
  },
};

export const purgeOldQueueFix: Fix = {
  id: 'purge-old-queue',
  label: 'Purge old completed items',
  description: 'Delete completed and failed queue items older than 30 days.',
  destructive: true,
  async apply(ctx): Promise<FixResult> {
    const thirtyDaysSec = 30 * 24 * 60 * 60;
    const count = ctx.queueStore.purgeOld(thirtyDaysSec);
    persist(ctx);
    return {
      ok: true,
      message: count > 0 ? `Purged ${count} old item(s)` : 'Nothing to purge',
    };
  },
};

// ── Code-task fixes ────────────────────────────────────────────

export const markCodeTaskCompletedFix: Fix = {
  id: 'mark-code-task-completed',
  label: 'Mark this code task completed',
  description: "Set the task's status to 'completed' so it stops appearing as stale.",
  destructive: true,
  async apply(ctx, issue): Promise<FixResult> {
    const id = readContext<number>(issue, 'codeTaskId');
    if (id == null) return { ok: false, message: 'No codeTaskId in issue context' };
    ctx.codeTaskStore.markCompleted(id);
    persist(ctx);
    return { ok: true, message: `Marked code task ${id} completed` };
  },
};

// ── Subscription fixes ─────────────────────────────────────────

export const deleteSubscriptionFix: Fix = {
  id: 'delete-subscription-gcp',
  label: 'Delete this subscription on GCP',
  description: 'Remove the Workspace Events subscription. A fresh one will be created on next start if needed.',
  destructive: true,
  async apply(ctx, issue): Promise<FixResult> {
    if (!ctx.auth) return { ok: false, message: 'Not authenticated — cannot call GCP' };
    const name = readContext<string>(issue, 'subscriptionName');
    if (!name) return { ok: false, message: 'No subscriptionName in issue context' };
    try {
      await deleteSubscription(ctx.auth, name);
    } catch (err: any) {
      return { ok: false, message: `Delete failed: ${err.message ?? err}` };
    }
    return { ok: true, message: `Deleted subscription ${name}` };
  },
};

// ── Auth fixes ─────────────────────────────────────────────────

export const relaunchAuthLoginFix: Fix = {
  id: 'relaunch-auth-login',
  label: 'Re-run `codocs auth login`',
  description: 'Prints the command to run. The interactive OAuth flow cannot run inside the repair TUI.',
  destructive: false,
  async apply(): Promise<FixResult> {
    return {
      ok: true,
      message: 'Quit the repair screen and run: codocs auth login',
    };
  },
};
