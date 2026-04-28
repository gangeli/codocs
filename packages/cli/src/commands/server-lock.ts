/**
 * Per-doc server lock acquisition for `serve`.
 *
 * Pulled out of serve.ts so the heartbeat-vs-staleness logic can be
 * exercised by unit tests (and so `--force-unlock` has a single, obvious
 * branch to reason about).
 */

export interface ServerHeartbeat {
  timestamp: number;
  serverHash: string;
}

export interface ServerLockClient {
  getServerHeartbeat(docId: string): Promise<ServerHeartbeat | null>;
  setServerHeartbeat(docId: string, serverHash: string): Promise<void>;
}

export type AcquireServerLockResult =
  | { kind: 'acquired'; forced: boolean }
  | { kind: 'locked'; ageMs: number; otherHash: string }
  | { kind: 'error'; message: string };

export interface AcquireServerLockOptions {
  /** A heartbeat younger than this is considered fresh (i.e. lock is held). */
  staleMs: number;
  /** When true, claim the lock even if a fresh heartbeat is present. */
  force?: boolean;
  /** Override `Date.now` for tests. */
  now?: () => number;
}

/**
 * Try to claim the server lock for `docId`.
 *
 * - If no heartbeat exists, or the existing one is stale, claim the lock.
 * - If a fresh heartbeat exists and `force` is false, return `'locked'`.
 * - If `force` is true, overwrite the heartbeat regardless. The caller is
 *   responsible for surfacing this to the user — forcing is a "last
 *   resort" affordance for cases where the previous server crashed
 *   without clearing its heartbeat (or for legitimate ops takeover) and
 *   the operator doesn't want to wait out the staleness window.
 * - On a transport error reading the existing heartbeat, return `'error'`
 *   so the caller can decide whether to bail or proceed best-effort. The
 *   set step is wrapped in the same try/catch as the get.
 */
export async function acquireServerLock(
  client: ServerLockClient,
  docId: string,
  serverHash: string,
  opts: AcquireServerLockOptions,
): Promise<AcquireServerLockResult> {
  const now = opts.now ?? Date.now;
  try {
    const heartbeat = await client.getServerHeartbeat(docId);
    if (heartbeat && !opts.force) {
      const ageMs = now() - heartbeat.timestamp;
      if (ageMs < opts.staleMs) {
        return { kind: 'locked', ageMs, otherHash: heartbeat.serverHash };
      }
    }
    await client.setServerHeartbeat(docId, serverHash);
    return { kind: 'acquired', forced: !!opts.force && heartbeat !== null && (now() - heartbeat.timestamp) < opts.staleMs };
  } catch (err: any) {
    return { kind: 'error', message: err?.message ?? String(err) };
  }
}
