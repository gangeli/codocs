/**
 * Pluggable agent runner interface.
 *
 * Implement this to integrate different coding agents (Claude, Cursor, etc.).
 */

export interface AgentRunOptions {
  /** Working directory for the agent process. */
  workingDirectory?: string;
  /** Timeout in ms. Defaults to 300_000 (5 min). */
  timeout?: number;
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
}
