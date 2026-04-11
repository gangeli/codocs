/**
 * OpenCode agent runner (Cerebras + GLM).
 *
 * Spawns the `opencode` CLI with a configurable provider.
 * The prompt is piped via stdin since OpenCode is primarily interactive.
 * Does not support session resume or permission modes.
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

export class OpenCodeRunner implements AgentRunner {
  readonly name = 'opencode';
  private active = new Map<string, TrackedProcess>();

  constructor(private binaryPath: string = 'opencode') {}

  async run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const effectiveSessionId = sessionId ?? randomUUID();

    const args: string[] = [];

    // Provider from harness settings (defaults to cerebras)
    const provider = opts?.harnessSettings?.['provider'] ?? 'cerebras';
    args.push('--provider', provider);

    if (opts?.model) {
      args.push('--model', opts.model);
    }

    // Pass prompt via stdin for non-interactive execution
    return spawnAgent(this.binaryPath, args, {
      cwd: opts?.workingDirectory,
      timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
      agentName: opts?.agentName,
      sessionId: effectiveSessionId,
      stdinData: prompt,
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
        { label: 'llama-4-scout', value: 'llama-4-scout-17b-16e-instruct' },
        { label: 'glm-4', value: 'glm-4' },
      ],
      harnessSettings: [
        {
          key: 'provider',
          label: 'Provider',
          options: [
            { label: 'cerebras', value: 'cerebras' },
            { label: 'glm', value: 'glm' },
          ],
          defaultValue: 'cerebras',
        },
      ],
      supportsPermissionMode: false,
    };
  }
}
