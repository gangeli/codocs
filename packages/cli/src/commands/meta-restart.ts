/**
 * Graceful shutdown for the --meta restart path.
 *
 * Factored out of serve.ts so it can be exercised in isolation without
 * pulling in the Ink TUI (and the bundler-defined __BUILD_VERSION__ it
 * depends on) during tests.
 */

import type { AgentOrchestrator, CommentListenerHandle } from '@codocs/core';

/** Minimal shape of the CodocsClient used for the server lock (heartbeat). */
export interface MetaRestartLockClient {
  clearServerHeartbeat(docId: string): Promise<void>;
}

export interface MetaRestartShutdownCtx {
  orchestrator: Pick<AgentOrchestrator, 'cancelIdleCheck'>;
  renewalTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  listener: CommentListenerHandle | null;
  db: { close: () => void };
  lockClient: MetaRestartLockClient;
  docIds: string[];
}

/**
 * Graceful shutdown sequence used by the --meta restart path. Stops all
 * timers and closes handles, then releases the Drive server-lock heartbeat
 * so the respawned process can claim it immediately instead of seeing the
 * previous server's still-fresh heartbeat and bailing with "duplicate
 * server".
 */
export async function metaRestartShutdown(ctx: MetaRestartShutdownCtx): Promise<void> {
  ctx.orchestrator.cancelIdleCheck();
  if (ctx.renewalTimer) clearInterval(ctx.renewalTimer);
  // Stop the heartbeat timer first — otherwise it will re-plant the lock
  // (every 15s) during the ~120s make rebuild, defeating the clear below.
  if (ctx.heartbeatTimer) clearInterval(ctx.heartbeatTimer);

  // Release the Drive server-lock heartbeat so the respawned child can
  // claim the lock immediately instead of rejecting with "duplicate
  // server". Best-effort — a missed clear just means one stale-heartbeat
  // window before the child can claim.
  for (const docId of ctx.docIds) {
    try {
      await ctx.lockClient.clearServerHeartbeat(docId);
    } catch {
      // Best-effort: a failed clear just means the child will see a
      // non-stale heartbeat and bail — recoverable on the next restart.
    }
  }

  if (ctx.listener) await ctx.listener.close();
  ctx.db.close();
}
