/**
 * Shared state types for the TUI.
 */

export type { PermissionMode } from '@codocs/core';
import type { PermissionMode } from '@codocs/core';

/**
 * Tools allowed in "tools" permission mode.
 * Includes all core tools plus scoped Bash commands that are
 * read-only or commonly needed for builds/tests.
 */
export const ALLOWED_TOOLS = [
  // Core file tools
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit',
  // Agent and web
  'Agent', 'WebSearch', 'WebFetch',
  // Scoped Bash: build & test
  'Bash(make:*)', 'Bash(npm:*)', 'Bash(npx:*)',
  'Bash(node:*)', 'Bash(bun:*)', 'Bash(deno:*)',
  'Bash(cargo:*)', 'Bash(go:*)', 'Bash(python:*)', 'Bash(python3:*)', 'Bash(pytest:*)',
  'Bash(pip:*)', 'Bash(uv:*)',
  // Scoped Bash: version control
  'Bash(git:*)',
  // Scoped Bash: filesystem read
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)',
  'Bash(find:*)', 'Bash(wc:*)', 'Bash(file:*)', 'Bash(which:*)',
  // Scoped Bash: common utilities
  'Bash(echo:*)', 'Bash(env:*)', 'Bash(pwd:*)', 'Bash(date:*)',
  'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(diff:*)', 'Bash(jq:*)',
];

/** Tools explicitly denied in "tools" permission mode. */
export const DISALLOWED_TOOLS = [
  'Bash(git push --force:*)', 'Bash(git push -f:*)',
];

export interface Agent {
  name: string;
  status: 'idle' | 'processing' | 'paused' | 'error';
  /** What the agent is currently working on */
  task?: string;
  /** When the current task started */
  taskStartTime?: Date;
}

export interface ActivityEvent {
  id: string;
  time: Date;
  type: 'comment' | 'system' | 'agent-reply' | 'error' | 'debug';
  /** Author of the comment (if type=comment) */
  author?: string;
  /** Quoted text the comment is on */
  quotedText?: string;
  /** The comment or message content */
  content: string;
  /** Which agent handled this */
  agent?: string;
  /** Processing duration in ms */
  durationMs?: number;
  /** Cost of processing */
  cost?: number;
  /** Truncated response/reply text (for agent-reply) */
  replyPreview?: string;
  /** Summary of document edits (for agent-reply) */
  editSummary?: string;
}

export interface Stats {
  commentCount: number;
  totalCost: number;
  budget: number;
  startTime: Date;
}

export type CodeMode = 'pr' | 'direct' | 'off';

/**
 * Default model per agent type (e.g., `{ claude: 'sonnet' }`).
 * Keys are agent runner names; values are model aliases ("haiku", "sonnet",
 * "opus") or full model IDs (e.g., "claude-sonnet-4-6").
 */
export type DefaultModelMap = Record<string, string>;

export interface Settings {
  maxAgents: number;
  onBudgetExhausted: 'pause' | 'warn' | 'stop';
  permissionMode: PermissionMode;
  codeMode: CodeMode;
  debugMode: boolean;
  /** Default model to use per agent type. Empty map means use the agent's built-in default. */
  defaultModel: DefaultModelMap;
}

export interface TuiState {
  docUrl: string;
  docTitle: string;
  connected: boolean;
  /** Current system status shown in the header */
  statusMessage: string;
  agents: Agent[];
  events: ActivityEvent[];
  stats: Stats;
  settings: Settings;
  showSettings: boolean;
  paused: boolean;
  /** Which agent runner is in use (e.g. "claude"). */
  agentType: string;
  /** Whether --permission-mode auto is available for this account. */
  autoModeAvailable: boolean;
  /** Whether GitHub authentication is configured. */
  githubConnected: boolean;
}

export function createInitialState(
  docId: string,
  opts?: { docTitle?: string; agentType?: string; autoModeAvailable?: boolean; githubConnected?: boolean },
): TuiState {
  const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
  const autoModeAvailable = opts?.autoModeAvailable ?? false;
  const githubConnected = opts?.githubConnected ?? false;
  return {
    docUrl,
    docTitle: opts?.docTitle ?? docId.slice(0, 12) + '...',
    connected: false,
    statusMessage: 'Starting up...',
    agents: [],
    events: [],
    stats: {
      commentCount: 0,
      totalCost: 0,
      budget: 1.0,
      startTime: new Date(),
    },
    settings: {
      maxAgents: 3,
      onBudgetExhausted: 'pause',
      permissionMode: autoModeAvailable
        ? { type: 'auto', allowedTools: ALLOWED_TOOLS }
        : { type: 'allowedTools', tools: ALLOWED_TOOLS, disallowedTools: DISALLOWED_TOOLS },
      codeMode: githubConnected ? 'pr' : 'direct',
      debugMode: false,
      defaultModel: {},
    },
    showSettings: false,
    paused: false,
    agentType: opts?.agentType ?? 'claude',
    autoModeAvailable,
    githubConnected,
  };
}
