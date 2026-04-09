/**
 * Shared state types for the TUI.
 */

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
  type: 'comment' | 'system' | 'agent-reply' | 'error';
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
}

export interface Stats {
  commentCount: number;
  totalCost: number;
  budget: number;
  startTime: Date;
}

export interface Settings {
  maxAgents: number;
  onBudgetExhausted: 'pause' | 'warn' | 'stop';
  debugMode: boolean;
}

export interface TuiState {
  docUrl: string;
  docTitle: string;
  connected: boolean;
  agents: Agent[];
  events: ActivityEvent[];
  stats: Stats;
  settings: Settings;
  showSettings: boolean;
  paused: boolean;
}

export function createInitialState(
  docId: string,
  docTitle?: string,
): TuiState {
  const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
  return {
    docUrl,
    docTitle: docTitle ?? docId.slice(0, 12) + '...',
    connected: false,
    agents: [],
    events: [
      {
        id: 'init',
        time: new Date(),
        type: 'system',
        content: 'Starting up...',
      },
    ],
    stats: {
      commentCount: 0,
      totalCost: 0,
      budget: 1.0,
      startTime: new Date(),
    },
    settings: {
      maxAgents: 3,
      onBudgetExhausted: 'pause',
      debugMode: false,
    },
    showSettings: false,
    paused: false,
  };
}
