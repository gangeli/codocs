/**
 * Shared utilities for agent runners that spawn CLI processes.
 *
 * Each runner owns its own `active` Map and passes it to these helpers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentRunResult, ActiveAgent } from '../agent.js';

/** A child process tracked for an in-flight agent run. */
export interface TrackedProcess {
  child: ChildProcess;
  agentName: string;
  startedAt: Date;
}

/** Default timeout for agent runs (1 hour). */
export const DEFAULT_TIMEOUT = 3_600_000;

/**
 * Per-stream cap for buffered child output. A misbehaving CLI that prints
 * MB/sec for the full timeout would otherwise OOM the parent — we keep
 * the *tail* of the output and prepend a truncation notice on overflow.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface SpawnAgentOptions {
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Timeout in ms. Defaults to DEFAULT_TIMEOUT. */
  timeout?: number;
  /** Agent name used for tracking. Falls back to sessionId. */
  agentName?: string;
  /** Session ID for the result (generated if not provided). */
  sessionId?: string;
  /** Optional data to write to stdin before closing it. */
  stdinData?: string;
  /** Environment for the child. Defaults to inheriting process.env. */
  env?: NodeJS.ProcessEnv;
  /** Per-stream cap on retained output bytes. Defaults to DEFAULT_MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}

/**
 * Bounded ring buffer for child stdio: appends chunks until the cap is
 * reached, then drops oldest chunks (slicing the head of the next-oldest
 * if needed) so we always retain at most `cap` bytes.
 */
class BoundedChunkBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0];
      const overflow = this.size - this.cap;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.size -= head.length;
        this.dropped += head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.size -= overflow;
        this.dropped += overflow;
      }
    }
  }

  toString(): string {
    const body = Buffer.concat(this.chunks, this.size).toString('utf-8');
    if (this.dropped === 0) return body;
    return `[truncated ${this.dropped} bytes from start of stream]\n${body}`;
  }
}

/**
 * Spawn a CLI binary, capture stdout/stderr, enforce a timeout, and track
 * the child process in the provided `active` map.
 */
export function spawnAgent(
  binary: string,
  args: string[],
  opts: SpawnAgentOptions,
  active: Map<string, TrackedProcess>,
): Promise<AgentRunResult> {
  const sessionId = opts.sessionId ?? randomUUID();
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const trackingId = randomUUID();

  return new Promise<AgentRunResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ?? { ...process.env },
    });

    active.set(trackingId, {
      child,
      agentName: opts.agentName ?? sessionId,
      startedAt: new Date(),
    });

    const cleanup = () => { active.delete(trackingId); };

    const stdoutBuf = new BoundedChunkBuffer(maxOutputBytes);
    const stderrBuf = new BoundedChunkBuffer(maxOutputBytes);

    child.stdout.on('data', (chunk: Buffer) => stdoutBuf.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrBuf.push(chunk));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      cleanup();
      reject(new Error(`Agent session ${sessionId} timed out after ${timeout}ms`));
    }, timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        sessionId,
        exitCode: code ?? 1,
        stdout: stdoutBuf.toString(),
        stderr: stderrBuf.toString(),
      });
    });

    if (opts.stdinData != null) {
      child.stdin.write(opts.stdinData);
    }
    child.stdin.end();
  });
}

/** Return currently active processes from a tracking map. */
export function getTrackedProcesses(active: Map<string, TrackedProcess>): ActiveAgent[] {
  return [...active.values()].map(({ agentName, startedAt }) => ({
    agentName,
    startedAt,
  }));
}

/** Kill all tracked processes. Returns names of killed agents. */
export function killTrackedProcesses(active: Map<string, TrackedProcess>): string[] {
  const killed: string[] = [];
  for (const [id, { child, agentName }] of active) {
    child.kill('SIGTERM');
    killed.push(agentName);
    active.delete(id);
  }
  return killed;
}
