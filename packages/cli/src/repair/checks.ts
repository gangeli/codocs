/**
 * Individual check functions. Each returns an Issue[]; empty means healthy.
 * Checks must be defensive — throwing gets converted to an
 * `internal-check-failed` issue by the runner.
 */

import { existsSync } from 'node:fs';
import { listSubscriptions } from '@codocs/core';
import type { Check, Issue, RepairContext } from './types.js';
import {
  deleteSessionFix,
  stripDocIdFromSessionFix,
  quitProgramFix,
  resetStaleQueueFix,
  purgeOldQueueFix,
  markCodeTaskCompletedFix,
  deleteSubscriptionFix,
  relaunchAuthLoginFix,
} from './fixes.js';

// Google Doc IDs are 44 characters. A narrow band catches real corruption
// (the user's trailing-A bug was a 45-char ID) while tolerating tiny
// future variations.
const DOCID_REGEX = /^[a-zA-Z0-9_-]{40,44}$/;

function isWellformedDocId(id: string): boolean {
  return DOCID_REGEX.test(id);
}

// ── Auth / config ──────────────────────────────────────────────

export const authTokensPresent: Check = {
  id: 'auth-tokens-present',
  description: 'OAuth tokens are present on disk',
  scope: 'both',
  async run(ctx): Promise<Issue[]> {
    if (ctx.tokens) return [];
    return [{
      code: 'auth-tokens-missing',
      severity: 'error',
      title: 'Not signed in to Google',
      detail: 'No OAuth tokens were found. Codocs needs to authenticate with Google before it can talk to Docs or Pub/Sub.',
      fixes: [relaunchAuthLoginFix],
    }];
  },
};

export const configHasGcp: Check = {
  id: 'config-has-gcp',
  description: 'Config has gcp_project_id and pubsub_topic',
  scope: 'both',
  async run(ctx): Promise<Issue[]> {
    const missing: string[] = [];
    if (!ctx.config.gcp_project_id) missing.push('gcp_project_id');
    if (!ctx.config.pubsub_topic) missing.push('pubsub_topic');
    if (missing.length === 0) return [];
    return [{
      code: 'config-gcp-missing',
      severity: 'error',
      title: `Config is missing ${missing.join(', ')}`,
      detail: 'Codocs needs a Google Cloud project and Pub/Sub topic to receive comment events. Re-run `codocs auth login` to restore the defaults, or edit ~/.config/codocs/config.json by hand.',
      context: { missing },
      fixes: [relaunchAuthLoginFix],
    }];
  },
};

// ── Target doc ID checks (startup-scope) ───────────────────────

export const targetDocIdWellformed: Check = {
  id: 'target-docid-wellformed',
  description: 'Each target doc ID matches the expected format',
  scope: 'startup',
  async run(ctx): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (const docId of ctx.targetDocIds) {
      if (isWellformedDocId(docId)) continue;
      const session = findSessionWithDocId(ctx, docId);
      issues.push({
        code: 'invalid-target-docid',
        severity: 'error',
        title: `Doc ID "${docId.slice(0, 40)}${docId.length > 40 ? '…' : ''}" is malformed`,
        detail: [
          `Google Doc IDs are 44 alphanumeric characters. The ID we're about to connect to is ${docId.length} characters, so the Workspace Events API will reject it with INVALID_ARGUMENT.`,
          session ? `It came from session "${session.id}" in ${session.directory}.` : 'It was passed directly on the command line.',
        ].join(' '),
        context: { docId, sessionId: session?.id },
        fixes: session
          ? [stripDocIdFromSessionFix, deleteSessionFix]
          : [quitProgramFix],
      });
    }
    return issues;
  },
};

export const targetDocIdAccessible: Check = {
  id: 'target-docid-accessible',
  description: 'Each target doc ID is reachable via Google Docs API',
  scope: 'startup',
  async run(ctx): Promise<Issue[]> {
    if (!ctx.client) return [];
    const issues: Issue[] = [];
    for (const docId of ctx.targetDocIds) {
      if (!isWellformedDocId(docId)) continue; // wellformed check will flag
      try {
        await ctx.client.getDocument(docId);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const session = findSessionWithDocId(ctx, docId);
        const is404 = /404|not found/i.test(msg);
        const is403 = /403|permission/i.test(msg);
        issues.push({
          code: 'target-docid-unreachable',
          severity: 'error',
          title: is404
            ? `Doc "${docId.slice(0, 20)}…" no longer exists`
            : is403
            ? `No access to doc "${docId.slice(0, 20)}…"`
            : `Doc "${docId.slice(0, 20)}…" could not be fetched`,
          detail: `Google responded: ${msg}${session ? `\n\nThe doc is referenced by session "${session.id}".` : ''}`,
          context: { docId, sessionId: session?.id },
          fixes: session
            ? [stripDocIdFromSessionFix, deleteSessionFix]
            : [],
        });
      }
    }
    return issues;
  },
};

// ── Session checks (health-scope) ──────────────────────────────

export const sessionsWithBadDocIds: Check = {
  id: 'sessions-with-bad-docids',
  description: 'All stored sessions reference valid doc IDs',
  scope: 'health',
  async run(ctx): Promise<Issue[]> {
    const issues: Issue[] = [];
    const sessions = ctx.sessionStore.listAll();
    for (const session of sessions) {
      for (const docId of session.docIds) {
        if (!isWellformedDocId(docId)) {
          issues.push({
            code: 'invalid-session-docid',
            severity: 'error',
            title: `Session "${session.id}" has a malformed doc ID`,
            detail: `Doc ID "${docId}" is ${docId.length} chars (expected ~44). Session directory: ${session.directory}.`,
            context: { sessionId: session.id, docId },
            fixes: [stripDocIdFromSessionFix, deleteSessionFix],
          });
          continue;
        }
        // Reachability check is expensive; only attempt if we have a client.
        if (!ctx.client) continue;
        try {
          await ctx.client.getDocument(docId);
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          issues.push({
            code: 'unreachable-session-docid',
            severity: 'warning',
            title: `Session "${session.id}" references an unreachable doc`,
            detail: `Doc ID "${docId}" — Google responded: ${msg}`,
            context: { sessionId: session.id, docId },
            fixes: [stripDocIdFromSessionFix, deleteSessionFix],
          });
        }
      }
    }
    return issues;
  },
};

export const sessionsForMissingDirectories: Check = {
  id: 'sessions-for-missing-directories',
  description: 'Session directories still exist on disk',
  scope: 'health',
  async run(ctx): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (const session of ctx.sessionStore.listAll()) {
      if (existsSync(session.directory)) continue;
      issues.push({
        code: 'session-directory-missing',
        severity: 'warning',
        title: `Session "${session.id}" points at a missing directory`,
        detail: `The directory "${session.directory}" no longer exists. You may have moved or deleted the repo.`,
        context: { sessionId: session.id, directory: session.directory },
        fixes: [deleteSessionFix],
      });
    }
    return issues;
  },
};

// ── Queue checks (health-scope) ────────────────────────────────

export const staleQueueItems: Check = {
  id: 'stale-queue-items',
  description: "Queue items have not been stuck in 'processing'",
  scope: 'health',
  async run(ctx): Promise<Issue[]> {
    const rows = ctx.db.exec(
      "SELECT COUNT(*) FROM agent_queue WHERE status = 'processing' AND started_at < datetime('now', '-30 minutes')",
    );
    const count = (rows[0]?.values[0]?.[0] as number | undefined) ?? 0;
    if (count === 0) return [];
    return [{
      code: 'stale-queue-items',
      severity: 'warning',
      title: `${count} queue item(s) stuck in 'processing' for over 30 minutes`,
      detail: "These were probably orphaned by a crashed run. Resetting them moves them back to 'pending' so they'll be retried.",
      context: { count },
      fixes: [resetStaleQueueFix],
    }];
  },
};

export const oldCompletedQueueItems: Check = {
  id: 'old-completed-queue-items',
  description: 'Completed/failed queue items are not piling up',
  scope: 'health',
  async run(ctx): Promise<Issue[]> {
    const rows = ctx.db.exec(
      "SELECT COUNT(*) FROM agent_queue WHERE status IN ('completed', 'failed') AND completed_at < datetime('now', '-30 days')",
    );
    const count = (rows[0]?.values[0]?.[0] as number | undefined) ?? 0;
    if (count === 0) return [];
    return [{
      code: 'old-completed-queue-items',
      severity: 'info',
      title: `${count} queue item(s) completed over 30 days ago`,
      detail: 'These are safe to purge; they exist only for debugging past runs.',
      context: { count },
      fixes: [purgeOldQueueFix],
    }];
  },
};

// ── Code-task checks (health-scope) ────────────────────────────

export const staleCodeTasks: Check = {
  id: 'stale-code-tasks',
  description: "No 'active' code tasks older than 14 days",
  scope: 'health',
  async run(ctx): Promise<Issue[]> {
    const stale = ctx.codeTaskStore.getStale(14);
    return stale.map((task) => ({
      code: 'stale-code-task',
      severity: 'warning' as const,
      title: `Code task #${task.id} has been active for over 14 days`,
      detail: `Branch: ${task.branchName} · Doc: ${task.documentId}${task.prUrl ? ` · PR: ${task.prUrl}` : ''}. If the PR is merged/closed, mark it complete.`,
      context: { codeTaskId: task.id },
      fixes: [markCodeTaskCompletedFix],
    }));
  },
};

// ── Subscription checks (health-scope) ─────────────────────────

export const expiredSubscriptions: Check = {
  id: 'expired-subscriptions',
  description: 'No expired subscriptions are registered on GCP',
  scope: 'health',
  async run(ctx): Promise<Issue[]> {
    if (!ctx.auth) return [];
    const issues: Issue[] = [];
    const seenDocs = new Set<string>();
    for (const session of ctx.sessionStore.listAll()) {
      for (const docId of session.docIds) {
        if (seenDocs.has(docId) || !isWellformedDocId(docId)) continue;
        seenDocs.add(docId);
        try {
          const subs = await listSubscriptions(ctx.auth, docId);
          const now = Date.now();
          for (const sub of subs) {
            const expires = sub.expireTime ? new Date(sub.expireTime).getTime() : Infinity;
            if (expires < now) {
              issues.push({
                code: 'expired-subscription',
                severity: 'warning',
                title: `Expired subscription for doc ${docId.slice(0, 20)}…`,
                detail: `Subscription ${sub.name} expired at ${sub.expireTime}. Delete it so a fresh one is created on next start.`,
                context: { subscriptionName: sub.name, docId },
                fixes: [deleteSubscriptionFix],
              });
            }
          }
        } catch (err: any) {
          ctx.debug(`listSubscriptions failed for ${docId}: ${err.message ?? err}`);
          // swallow — target-docid-accessible / sessions-with-bad-docids will surface the real problem
        }
      }
    }
    return issues;
  },
};

// ── Helpers ────────────────────────────────────────────────────

function findSessionWithDocId(
  ctx: RepairContext,
  docId: string,
): { id: string; directory: string } | null {
  for (const s of ctx.sessionStore.listAll()) {
    if (s.docIds.includes(docId)) return { id: s.id, directory: s.directory };
  }
  return null;
}
