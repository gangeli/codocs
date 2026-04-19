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
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function getDataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'codocs');
}

/** Path where the service account key is stored on disk. */
export function serviceAccountKeyPath(): string {
  return join(getDataDir(), 'service-account.json');
}

/** Path to the bundled service account key shipped with the repo. */
function bundledKeyPath(): string {
  // Walk up from packages/cli/src/auth/ → repo root
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, '..', '..', '..', '..', 'service-account.json');
}

/**
 * Load the service account credentials from disk.
 * Checks the local XDG data dir first, then falls back to the
 * bundled key shipped with the repo.
 * Returns null if not configured.
 */
export function loadServiceAccountKey(): object | null {
  for (const keyPath of [serviceAccountKeyPath(), bundledKeyPath()]) {
    if (!existsSync(keyPath)) continue;
    try {
      return JSON.parse(readFileSync(keyPath, 'utf-8'));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Extract the bot email from the service account key.
 */
export function getBotEmail(): string | null {
  const key = loadServiceAccountKey();
  if (!key || typeof key !== 'object') return null;
  return (key as any).client_email ?? null;
}
