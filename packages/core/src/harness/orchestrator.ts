/**
 * Agent orchestrator — coordinates comment handling end-to-end.
 *
 * Flow: comment event → agent assignment → enqueue → drain (serialize per agent) →
 * session lookup/create → run agent → 3-way merge → apply changes to Google Doc.
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { CodocsClient } from '../client/index.js';
import type { CommentEvent } from '../types.js';
import type { SessionStore, QueueStore } from './types.js';
import type { AgentRunner, PermissionMode } from './agent.js';
import { assignAgent } from './assign.js';
import { writeTempContext, cleanupTempFiles } from './context.js';
import { buildPrompt, buildConflictPrompt } from './prompt.js';
import { buildCodePrompt } from './code-prompt.js';
import { buildClassificationPreamble, parseClassification } from './classifier.js';
import { docsToMarkdownWithMapping } from '../converter/docs-to-md.js';
import { docsToMarkdown } from '../converter/docs-to-md.js';
import { computeDocDiff } from './diff.js';
import {
  getDefaultBranch, createWorktree, commitAll,
  pushBranch, rebaseOnto,
} from './worktree.js';
import { getRepoInfo, createDraftPR, addPRComment, buildPRBody } from './pr.js';
import { routeComment } from '../chat/chat-router.js';
import { ChatTabManager } from '../chat/chat-tab-manager.js';
import { ChatOrchestrator } from '../chat/chat-orchestrator.js';
import type { ReplyTracker } from '../events/reply-tracker.js';
import type { ChatTabStore } from '@codocs/db';

export type CodeMode = 'pr' | 'direct' | 'off';

export interface CodeTaskStore {
  getByComment(documentId: string, commentId: string): { id: number; branchName: string; worktreePath: string; prNumber: number | null; prUrl: string | null; baseBranch: string } | null;
  create(task: { documentId: string; commentId: string; agentName: string; branchName: string; worktreePath: string; baseBranch: string }): number;
  updatePR(id: number, prNumber: number, prUrl: string): void;
}

export interface OrchestratorConfig {
  /** CodocsClient instance for Google Docs API operations. */
  client: CodocsClient;
  /** Session store for agent-to-session mappings. */
  sessionStore: SessionStore;
  /** Queue store for per-agent comment serialization. */
  queueStore: QueueStore;
  /** Pluggable agent runner (e.g., ClaudeRunner). */
  agentRunner: AgentRunner;
  /**
   * Default agent name when no attributions overlap the comment.
   * Can be a fixed string or a function that resolves per document
   * (useful for auto-generated names stored in a DB).
   */
  fallbackAgent: string | ((documentId: string) => string);
  /**
   * Optional separate client for replying to comments (e.g., a service account).
   * When provided, comment replies will appear from this identity instead of
   * the main client's identity. The doc must be shared with the service account.
   */
  replyClient?: CodocsClient;
  /**
   * Tracks reply IDs posted by this orchestrator. If provided, the same
   * tracker must be passed to the comment listener so self-replies are
   * filtered out. Critical when replyClient is the user's own OAuth client,
   * where author-based filtering can't distinguish codocs from the user.
   */
  replyTracker?: ReplyTracker;
  /** Called when an agent is assigned to handle a comment, before processing starts. */
  onAgentAssigned?: (agentName: string, task: string) => void;
  /** Called when a comment has been fully processed (agent ran, reply posted). */
  onCommentProcessed?: (result: { agentName: string; replyPreview: string; editSummary: string }) => void;
  /** Called when processing a comment fails. */
  onCommentFailed?: (agentName: string, error: string) => void;
  /** How tool permissions are handled for agent processes. Called per-invocation to support runtime changes. */
  permissionMode?: PermissionMode | (() => PermissionMode);
  /** Code task store for tracking worktree/PR mappings. Required for code mode. */
  codeTaskStore?: CodeTaskStore;
  /** How code modification comments are handled. Called per-invocation. Defaults to 'off'. */
  codeMode?: CodeMode | (() => CodeMode);
  /** GitHub access token for creating PRs. Called per-invocation. */
  githubToken?: () => string | null;
  /** Git repo root directory (for worktree creation). Defaults to process.cwd(). */
  repoRoot?: string;
  /** Model to use for agent runs (e.g., "haiku", "sonnet", "opus"). Called per-invocation to support runtime changes. */
  model?: string | (() => string | undefined);
  /** Harness-specific settings (e.g., codex approval mode, opencode provider). Called per-invocation. */
  harnessSettings?: Record<string, string> | (() => Record<string, string>);
  /** Chat tab store for tracking chat tabs and messages. Required for chat mode. */
  chatTabStore?: ChatTabStore;
  /** Whether chat tab forking is enabled. Called per-invocation. Defaults to false. */
  chatEnabled?: boolean | (() => boolean);
  /** Called when the system transitions from busy to idle (all drain loops complete, no pending work). */
  onIdle?: () => void;
  /** Debounce interval in ms before firing onIdle (default: 3000). */
  idleDebounceMs?: number;
  /** Optional logger. */
  debug?: (msg: string) => void;
}

export class AgentOrchestrator {
  private client: CodocsClient;
  private replyClient: CodocsClient;
  private replyTracker?: ReplyTracker;
  private sessionStore: SessionStore;
  private queueStore: QueueStore;
  private agentRunner: AgentRunner;
  private fallbackAgent: string | ((documentId: string) => string);
  private onAgentAssigned: (agentName: string, task: string) => void;
  private onCommentProcessed: (result: { agentName: string; replyPreview: string; editSummary: string }) => void;
  private onCommentFailed: (agentName: string, error: string) => void;
  private debug: (msg: string) => void;
  private getPermissionMode: () => PermissionMode;
  private codeTaskStore?: CodeTaskStore;
  private getCodeMode: () => CodeMode;
  private getGithubToken: () => string | null;
  private repoRoot: string;
  private getModel: () => string | undefined;
  private getHarnessSettings: () => Record<string, string>;
  private chatTabStore?: ChatTabStore;
  private chatOrchestrator?: ChatOrchestrator;
  private chatTabManager?: ChatTabManager;
  private getChatEnabled: () => boolean;
  private onIdle: (() => void) | undefined;

  /** Agents currently being drained. Prevents double-drain. */
  private processingAgents = new Set<string>();
  /** Active drain promises, keyed by agent name. */
  private drainPromises = new Map<string, Promise<void>>();
  /** Whether onIdle has already fired since the last busy state. */
  private idleFired = true;
  /** Debounce timer for idle detection. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Idle debounce interval in ms. */
  private idleDebounceMs: number;

  constructor(config: OrchestratorConfig) {
    this.client = config.client;
    this.replyClient = config.replyClient ?? config.client;
    this.replyTracker = config.replyTracker;
    this.sessionStore = config.sessionStore;
    this.queueStore = config.queueStore;
    this.agentRunner = config.agentRunner;
    this.fallbackAgent = config.fallbackAgent;
    this.onAgentAssigned = config.onAgentAssigned ?? (() => {});
    this.onCommentProcessed = config.onCommentProcessed ?? (() => {});
    this.onCommentFailed = config.onCommentFailed ?? (() => {});
    this.onIdle = config.onIdle;
    this.idleDebounceMs = config.idleDebounceMs ?? 3000;
    this.debug = config.debug ?? (() => {});

    const pm = config.permissionMode;
    this.getPermissionMode = typeof pm === 'function' ? pm : () => pm ?? { type: 'auto' };

    this.codeTaskStore = config.codeTaskStore;
    const cm = config.codeMode;
    this.getCodeMode = typeof cm === 'function' ? cm : () => cm ?? 'off';
    this.getGithubToken = config.githubToken ?? (() => null);
    this.repoRoot = config.repoRoot ?? process.cwd();
    const m = config.model;
    this.getModel = typeof m === 'function' ? m : () => m;
    const hs = config.harnessSettings;
    this.getHarnessSettings = typeof hs === 'function' ? hs : () => hs ?? {};

    // Chat tab setup
    this.chatTabStore = config.chatTabStore;
    const ce = config.chatEnabled;
    this.getChatEnabled = typeof ce === 'function' ? ce : () => ce ?? false;

    if (this.chatTabStore) {
      this.chatTabManager = new ChatTabManager(
        this.client,
        this.chatTabStore,
        this.debug,
      );
      this.chatOrchestrator = new ChatOrchestrator({
        client: this.client,
        replyClient: this.replyClient,
        replyTracker: this.replyTracker,
        sessionStore: this.sessionStore,
        chatTabStore: this.chatTabStore,
        chatTabManager: this.chatTabManager,
        agentRunner: this.agentRunner,
        permissionMode: config.permissionMode,
        model: config.model,
        harnessSettings: config.harnessSettings,
        debug: this.debug,
      });
    }
  }

  /** Resolve the fallback agent name for a given document. */
  private resolveFallbackAgent(documentId: string): string {
    return typeof this.fallbackAgent === 'function'
      ? this.fallbackAgent(documentId)
      : this.fallbackAgent;
  }

  /**
   * Post a reply and record its ID in the reply tracker so the listener
   * can filter out the resulting self-triggered event.
   */
  private async postReply(documentId: string, commentId: string, content: string): Promise<string> {
    const id = await this.replyClient.replyToComment(documentId, commentId, content);
    this.replyTracker?.add(id);
    return id;
  }

  /** Return currently active agent processes. */
  getActiveAgents() {
    return this.agentRunner.getActiveProcesses();
  }

  /** Kill all active agent processes. Returns the names of killed agents. */
  killAll(): string[] {
    return this.agentRunner.killAll();
  }

  /**
   * Handle a comment event: assign an agent, enqueue, and kick off
   * the drain loop if the agent is idle.
   *
   * Returns immediately with `editSummary: 'Queued'` if the agent
   * is already busy processing another comment.
   */
  async handleComment(event: CommentEvent): Promise<{
    agentName: string;
    replyPreview: string;
    editSummary: string;
  }> {
    const { documentId, comment } = event;
    const commentText = comment.content ?? '';
    const quotedText = comment.quotedText ?? '';

    if (!commentText) {
      this.debug('Skipping comment with no content');
      return { agentName: '', replyPreview: '', editSummary: 'No content' };
    }

    this.debug(`Handling comment on doc ${documentId}: "${commentText}"`);

    // Step 0: Check if this comment belongs to a chat tab
    if (this.chatTabStore && this.chatOrchestrator) {
      const route = await routeComment(event, this.chatTabStore, this.client);
      if (route.type === 'chat') {
        this.debug(`Routing to chat tab: ${route.chatTab.title}`);
        const result = await this.chatOrchestrator.handleChatMessage(route.chatTab, event);
        const agentName = route.chatTab.agentName;
        this.onCommentProcessed({ agentName, ...result });
        return { agentName, ...result };
      }
    }

    // Step 1: Fetch document and attributions to assign the agent
    const document = await this.client.getDocument(documentId);
    const attributions = await this.client.getAttributions(documentId);

    // Step 2: Assign agent
    const agentName = assignAgent(quotedText, attributions, document, {
      fallbackAgent: this.resolveFallbackAgent(documentId),
    });
    this.debug(`Assigned to agent: ${agentName}`);

    // Step 3: Enqueue
    this.queueStore.enqueue(agentName, documentId, event);
    this.debug(`Enqueued comment for ${agentName} (pending: ${this.queueStore.pendingCount(agentName)})`);

    // Step 4: If the agent is idle, start draining
    if (!this.processingAgents.has(agentName)) {
      this.idleFired = false;
      const drainPromise = this.drainQueue(agentName).catch((err) => {
        this.debug(`Queue drain error for ${agentName}: ${err}`);
      });
      this.drainPromises.set(agentName, drainPromise);
      return { agentName, replyPreview: '', editSummary: '' };
    }

    // Agent is busy — return immediately
    return { agentName, replyPreview: '', editSummary: 'Queued' };
  }

  /**
   * Wait for all active drain loops to complete.
   * Useful for tests and graceful shutdown.
   */
  async waitForIdle(): Promise<void> {
    await Promise.all(this.drainPromises.values());
  }

  /**
   * Cancel any pending idle check timer. Use during shutdown to prevent
   * stale timer fires.
   */
  cancelIdleCheck(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleFired = true;
  }

  /**
   * Check if the system just transitioned to idle (all drain loops done,
   * no pending work). Uses a debounce to avoid thrashing on rapid comment
   * sequences.
   */
  private checkIdle(): void {
    if (this.idleFired) return;
    if (this.processingAgents.size > 0 || this.drainPromises.size > 0) return;

    if (this.idleTimer) clearTimeout(this.idleTimer);

    this.idleTimer = setTimeout(() => {
      // Re-check after debounce — a new comment may have arrived
      if (this.processingAgents.size > 0 || this.drainPromises.size > 0 || this.idleFired) return;
      if (this.queueStore.pendingAgents().length > 0) return;
      this.idleFired = true;
      this.debug('System idle — firing onIdle callback');
      this.onIdle?.();
    }, this.idleDebounceMs);
  }

  /**
   * Drain the queue for a single agent, processing items one at a time.
   */
  private async drainQueue(agentName: string): Promise<void> {
    if (this.processingAgents.has(agentName)) return;
    this.processingAgents.add(agentName);

    try {
      while (true) {
        const item = this.queueStore.dequeue(agentName);
        if (!item) break;

        try {
          const result = await this.processComment(item.commentEvent as CommentEvent, agentName);
          this.queueStore.markCompleted(item.id);
          this.onCommentProcessed({ agentName, ...result });
        } catch (err: any) {
          this.debug(`Failed to process queue item ${item.id}: ${err.message ?? err}`);
          this.queueStore.markFailed(item.id, String(err));
          this.onCommentFailed(agentName, err.message ?? String(err));
        }
      }
    } finally {
      this.processingAgents.delete(agentName);
      this.drainPromises.delete(agentName);
      this.checkIdle();
    }
  }

  /**
   * Recover from a previous crash by resetting stale queue items and draining.
   */
  async recoverQueue(): Promise<void> {
    const count = this.queueStore.resetStaleProcessing();
    if (count > 0) this.debug(`Recovered ${count} stale queue item(s)`);

    const agents = this.queueStore.pendingAgents();
    for (const agentName of agents) {
      this.idleFired = false;
      this.drainQueue(agentName).catch((err) => {
        this.debug(`Recovery drain error for ${agentName}: ${err}`);
      });
    }
  }

  /**
   * Process a single comment event end-to-end.
   * The agent has already been assigned; this does the actual work.
   *
   * When code mode is enabled ('pr' or 'direct'), the agent is first asked
   * to classify the comment. Code modification requests are routed to
   * processCodeComment; doc/informational requests use the existing flow.
   */
  private async processComment(event: CommentEvent, agentName: string): Promise<{ replyPreview: string; editSummary: string }> {
    const { documentId, comment } = event;
    const quotedText = comment.quotedText ?? '';
    const commentText = comment.content ?? '';

    this.debug(`[processComment] Starting for ${agentName}: "${commentText.slice(0, 40)}"`);
    this.onAgentAssigned(agentName, commentText.slice(0, 60));

    // Verify the user (not the bot) still has access to this document.
    // Prevents the bot from acting on docs the user has lost access to.
    if (this.replyClient !== this.client) {
      const userHasAccess = await this.client.canAccess(documentId);
      if (!userHasAccess) {
        this.debug(`[processComment] User no longer has access to ${documentId}, skipping`);
        return { replyPreview: '', editSummary: 'Skipped — user lost access' };
      }
    }

    // Check for an existing code task on this thread (follow-up detection)
    const codeMode = this.getCodeMode();
    if (codeMode !== 'off' && comment.id && this.codeTaskStore) {
      const existingTask = this.codeTaskStore.getByComment(documentId, comment.id);
      if (existingTask) {
        this.debug(`[processComment] Follow-up on existing code task (PR #${existingTask.prNumber}), routing to code mode`);
        return this.processCodeComment(event, agentName, existingTask);
      }
    }

    // Post a thinking reply so the user knows the agent picked it up
    let thinkingReplyId: string | null = null;
    if (comment.id) {
      try {
        thinkingReplyId = await this.postReply(
          documentId,
          comment.id,
          '\u{1F914}',
        );
        this.debug('Posted thinking reply');
      } catch (err) {
        this.debug(`Failed to post thinking reply: ${err}`);
      }
    }

    // Snapshot the document as markdown (fresh state for this queue item)
    const document = await this.client.getDocument(documentId);
    const baseMarkdown = docsToMarkdown(document);

    // Write temp files in a dedicated workspace directory
    const { editPath, basePath } = await writeTempContext(baseMarkdown, documentId, agentName);
    this.debug(`Edit file: ${editPath}`);

    let replyContent = '';
    let editSummary = 'No changes';

    try {
      // Build prompt — prepend classification preamble if code mode is available
      const classificationPreamble = (codeMode !== 'off' && this.codeTaskStore)
        ? buildClassificationPreamble() + '\n'
        : '';

      const prompt = classificationPreamble + buildPrompt({
        mdFilePath: editPath,
        commentText,
        quotedText,
        agentName,
        documentId,
        thread: event.thread,
      });

      this.debug(`[processComment] Prompt built, looking up session`);
      // Look up or create session
      const sessionKey = comment.id ? `${documentId}:${comment.id}` : documentId;
      let session = this.sessionStore.getSession(agentName, sessionKey);
      const existingSessionId = session?.sessionId ?? null;
      this.debug(
        existingSessionId
          ? `Resuming session: ${existingSessionId}`
          : 'Creating new session',
      );

      // Run the agent
      const runOpts = {
        workingDirectory: undefined,
        agentName,
        permissionMode: this.getPermissionMode(),
        model: this.getModel(),
        harnessSettings: this.getHarnessSettings(),
      };
      this.debug(`[processComment] Running agent (session: ${existingSessionId ?? 'new'})`);
      let result = await this.agentRunner.run(prompt, existingSessionId, runOpts);
      this.debug(`[processComment] Agent finished (exit: ${result.exitCode}, stdout: ${result.stdout.length} chars)`);

      // Handle session resume failure — retry with fresh session
      if (result.exitCode !== 0 && existingSessionId) {
        this.debug(
          `Session resume failed (exit ${result.exitCode}), retrying with fresh session`,
        );
        this.sessionStore.deleteSession(agentName, sessionKey);
        result = await this.agentRunner.run(prompt, null, runOpts);
      }

      // Store session mapping
      this.sessionStore.upsertSession(agentName, sessionKey, result.sessionId);

      // If classification was requested, check if this should be routed to code mode
      if (codeMode !== 'off' && this.codeTaskStore) {
        const classification = parseClassification(result.stdout);
        if (classification.mode === 'code') {
          this.debug(`[processComment] Classified as code change: ${classification.description}`);
          // Clean up temp files — code mode doesn't use them
          await cleanupTempFiles(editPath, basePath);
          // Replace thinking reply before routing to code mode
          await this.replaceThinkingReply(documentId, comment.id, thinkingReplyId, null);
          thinkingReplyId = null; // prevent double-cleanup in finally
          return this.processCodeComment(event, agentName, null, classification.description);
        }
        if (classification.mode === 'chat' && this.getChatEnabled() && this.chatTabManager) {
          this.debug(`[processComment] Classified as chat: ${classification.description}`);
          await cleanupTempFiles(editPath, basePath);
          await this.replaceThinkingReply(documentId, comment.id, thinkingReplyId, null);
          thinkingReplyId = null;
          return this.forkToChat(event, agentName, classification.description, classification.response);
        }
        // Doc mode — use the stripped response (without the [MODE: doc] header)
        result = { ...result, stdout: classification.response };
      }

      // Read the agent's edited file
      const editedMarkdown = await readFile(editPath, 'utf-8');

      // Fetch current document state (may have changed during agent run)
      const currentDoc = await this.client.getDocument(documentId);
      const { markdown: theirs, indexMap } = docsToMarkdownWithMapping(currentDoc);

      // 3-way merge and compute doc operations
      const base = await readFile(basePath, 'utf-8');

      // Diagnostic: did the agent actually modify the edit file?
      if (editedMarkdown === base) {
        this.debug(`Agent did NOT modify the edit file (${base.length} chars unchanged)`);
      } else {
        this.debug(`Agent modified edit file: ${base.length} → ${editedMarkdown.length} chars`);
      }
      const diffResult = await computeDocDiff(
        base,
        editedMarkdown,
        theirs,
        currentDoc,
        indexMap,
        agentName,
        async (conflictText) => {
          this.debug('Sending merge conflicts to agent for resolution');
          const conflictPrompt = buildConflictPrompt(editPath, conflictText);

          const { writeFile } = await import('node:fs/promises');
          await writeFile(editPath, conflictText, 'utf-8');

          const resolveResult = await this.agentRunner.run(
            conflictPrompt,
            result.sessionId,
            runOpts,
          );

          if (resolveResult.exitCode !== 0) {
            this.debug('Conflict resolution failed, using conflict markers as-is');
            return conflictText;
          }

          return await readFile(editPath, 'utf-8');
        },
      );

      // Apply changes to Google Doc
      if (diffResult.hasChanges) {
        this.debug(
          `Applying ${diffResult.requests.length} doc operations (${diffResult.conflictsResolved} conflicts resolved)`,
        );
        await this.client.batchUpdate(documentId, diffResult.requests);
      } else {
        this.debug('No changes to apply');
      }

      // Build reply and summary
      const agentResponse = result.stdout.trim();
      replyContent = agentResponse
        || (diffResult.hasChanges ? 'Done \u2014 changes applied to the document.' : 'Done \u2014 no changes needed.');
      editSummary = diffResult.hasChanges
        ? `${diffResult.requests.length} edit${diffResult.requests.length !== 1 ? 's' : ''}${diffResult.conflictsResolved ? `, ${diffResult.conflictsResolved} conflict${diffResult.conflictsResolved !== 1 ? 's' : ''} resolved` : ''}`
        : 'No changes';
    } catch (err: any) {
      this.debug(`Error during processing: ${err.message ?? err}`);
      replyContent = replyContent || `Error: ${err.message ?? 'unknown error'}`;
      throw err;
    } finally {
      await this.replaceThinkingReply(documentId, comment.id, thinkingReplyId, replyContent);
      await cleanupTempFiles(editPath, basePath);
      this.debug(`[processComment] Done`);
    }

    return { replyPreview: replyContent, editSummary };
  }

  /**
   * Replace the thinking emoji reply with the actual response.
   *
   * We use delete + create instead of updateReply because Google Docs
   * does not live-refresh the comment sidebar when a reply is updated
   * via the API (drive.replies.update). The API call succeeds and
   * subsequent reads return the updated content, but the Docs UI won't
   * show the change until the user manually reloads the page. Creating
   * a new reply triggers a UI notification and renders immediately.
   */
  private async replaceThinkingReply(
    documentId: string,
    commentId: string | undefined,
    thinkingReplyId: string | null,
    replyContent: string | null,
  ): Promise<void> {
    if (commentId && thinkingReplyId) {
      try {
        await this.replyClient.deleteReply(documentId, commentId, thinkingReplyId);
        this.debug(`Deleted thinking reply`);
      } catch (delErr: any) {
        this.debug(`Failed to delete thinking reply (continuing): ${delErr.message ?? delErr}`);
      }
      if (replyContent) {
        try {
          await this.postReply(documentId, commentId, replyContent);
          this.debug(`Posted final reply`);
        } catch (replyErr: any) {
          this.debug(`Failed to post final reply: ${replyErr.message ?? replyErr}`);
        }
      }
    } else if (commentId && replyContent) {
      try {
        await this.postReply(documentId, commentId, replyContent);
        this.debug(`Reply created (no thinking reply to update)`);
      } catch (err: any) {
        this.debug(`Reply failed: ${err.message ?? err}`);
      }
    }
  }

  /**
   * Process a code modification comment: create/reuse a git worktree,
   * run the agent, commit changes, and create/update a draft PR.
   */
  private async processCodeComment(
    event: CommentEvent,
    agentName: string,
    existingTask?: { id: number; branchName: string; worktreePath: string; prNumber: number | null; prUrl: string | null; baseBranch: string } | null,
    codeDescription?: string,
  ): Promise<{ replyPreview: string; editSummary: string }> {
    const { documentId, comment } = event;
    const commentText = comment.content ?? '';
    const quotedText = comment.quotedText ?? '';
    const codeMode = this.getCodeMode();

    // Post thinking reply
    let thinkingReplyId: string | null = null;
    if (comment.id) {
      try {
        thinkingReplyId = await this.postReply(documentId, comment.id, '\u{1F914}');
      } catch (err) {
        this.debug(`Failed to post thinking reply: ${err}`);
      }
    }

    let replyContent = '';
    let editSummary = 'No changes';

    try {
      const isFollowUp = !!existingTask;
      let worktreePath: string;
      let branchName: string;
      let baseBranch: string;
      let taskId: number | undefined;
      let prNumber: number | null = null;
      let prUrl: string | null = null;

      if (codeMode === 'pr') {
        if (isFollowUp && existingTask) {
          // Follow-up: reuse existing worktree and branch
          worktreePath = existingTask.worktreePath;
          branchName = existingTask.branchName;
          baseBranch = existingTask.baseBranch;
          taskId = existingTask.id;
          prNumber = existingTask.prNumber;
          prUrl = existingTask.prUrl;

          this.debug(`[processCodeComment] Follow-up on branch ${branchName}`);

          // Rebase onto latest base branch
          const rebaseResult = await rebaseOnto(worktreePath, baseBranch);
          if (!rebaseResult.success) {
            this.debug(`[processCodeComment] Rebase had conflicts, agent will work from current state`);
          }
        } else {
          // New code task: create worktree + branch
          baseBranch = await getDefaultBranch(this.repoRoot);
          const slug = (codeDescription ?? 'code-change')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);
          const uuid = randomUUID().slice(0, 8);
          branchName = `codocs/${agentName}/${slug}-${uuid}`;

          this.debug(`[processCodeComment] Creating worktree: ${branchName}`);
          const wt = await createWorktree(this.repoRoot, baseBranch, branchName);
          worktreePath = wt.worktreePath;

          // Store the task
          if (this.codeTaskStore && comment.id) {
            taskId = this.codeTaskStore.create({
              documentId,
              commentId: comment.id,
              agentName,
              branchName,
              worktreePath,
              baseBranch,
            });
          }
        }
      } else {
        // Direct mode: run agent in the repo root, no worktree
        worktreePath = this.repoRoot;
        branchName = '';
        baseBranch = '';
      }

      // Build code prompt and run the agent
      const prompt = buildCodePrompt({
        agentName,
        commentText,
        quotedText,
        documentId,
        thread: event.thread,
        workingDirectory: worktreePath,
        existingPR: prNumber && prUrl ? { number: prNumber, url: prUrl } : undefined,
      });

      const sessionKey = comment.id ? `${documentId}:${comment.id}:code` : `${documentId}:code`;
      let session = this.sessionStore.getSession(agentName, sessionKey);
      const existingSessionId = session?.sessionId ?? null;

      const runOpts = {
        workingDirectory: worktreePath,
        agentName,
        permissionMode: this.getPermissionMode(),
        model: this.getModel(),
        harnessSettings: this.getHarnessSettings(),
      };

      this.debug(`[processCodeComment] Running agent in ${worktreePath}`);
      let result = await this.agentRunner.run(prompt, existingSessionId, runOpts);

      if (result.exitCode !== 0 && existingSessionId) {
        this.debug(`Session resume failed, retrying with fresh session`);
        this.sessionStore.deleteSession(agentName, sessionKey);
        result = await this.agentRunner.run(prompt, null, runOpts);
      }

      this.sessionStore.upsertSession(agentName, sessionKey, result.sessionId);

      const agentResponse = result.stdout.trim();

      if (codeMode === 'pr') {
        // Commit changes in the worktree
        const commitMessage = codeDescription ?? commentText.slice(0, 72);
        const sha = await commitAll(worktreePath, commitMessage);

        if (sha) {
          this.debug(`[processCodeComment] Committed: ${sha}`);

          // Push the branch
          await pushBranch(worktreePath, branchName);
          this.debug(`[processCodeComment] Pushed branch ${branchName}`);

          // Create or update PR
          const ghToken = this.getGithubToken();
          if (ghToken && !prNumber) {
            // New PR
            try {
              const repoInfo = await getRepoInfo(this.repoRoot);
              const prInfo = await createDraftPR({
                token: ghToken,
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                branch: branchName,
                baseBranch,
                title: codeDescription ?? commentText.slice(0, 72),
                body: buildPRBody({ commentText, documentId, agentName }),
              });
              prNumber = prInfo.number;
              prUrl = prInfo.url;
              this.debug(`[processCodeComment] Created draft PR #${prNumber}: ${prUrl}`);

              if (this.codeTaskStore && taskId != null) {
                this.codeTaskStore.updatePR(taskId, prNumber, prUrl);
              }
            } catch (prErr: any) {
              this.debug(`[processCodeComment] Failed to create PR: ${prErr.message}`);
            }
          } else if (ghToken && prNumber) {
            // Follow-up: add comment to existing PR
            try {
              const repoInfo = await getRepoInfo(this.repoRoot);
              await addPRComment({
                token: ghToken,
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                prNumber,
                body: `Follow-up from Google Doc comment:\n> ${commentText}\n\n${agentResponse}`,
              });
            } catch (prErr: any) {
              this.debug(`[processCodeComment] Failed to add PR comment: ${prErr.message}`);
            }
          }

          editSummary = prUrl ? `PR ${prUrl}` : `Committed ${sha.slice(0, 7)}`;
        } else {
          this.debug(`[processCodeComment] No changes to commit`);
          editSummary = 'No code changes';
        }

        // Build reply with PR link
        replyContent = agentResponse || 'Done — no code changes needed.';
        if (prUrl) {
          replyContent += `\n\nDraft PR: ${prUrl}`;
        }
      } else {
        // Direct mode: no commit/PR management
        replyContent = agentResponse || 'Done.';
        editSummary = 'Direct code changes';
      }
    } catch (err: any) {
      this.debug(`[processCodeComment] Error: ${err.message ?? err}`);
      replyContent = replyContent || `Error: ${err.message ?? 'unknown error'}`;
      throw err;
    } finally {
      await this.replaceThinkingReply(documentId, comment.id, thinkingReplyId, replyContent);
      this.debug(`[processCodeComment] Done`);
    }

    return { replyPreview: replyContent, editSummary };
  }

  /**
   * Fork a comment conversation into a chat tab.
   *
   * Creates a new tab, seeds it with the conversation context,
   * writes the agent's initial response, and replies to the original
   * comment with a redirect message.
   */
  private async forkToChat(
    event: CommentEvent,
    agentName: string,
    topic?: string,
    initialResponse?: string,
  ): Promise<{ replyPreview: string; editSummary: string }> {
    if (!this.chatTabManager) {
      return { replyPreview: 'Chat tabs not configured', editSummary: '' };
    }

    const { documentId, comment } = event;
    const title = topic ?? comment.content?.slice(0, 40) ?? 'Discussion';

    this.debug(`[forkToChat] Creating chat tab: "${title}"`);

    // Create the chat tab with seed context
    const { chatTabId, tabId } = await this.chatTabManager.createChatTab(
      documentId,
      title,
      agentName,
      {
        commentText: comment.content ?? '',
        quotedText: comment.quotedText,
        threadHistory: event.thread,
      },
      comment.id,
    );

    // If the agent already produced an initial response, append it
    if (initialResponse) {
      await this.chatTabManager.appendMessage(
        documentId, tabId, chatTabId,
        agentName, 'agent', initialResponse,
      );
    }

    // Reply to the original comment with a redirect
    const replyContent = `Continuing in the "Chat: ${title}" tab \u2192`;
    if (comment.id) {
      try {
        await this.postReply(documentId, comment.id, replyContent);
      } catch (err) {
        this.debug(`[forkToChat] Failed to post redirect reply: ${err}`);
      }
    }

    this.debug(`[forkToChat] Done — tab ${tabId}, chat ${chatTabId}`);
    return { replyPreview: replyContent, editSummary: `Chat tab created: ${title}` };
  }
}
