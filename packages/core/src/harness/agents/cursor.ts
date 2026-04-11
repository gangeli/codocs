/**
 * Cursor agent runner.
 *
 * Spawns the `cursor` CLI in non-interactive mode.
 * Cursor does not support session resume.
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

  constructor(private binaryPath: string = 'cursor') {}

  async run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const effectiveSessionId = sessionId ?? randomUUID();

    const args = ['agent', '--prompt', prompt];

    if (opts?.model) {
      args.push('--model', opts.model);
    }

    // Map permission mode to Cursor's tool-calling policy
    const permMode = opts?.permissionMode ?? { type: 'auto' };
    switch (permMode.type) {
      case 'bypass':
        args.push('--yolo');
        break;
      // 'auto' and 'allowedTools' both use default (interactive approval)
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
      supportsSessionResume: false,
      models: [
        { label: 'default', value: '' },
        { label: 'gpt-4.1', value: 'gpt-4.1' },
        { label: 'claude-sonnet', value: 'claude-sonnet-4-6' },
        { label: 'cursor-small', value: 'cursor-small' },
      ],
      harnessSettings: [],
      supportsPermissionMode: true,
    };
  }
}
