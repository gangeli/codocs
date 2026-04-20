/**
 * OpenAI Codex CLI agent runner.
 *
 * Spawns the `codex` CLI in quiet (non-interactive) mode.
 * Codex does not support session resume.
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

export class CodexRunner implements AgentRunner {
  readonly name = 'codex';
  private active = new Map<string, TrackedProcess>();

  constructor(private binaryPath: string = 'codex') {}

  async run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    // Codex has no session resume — always generate a tracking ID
    const effectiveSessionId = sessionId ?? randomUUID();

    const args = ['-q', prompt];

    if (opts?.model) {
      args.push('--model', opts.model);
    }

    // Map permission mode to Codex approval mode, with harness setting override
    const approvalMode = opts?.harnessSettings?.['approvalMode'];
    if (approvalMode) {
      args.push('--approval-mode', approvalMode);
    } else {
      const permMode = opts?.permissionMode ?? { type: 'auto' };
      switch (permMode.type) {
        case 'auto':
          args.push('--approval-mode', 'auto-edit');
          break;
        case 'bypass':
          args.push('--approval-mode', 'full-auto');
          break;
        default:
          args.push('--approval-mode', 'suggest');
          break;
      }
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
      supportsSessionFork: false,
      models: [
        { label: 'default', value: '' },
        { label: 'o3-mini', value: 'o3-mini' },
        { label: 'o4-mini', value: 'o4-mini' },
        { label: 'gpt-4.1', value: 'gpt-4.1' },
      ],
      harnessSettings: [
        {
          key: 'approvalMode',
          label: 'Approval mode',
          options: [
            { label: 'suggest', value: 'suggest' },
            { label: 'auto-edit', value: 'auto-edit' },
            { label: 'full-auto', value: 'full-auto' },
          ],
          defaultValue: 'auto-edit',
        },
      ],
      supportsPermissionMode: false,
    };
  }
}
