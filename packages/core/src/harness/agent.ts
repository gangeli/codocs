/**
 * Pluggable agent runner interface.
 *
 * Implement this to integrate different coding agents (Claude, Codex, Cursor, OpenCode, etc.).
 */

/** Known agent runner types. */
export type AgentType = 'claude' | 'codex' | 'cursor' | 'opencode';

export type PermissionMode =
  | { type: 'auto'; allowedTools?: string[] }
  | { type: 'bypass' }
  | { type: 'allowedTools'; tools: string[]; disallowedTools?: string[] };

export interface AgentRunOptions {
  /** Working directory for the agent process. */
  workingDirectory?: string;
  /** Timeout in ms. Defaults to 3_600_000 (1 hour). */
  timeout?: number;
  /** Agent name (used for tracking active processes). */
  agentName?: string;
  /** How tool permissions are handled for the agent process. */
  permissionMode?: PermissionMode;
  /** Model to use for this run (e.g., "haiku", "sonnet", "opus", or a full model ID). */
  model?: string;
  /** Harness-specific settings (e.g., codex approval mode, opencode provider). */
  harnessSettings?: Record<string, string>;
}

export interface AgentRunResult {
  /** The session ID used (either resumed or newly created). */
  sessionId: string;
  /** Agent process exit code. */
  exitCode: number;
  /** Stdout from the agent. */
  stdout: string;
  /** Stderr from the agent. */
  stderr: string;
}

export interface ActiveAgent {
  /** Agent name (e.g., the cute generated name). */
  agentName: string;
  /** When this agent started processing. */
  startedAt: Date;
}

/** A selectable option for a harness setting or model list. */
export interface HarnessSettingOption {
  label: string;
  value: string;
}

/** Describes a harness-specific setting surfaced in the settings panel. */
export interface HarnessSetting {
  /** Setting key (e.g., 'approvalMode', 'provider'). */
  key: string;
  /** Display label for the settings UI. */
  label: string;
  /** Available options. */
  options: HarnessSettingOption[];
  /** Default value (must match one of the option values). */
  defaultValue: string;
}

/** Describes what a runner supports, used to drive the settings UI. */
export interface RunnerCapabilities {
  /** Whether this runner supports resuming sessions. */
  supportsSessionResume: boolean;
  /** Model choices for the settings panel. */
  models: HarnessSettingOption[];
  /** Harness-specific settings beyond model selection. */
  harnessSettings: HarnessSetting[];
  /** Whether this runner has a concept equivalent to permission mode. */
  supportsPermissionMode: boolean;
}

export interface AgentRunner {
  /** Human-readable name for this runner type (e.g., "claude"). */
  readonly name: string;

  /**
   * Run a prompt, optionally resuming an existing session.
   *
   * @param prompt - The text prompt to send to the agent.
   * @param sessionId - Session to resume, or null to create a new one.
   * @param opts - Execution options.
   * @returns Result including the session ID used and captured output.
   */
  run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult>;

  /** Return currently active (in-flight) agent processes. */
  getActiveProcesses(): ActiveAgent[];

  /** Kill all active agent processes. Returns the names of killed agents. */
  killAll(): string[];

  /** Describe this runner's capabilities and available settings. */
  getCapabilities(): RunnerCapabilities;
}
