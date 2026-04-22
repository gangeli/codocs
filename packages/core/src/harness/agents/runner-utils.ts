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

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

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
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
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
