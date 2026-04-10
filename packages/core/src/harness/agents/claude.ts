/**
 * Claude Code agent runner.
 *
 * Spawns the `claude` CLI as a child process with `-p` (print mode).
 * Sessions are managed via `--session-id` and `--resume`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentRunner, AgentRunOptions, AgentRunResult, ActiveAgent } from '../agent.js';

const DEFAULT_TIMEOUT = 3_600_000; // 1 hour

interface TrackedProcess {
  child: ChildProcess;
  agentName: string;
  startedAt: Date;
}

export class ClaudeRunner implements AgentRunner {
  readonly name = 'claude';
  private active = new Map<string, TrackedProcess>();

  constructor(private binaryPath: string = 'claude') {}

  /**
   * Run a prompt, optionally resuming an existing session.
   * The agentName option is used to label the process for tracking.
   */
  async run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const effectiveSessionId = sessionId ?? randomUUID();
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
    const trackingId = randomUUID();

    const args = ['-p', prompt, '--session-id', effectiveSessionId];

    const permMode = opts?.permissionMode ?? { type: 'auto' };
    switch (permMode.type) {
      case 'auto':
        args.push('--permission-mode', 'auto');
        // Also pass allowedTools as a fallback in case auto mode isn't
        // available for this account — without it the agent can't edit files.
        if (permMode.allowedTools?.length) {
          args.push('--allowedTools', ...permMode.allowedTools);
        }
        break;
      case 'bypass':
        args.push('--dangerously-skip-permissions');
        break;
      case 'allowedTools':
        args.push('--allowedTools', ...permMode.tools);
        if (permMode.disallowedTools?.length) {
          args.push('--disallowedTools', ...permMode.disallowedTools);
        }
        break;
    }

    if (sessionId) {
      args.push('--resume');
    }

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(this.binaryPath, args, {
        cwd: opts?.workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.active.set(trackingId, {
        child,
        agentName: opts?.agentName ?? effectiveSessionId,
        startedAt: new Date(),
      });

      const cleanup = () => { this.active.delete(trackingId); };

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        cleanup();
        reject(new Error(`Claude session ${effectiveSessionId} timed out after ${timeout}ms`));
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
          sessionId: effectiveSessionId,
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        });
      });

      // Close stdin immediately — we pass the prompt via -p flag
      child.stdin.end();
    });
  }

  getActiveProcesses(): ActiveAgent[] {
    return [...this.active.values()].map(({ agentName, startedAt }) => ({
      agentName,
      startedAt,
    }));
  }

  killAll(): string[] {
    const killed: string[] = [];
    for (const [id, { child, agentName }] of this.active) {
      child.kill('SIGTERM');
      killed.push(agentName);
      this.active.delete(id);
    }
    return killed;
  }
}
