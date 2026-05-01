/**
 * File-based logger for `codocs serve`.
 *
 * Wraps pino with the small surface the rest of the CLI needs. All log
 * lines are newline-delimited JSON ({"level","time","msg",...}); pretty
 * printing is left to the consumer (`tail -f serve.log | jq`).
 *
 * Why this exists: long-running codocs sessions occasionally stop
 * responding to comments hours later. The TUI's in-memory event ring
 * is gone the moment codocs exits, which makes those incidents
 * effectively undebuggable. Persisting structured events to disk gives
 * us a record across restarts and lets us grep for signatures like
 * "Renewal failed", reconnect attempts, and Pub/Sub error codes.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type Logger as PinoLogger } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** Flush buffered writes. Resolves when the OS has accepted the data. */
  flush(): Promise<void>;
  /** The on-disk path being written to. */
  filePath: string;
}

export interface CreateLoggerOptions {
  filePath: string;
  level?: LogLevel;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  mkdirSync(dirname(opts.filePath), { recursive: true });
  // sync: true — at the few-hundred-events-per-session rate this CLI
  // logs at, async buffering buys nothing and silently loses lines on
  // crash. Sync gives deterministic "the line is on disk by the time
  // the call returns" semantics, which is what we want for a debug log.
  const dest = pino.destination({ dest: opts.filePath, sync: true, append: true });
  const inner: PinoLogger = pino(
    {
      level: opts.level ?? 'info',
      // Strip pid/hostname; the file is always one process. Keep the
      // ISO timestamp because grep'ing by hour is the whole point.
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );

  // Best-effort flush on process exit so a crash doesn't drop the last
  // few hundred ms of buffered events. pino destinations are async by
  // default, which is what we want during normal operation.
  const flushSync = () => {
    try { dest.flushSync(); } catch { /* ignore */ }
  };
  process.once('exit', flushSync);
  process.once('SIGINT', flushSync);
  process.once('SIGTERM', flushSync);

  return {
    debug: (msg, data) => inner.debug(data ?? {}, msg),
    info: (msg, data) => inner.info(data ?? {}, msg),
    warn: (msg, data) => inner.warn(data ?? {}, msg),
    error: (msg, data) => inner.error(data ?? {}, msg),
    // With sync: true the destination writes synchronously, so
    // flushSync is effectively a no-op. Keep the API for callers that
    // want a clean shutdown handshake.
    flush: () => {
      try { dest.flushSync(); } catch { /* ignore */ }
      return Promise.resolve();
    },
    filePath: opts.filePath,
  };
}
