/**
 * Cursor agent runner.
 *
 * Spawns the `cursor-agent` CLI in print mode (`-p`).
 * Uses `--force` to enable file writes and `--yolo` for full auto-approval.
 * Supports session resume via `--resume <id>`.
 */

import { randomUUID } from 'node:crypto';
import type { AgentRunner, AgentRunOptions, AgentRunResult, ActiveAgent, RunnerCapabilities } from '../agent.js';
import {
  type TrackedProcess,
  DEFAULT_TIMEOUT,
  spawnAgent,
  getTrackedProcesses,
  killTrackedProcesses,
} from './runner-utils.js';

export class CursorRunner implements AgentRunner {
  readonly name = 'cursor';
  private active = new Map<string, TrackedProcess>();

  constructor(private binaryPath: string = 'cursor-agent') {}

  async run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const effectiveSessionId = sessionId ?? randomUUID();

    // Print mode (-p) for non-interactive use; --force to allow file writes
    const args = ['-p', '--force'];

    if (opts?.model) {
      args.push('--model', opts.model);
    }

    // Map permission mode to Cursor flags
    const permMode = opts?.permissionMode ?? { type: 'auto' };
    switch (permMode.type) {
      case 'bypass':
        args.push('--yolo');
        break;
      // 'auto' and 'allowedTools' use default approval behavior
    }

    // Session resume
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // Prompt is the trailing positional argument
    args.push(prompt);

    return spawnAgent(this.binaryPath, args, {
      cwd: opts?.workingDirectory,
      timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
      agentName: opts?.agentName,
      sessionId: effectiveSessionId,
    }, this.active);
  }

  getActiveProcesses(): ActiveAgent[] {
    return getTrackedProcesses(this.active);
  }

  killAll(): string[] {
    return killTrackedProcesses(this.active);
  }

  getCapabilities(): RunnerCapabilities {
    return {
      supportsSessionResume: true,
      supportsSessionFork: false,
      models: [
        { label: 'auto', value: '' },
        { label: 'gpt-4o', value: 'gpt-4o' },
        { label: 'claude-sonnet', value: 'claude-sonnet-4-6' },
        { label: 'gemini-2.5-flash', value: 'gemini-2.5-flash' },
      ],
      harnessSettings: [],
      supportsPermissionMode: true,
    };
  }
}
