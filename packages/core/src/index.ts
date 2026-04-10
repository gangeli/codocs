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
  ensureSubscription,
  renewSubscription,
  deleteSubscription,
  listSubscriptions,
  listenForComments,
  type SubscriptionInfo,
  type CommentListenerHandle,
  type PubSubAuth,
  classifyComment,
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
  buildCodePrompt,
  buildClassificationPreamble,
  parseClassification,
  getDefaultBranch,
  createWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
  rebaseOnto,
  forcePushBranch,
  getRepoInfo,
  createDraftPR,
  addPRComment,
  buildPRBody,
  writeTempContext,
  cleanupTempFiles,
  generateAgentName,
} from './harness/index.js';
export type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  ActiveAgent,
  PermissionMode,
  SessionStore,
  SessionMapping,
  QueueStore,
  QueueItem,
  OrchestratorConfig,
  AssignmentConfig,
  PromptContext,
  CodePromptContext,
  Classification,
  PRInfo,
  RepoInfo,
  TempContext,
  MdSection,
  MergeResult,
  DiffResult,
} from './harness/index.js';
