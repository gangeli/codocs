/**
 * Service account support for Codocs bot identity.
 *
 * The service account key is stored locally at the XDG data directory,
 * installed via `codocs auth setup-bot`. It is never bundled in the code.
 *
 * Comment replies from codocs appear as this service account identity.
 * The service account can only reply to comments on docs shared with it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function getDataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'codocs');
}

/** Path where the service account key is stored on disk. */
export function serviceAccountKeyPath(): string {
  return join(getDataDir(), 'service-account.json');
}

/**
 * Load the service account credentials from disk.
 * Returns null if not configured.
 */
export function loadServiceAccountKey(): object | null {
  const keyPath = serviceAccountKeyPath();
  if (!existsSync(keyPath)) return null;

  try {
    return JSON.parse(readFileSync(keyPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Extract the bot email from the service account key.
 */
export function getBotEmail(): string | null {
  const key = loadServiceAccountKey();
  if (!key || typeof key !== 'object') return null;
  return (key as any).client_email ?? null;
}
