/**
 * Build a RepairContext that checks and fixes operate on.
 *
 * Tolerates partial configurations: missing tokens produce a null client
 * so `auth-tokens-present` can still run and surface the issue.
 */

import type { Database } from 'sql.js';
import {
  openDatabase,
  CodocsSessionStore,
  QueueStore,
  CodeTaskStore,
} from '@codocs/db';
import { CodocsClient, createAuth } from '@codocs/core';
import { readConfig, readTokens } from '../auth/token-store.js';
import type { RepairContext } from './types.js';

export interface BuildContextOptions {
  dbPath?: string;
  cwd?: string;
  targetDocIds?: string[];
  debug?: (msg: string) => void;
  /** Re-use an already-open database connection instead of opening a new one. */
  db?: Database;
}

export async function buildRepairContext(
  opts: BuildContextOptions = {},
): Promise<RepairContext> {
  const config = readConfig();
  const tokens = readTokens();

  const db = opts.db ?? (await openDatabase(opts.dbPath));
  const sessionStore = new CodocsSessionStore(db);
  const queueStore = new QueueStore(db);
  const codeTaskStore = new CodeTaskStore(db);

  let client: CodocsClient | null = null;
  let auth: ReturnType<typeof createAuth> | null = null;
  if (tokens) {
    const oauth2 = {
      clientId: config.client_id,
      clientSecret: config.client_secret,
      refreshToken: tokens.refresh_token,
    };
    client = new CodocsClient({ oauth2 });
    auth = createAuth({ oauth2 });
  }

  return {
    db,
    sessionStore,
    queueStore,
    codeTaskStore,
    config,
    tokens,
    client,
    auth,
    cwd: opts.cwd ?? process.cwd(),
    targetDocIds: opts.targetDocIds ?? [],
    dbPath: opts.dbPath,
    debug: opts.debug ?? (() => {}),
  };
}
