/**
 * Shared shapes for the repair module.
 *
 * A Check inspects the system and returns zero or more Issues.
 * An Issue may list one or more Fixes. Applying a Fix returns a FixResult.
 * Checks and fixes are registered with the runner; the `codocs repair`
 * command and startup validation both consume from that registry.
 */

import type { Database } from 'sql.js';
import type {
  CodocsSessionStore,
  QueueStore,
  CodeTaskStore,
} from '@codocs/db';
import type { CodocsClient } from '@codocs/core';
import type { createAuth } from '@codocs/core';
import type { StoredConfig, StoredTokens } from '../auth/token-store.js';

export type Severity = 'error' | 'warning' | 'info';
export type Scope = 'startup' | 'health' | 'both';

export interface Issue {
  /** Stable identifier, e.g. 'invalid-session-docid'. */
  code: string;
  severity: Severity;
  /** Short, shown in the list. */
  title: string;
  /** Paragraph shown in the detail panel. */
  detail: string;
  /** Arbitrary data the fixes need to act on the issue. */
  context?: Record<string, unknown>;
  /** Applicable fixes. Empty means the issue is informational or manual-only. */
  fixes: Fix[];
}

export interface Fix {
  id: string;
  label: string;
  description: string;
  /** Destructive fixes require a confirmation step in the TUI. */
  destructive: boolean;
  apply(ctx: RepairContext, issue: Issue): Promise<FixResult>;
}

export interface FixResult {
  ok: boolean;
  message: string;
}

export interface Check {
  id: string;
  description: string;
  scope: Scope;
  run(ctx: RepairContext): Promise<Issue[]>;
}

/** Authenticated client for the default OAuth2 credentials, or null if no tokens. */
export type AuthHandle = ReturnType<typeof createAuth>;

export interface RepairContext {
  db: Database;
  sessionStore: CodocsSessionStore;
  queueStore: QueueStore;
  codeTaskStore: CodeTaskStore;
  config: StoredConfig;
  tokens: StoredTokens | null;
  /** Null when tokens are missing. */
  client: CodocsClient | null;
  /** Null when tokens are missing. */
  auth: AuthHandle | null;
  cwd: string;
  /** Doc IDs the current invocation targets. Empty for `codocs repair`. */
  targetDocIds: string[];
  /** Path the DB was opened from (for saveDatabase). */
  dbPath?: string;
  debug: (msg: string) => void;
}
