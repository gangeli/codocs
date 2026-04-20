/**
 * Service-account support for codocs bot identity (opt-in).
 *
 * By default, codocs replies come from the user's own OAuth identity with
 * a bot-indicator prefix. Passing `--service-account <path>` to `codocs serve`
 * switches replies to a separate service-account identity (e.g. one provisioned
 * via `make infra`). This file loads the key from the user-provided path.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Default location for a service-account key provisioned by `make infra`. */
export function defaultServiceAccountKeyPath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'codocs', 'service-account.json');
}

/** Load a service-account key from the given path. Returns null if missing or malformed. */
export function loadServiceAccountKey(keyPath: string): object | null {
  if (!existsSync(keyPath)) return null;
  try {
    return JSON.parse(readFileSync(keyPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Extract the bot email from a parsed service-account key. */
export function getBotEmail(key: object | null): string | null {
  if (!key || typeof key !== 'object') return null;
  return (key as { client_email?: string }).client_email ?? null;
}
