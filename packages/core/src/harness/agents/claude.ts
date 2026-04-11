/**
 * Claude Code agent runner.
 *
 * Spawns the `claude` CLI as a child process with `-p` (print mode).
 * Sessions are managed via `--session-id` and `--resume`.
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

export class ClaudeRunner implements AgentRunner {
  readonly name = 'claude';
  private active = new Map<string, TrackedProcess>();

  constructor(private binaryPath: string = 'claude') {}

  async run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const effectiveSessionId = sessionId ?? randomUUID();

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

    if (opts?.model) {
      args.push('--model', opts.model);
    }

    if (sessionId) {
      args.push('--resume');
    }

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
      models: [
        { label: 'default', value: '' },
        { label: 'haiku', value: 'haiku' },
        { label: 'sonnet', value: 'sonnet' },
        { label: 'opus', value: 'opus' },
      ],
      harnessSettings: [],
      supportsPermissionMode: true,
    };
  }
}
