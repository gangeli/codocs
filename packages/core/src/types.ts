import type { docs_v1 } from 'googleapis';

/** Options for authenticating with Google APIs */
export interface AuthConfig {
  /** Path to service account key JSON, or the parsed key object */
  serviceAccountKey?: string | object;
  /** OAuth2 credentials for interactive auth */
  oauth2?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  /** Pre-configured auth client (for advanced use) */
  authClient?: unknown;
}

/** Identifies which agent is authoring content */
export interface AgentIdentity {
  /** Agent name, e.g. "planner", "coder", "reviewer" */
  name: string;
  /** Optional color for visual distinction in the doc */
  color?: RgbColor;
}

export interface RgbColor {
  red: number;   // 0–1
  green: number; // 0–1
  blue: number;  // 0–1
}

/** Options when writing markdown to a doc */
export interface WriteOptions {
  /** 'replace' clears the doc first (default); 'append' adds to the end */
  mode?: 'replace' | 'append';
  /** Agent to attribute this content to */
  agent?: AgentIdentity;
  /** Insert at a specific document index (advanced) */
  insertAt?: number;
}

/** Options when reading a doc as markdown */
export interface ReadOptions {
  /** Filter to content from a specific agent only */
  agentFilter?: string;
  /** Include <!-- agent:name --> markers in the output */
  includeAttribution?: boolean;
}

/** A comment to place on a doc */
export interface CommentInput {
  /** The text content of the comment */
  content: string;
  /** Quote of the text this comment refers to (for anchoring) */
  quotedText?: string;
  /** Agent making the comment */
  agent?: AgentIdentity;
}

/** A resolved comment from the doc */
export interface DocComment {
  id: string;
  content: string;
  author: string;
  quotedText?: string;
  resolved: boolean;
  createdTime: string;
}

/** Result of reading attribution info */
export interface AttributionSpan {
  agentName: string;
  namedRangeId: string;
  ranges: Array<{ startIndex: number; endIndex: number }>;
  text: string;
}

/** Named range prefix used for agent attribution */
export const AGENT_RANGE_PREFIX = 'agent:';

/** Configuration for the event listener */
export interface EventListenerConfig {
  /** Google Cloud project ID */
  gcpProjectId: string;
  /** Pub/Sub topic name (just the name, not full path) */
  pubsubTopic: string;
  /** Pub/Sub subscription name (just the name, not full path) */
  pubsubSubscription: string;
  /** Auth config for Google APIs */
  auth: AuthConfig;
}

/** A comment event enriched with attribution data, ready for agent dispatch. */
export interface AgentTask {
  /** The original comment event. */
  event: CommentEvent;
  /** The quoted text from the comment. */
  quotedText: string;
  /** Attribution spans overlapping the quoted text. */
  overlappingAttributions: AttributionSpan[];
  /** The agent determined to handle this task. */
  assignedAgent: string;
  /** Full document markdown at the time of dispatch. */
  documentMarkdown: string;
  /** Document ID. */
  documentId: string;
}

/** A single message in a comment thread (either the root comment or a reply). */
export interface ThreadMessage {
  author?: string;
  content?: string;
  createdTime?: string;
}

/** A comment event received from the Workspace Events API */
export interface CommentEvent {
  /** The event type (e.g., google.workspace.documents.comment.v1.created) */
  eventType: string;
  /** The document ID the comment was made on */
  documentId: string;
  /** Raw comment data from the event payload */
  comment: {
    id?: string;
    content?: string;
    author?: string;
    quotedText?: string;
    createdTime?: string;
    /** Mentions found in the comment content */
    mentions: string[];
  };
  /** When the event occurred */
  eventTime: string;
  /**
   * Full thread history (root comment + all replies), ordered chronologically.
   * Present when the listener fetches the full comment from Drive API.
   * The last entry is the message that triggered this event.
   */
  thread?: ThreadMessage[];
}
