export { CodocsClient } from './client/index.js';
export { createAuth } from './auth/index.js';
export type {
  AuthConfig,
  AgentIdentity,
  RgbColor,
  WriteOptions,
  ReadOptions,
  CommentInput,
  DocComment,
  AttributionSpan,
} from './types.js';
export { markdownToDocsRequests } from './converter/index.js';
export { docsToMarkdown } from './converter/index.js';
export {
  createAttributionRequests,
  extractAttributions,
} from './attribution/index.js';
export {
  createCommentSubscription,
  renewSubscription,
  deleteSubscription,
  listSubscriptions,
  listenForComments,
  type SubscriptionInfo,
  type CommentListenerHandle,
  type PubSubAuth,
} from './events/index.js';
export type { EventListenerConfig, CommentEvent, AgentTask } from './types.js';
export { docsToMarkdownWithMapping, type MarkdownWithMapping } from './converter/index.js';
export {
  AgentOrchestrator,
  ClaudeRunner,
  assignAgent,
  parseSections,
  mergeDocuments,
  computeDocDiff,
  buildPrompt,
  buildConflictPrompt,
  writeTempContext,
  cleanupTempFiles,
  generateAgentName,
} from './harness/index.js';
export type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  ActiveAgent,
  SessionStore,
  SessionMapping,
  OrchestratorConfig,
  AssignmentConfig,
  PromptContext,
  TempContext,
  MdSection,
  MergeResult,
  DiffResult,
} from './harness/index.js';
