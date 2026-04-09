/**
 * Claude Code agent runner.
 *
 * Spawns the `claude` CLI as a child process with `-p` (print mode).
 * Sessions are managed via `--session-id` and `--resume`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentRunner, AgentRunOptions, AgentRunResult } from '../agent.js';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export class ClaudeRunner implements AgentRunner {
  readonly name = 'claude';

  constructor(private binaryPath: string = 'claude') {}

  async run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const effectiveSessionId = sessionId ?? randomUUID();
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

    const args = ['-p', prompt, '--session-id', effectiveSessionId];
    if (sessionId) {
      args.push('--resume');
    }

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(this.binaryPath, args, {
        cwd: opts?.workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Claude session ${effectiveSessionId} timed out after ${timeout}ms`));
      }, timeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
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
}
