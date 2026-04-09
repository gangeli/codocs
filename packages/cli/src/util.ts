/**
 * Shared CLI utilities.
 */

import { readFileSync } from 'node:fs';
import { CodocsClient } from '@codocs/core';
import { readConfig, readTokens } from './auth/token-store.js';

// ── Spinner ──────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  /** Update the message while spinning. */
  update(message: string): void;
  /** Stop with a success message (✓). */
  succeed(message: string): void;
  /** Stop with a failure message (✗). */
  fail(message: string): void;
  /** Stop and clear the line. */
  stop(): void;
}

/**
 * Start a terminal spinner on stderr.
 * Returns a handle to update, succeed, fail, or stop it.
 */
export function spin(message: string): Spinner {
  let i = 0;
  let currentMessage = message;
  let stopped = false;

  const write = () => {
    if (stopped) return;
    const frame = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
    process.stderr.write(`\r\x1b[2K\x1b[90m${frame}\x1b[0m ${currentMessage}`);
    i++;
  };

  write();
  const timer = setInterval(write, 80);

  const clear = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K');
  };

  return {
    update(msg: string) {
      currentMessage = msg;
    },
    succeed(msg: string) {
      clear();
      process.stderr.write(`\x1b[32m✓\x1b[0m ${msg}\n`);
    },
    fail(msg: string) {
      clear();
      process.stderr.write(`\x1b[31m✗\x1b[0m ${msg}\n`);
    },
    stop() {
      clear();
    },
  };
}

/**
 * Read content from a file path or stdin.
 * If filePath is provided, reads the file. Otherwise reads from stdin.
 * Errors if stdin is a TTY with no data piped.
 */
export async function readContent(filePath?: string): Promise<string> {
  if (filePath) {
    return readFileSync(filePath, 'utf-8');
  }

  if (process.stdin.isTTY) {
    console.error(
      'Error: No input provided. Pipe markdown to stdin or provide a file path.',
    );
    console.error('Example: echo "# Hello" | codocs insert <docId> --agent myagent');
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Create a CodocsClient from stored auth credentials.
 * Exits with a helpful error if not authenticated.
 */
export function createClient(): CodocsClient {
  const config = readConfig();
  const tokens = readTokens();
  if (!tokens) {
    console.error('Not authenticated. Run `codocs auth login` first.');
    process.exit(1);
  }

  return new CodocsClient({
    oauth2: {
      clientId: config.client_id,
      clientSecret: config.client_secret,
      refreshToken: tokens.refresh_token,
    },
  });
}

/**
 * Truncate text to maxLen, replacing newlines with \\n for single-line display.
 */
export function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, '\\n');
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

/**
 * Wrap a command handler with standard error handling.
 */
export function withErrorHandler(
  fn: (...args: any[]) => Promise<void>,
): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err: any) {
      const message = err?.message ?? 'An unexpected error occurred';

      if (message.includes('401') || message.includes('invalid_grant')) {
        console.error(
          'Authentication failed. Try `codocs auth login` to re-authenticate.',
        );
      } else if (message.includes('404') || message.includes('not found')) {
        console.error(
          `Error: ${message}\nCheck the document ID and ensure your account has access.`,
        );
      } else {
        console.error(`Error: ${message}`);
      }
      process.exit(1);
    }
  };
}
