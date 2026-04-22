/**
 * Agent orchestrator — coordinates comment handling end-to-end.
 *
 * Flow: comment event → agent assignment → enqueue → drain (serialize per agent) →
 * session lookup/create → run agent → 3-way merge → apply changes to Google Doc.
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodocsClient } from '../client/index.js';
import type { CommentEvent } from '../types.js';
import type { SessionStore, QueueStore } from './types.js';
import type { AgentRunner, PermissionMode } from './agent.js';
import { assignAgent } from './assign.js';
import { writeTempContext, cleanupTempFiles } from './context.js';
import { buildPrompt, buildConflictPrompt } from './prompt.js';
import { docsToMarkdownWithMapping } from '../converter/docs-to-md.js';
import { docsToMarkdown } from '../converter/docs-to-md.js';
import { computeDocDiff } from './diff.js';
import {
  getDefaultBranch, createWorktree, removeWorktree, commitAll,
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
   *
   * The resolver receives `commentId` and `hasAttributions` so callers
   * can vary the strategy — e.g. on a doc with zero attributions, give
   * each comment its own agent so unrelated threads run in parallel.
   */
  fallbackAgent:
    | string
    | ((documentId: string, commentId?: string, hasAttributions?: boolean) => string);
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
  /**
   * Prefix prepended to each content reply so the user can tell codocs's
   * replies apart from their own. Applied only to the final content reply,
   * not to transient indicators like the thinking emoji. Typically set to
   * "🤖 " when replying via the user's OAuth identity, and empty when
   * replyClient is a separate service account (whose name is already a
   * sufficient indicator).
   */
  botReplyPrefix?: string;
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
  private botReplyPrefix: string;
  private sessionStore: SessionStore;
  private queueStore: QueueStore;
  private agentRunner: AgentRunner;
  private fallbackAgent:
    | string
    | ((documentId: string, commentId?: string, hasAttributions?: boolean) => string);
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

  /**
   * Whether to run comments as concurrent session forks (true when the
   * configured runner supports it) vs. the legacy per-agent serial queue.
   */
  private forkMode: boolean;
  /** Agents currently being drained. Prevents double-drain. Legacy path only. */
  private processingAgents = new Set<string>();
  /** Active drain promises, keyed by agent name. Legacy path only. */
  private drainPromises = new Map<string, Promise<void>>();
  /**
   * In-flight fork-per-comment promises, keyed by agent name (multi-value).
   * A new entry is added when handleComment spawns a fork; the entry is
   * removed in the promise's finally handler.
   */
  private activePromises = new Map<string, Set<Promise<void>>>();
  /** Thinking-reply IDs posted at enqueue time, keyed by queue item id. */
  private pendingThinkingReplies = new Map<number, string>();
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
    this.botReplyPrefix = config.botReplyPrefix ?? '';
    this.sessionStore = config.sessionStore;
    this.queueStore = config.queueStore;
    this.agentRunner = config.agentRunner;
    this.forkMode = config.agentRunner.getCapabilities().supportsSessionFork === true;
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
  private resolveFallbackAgent(
    documentId: string,
    commentId: string | undefined,
    hasAttributions: boolean,
  ): string {
    return typeof this.fallbackAgent === 'function'
      ? this.fallbackAgent(documentId, commentId, hasAttributions)
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

  /**
   * Post a final content reply, prepending the bot-reply prefix so the user
   * can tell codocs's replies apart from their own when replying via the
   * user's own OAuth identity. For transient indicators like the thinking
   * emoji, call {@link postReply} directly instead.
   */
  private async postContentReply(documentId: string, commentId: string, content: string): Promise<string> {
    return this.postReply(documentId, commentId, this.botReplyPrefix + content);
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

    // Step 0b: Verify the user (not the bot) still has access to this doc.
    // Prevents the bot from acting — or even posting a "thinking" reply —
    // on docs the user has lost access to.
    if (this.replyClient !== this.client) {
      const userHasAccess = await this.client.canAccess(documentId);
      if (!userHasAccess) {
        this.debug(`[handleComment] User no longer has access to ${documentId}, skipping`);
        return { agentName: '', replyPreview: '', editSummary: 'Skipped — user lost access' };
      }
    }

    // Step 1: Fetch document and attributions to assign the agent
    const document = await this.client.getDocument(documentId);
    const attributions = await this.client.getAttributions(documentId);

    // Step 2: Assign agent
    const agentName = assignAgent(quotedText, attributions, document, {
      fallbackAgent: this.resolveFallbackAgent(
        documentId,
        comment.id,
        attributions.length > 0,
      ),
    });
    this.debug(`Assigned to agent: ${agentName}`);

    // Step 3: Enqueue
    const queueItemId = this.queueStore.enqueue(agentName, documentId, event);
    this.debug(`Enqueued comment for ${agentName} (pending: ${this.queueStore.pendingCount(agentName)})`);

    // Step 3b: Post the thinking reply eagerly so the user sees the comment
    // was picked up even if it's waiting in line behind another task.
    if (comment.id) {
      try {
        const thinkingReplyId = await this.postReply(documentId, comment.id, '\u{1F914}');
        this.pendingThinkingReplies.set(queueItemId, thinkingReplyId);
        this.debug(`Posted thinking reply at enqueue (queue item ${queueItemId})`);
      } catch (err) {
        this.debug(`Failed to post thinking reply at enqueue: ${err}`);
      }
    }

    // Step 4: Dispatch.
    //
    // Fork-mode (Claude): spawn the item concurrently — no per-agent
    // serialization. Each new thread forks the agent's base session; thread
    // follow-ups resume linearly. See processComment for session resolution.
    //
    // Legacy mode (cursor/codex/opencode): keep the per-agent drain loop,
    // since those runners can't safely concurrently resume a session.
    if (this.forkMode) {
      this.idleFired = false;
      const claimed = this.queueStore.markProcessing(queueItemId);
      if (claimed) {
        this.spawnFork(claimed, agentName);
      }
      return { agentName, replyPreview: '', editSummary: '' };
    }

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
   * Spawn a fork-mode processing promise for a queue row. `item` is already
   * in `processing` state — live dispatch calls `markProcessing` before
   * handing off, and recovery dispatch uses `dequeue`. Tracks the promise in
   * `activePromises` so waitForIdle and checkIdle account for it.
   */
  private spawnFork(item: { id: number; commentEvent: unknown }, agentName: string): void {
    let set = this.activePromises.get(agentName);
    if (!set) {
      set = new Set();
      this.activePromises.set(agentName, set);
    }
    const thinkingReplyId = this.pendingThinkingReplies.get(item.id) ?? null;
    this.pendingThinkingReplies.delete(item.id);

    const promise: Promise<void> = Promise.resolve()
      .then(async () => {
        try {
          const result = await this.processComment(
            item.commentEvent as CommentEvent,
            agentName,
            thinkingReplyId,
          );
          this.queueStore.markCompleted(item.id);
          this.onCommentProcessed({ agentName, ...result });
        } catch (err: any) {
          this.debug(`Failed to process queue item ${item.id}: ${err.message ?? err}`);
          this.queueStore.markFailed(item.id, String(err));
          this.onCommentFailed(agentName, err.message ?? String(err));
        }
      })
      .finally(() => {
        const s = this.activePromises.get(agentName);
        if (s) {
          s.delete(promise);
          if (s.size === 0) this.activePromises.delete(agentName);
        }
        this.checkIdle();
      });
    set.add(promise);
  }

  /**
   * Wait for all active drain loops and fork promises to complete.
   * Useful for tests and graceful shutdown. Loops until both tracking
   * maps are empty, since a new fork can be scheduled during the await.
   */
  async waitForIdle(): Promise<void> {
    while (this.drainPromises.size > 0 || this.activePromises.size > 0) {
      const all: Promise<any>[] = [...this.drainPromises.values()];
      for (const set of this.activePromises.values()) all.push(...set);
      if (all.length === 0) break;
      await Promise.allSettled(all);
    }
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
    if (
      this.processingAgents.size > 0
      || this.drainPromises.size > 0
      || this.activePromises.size > 0
    ) return;

    if (this.idleTimer) clearTimeout(this.idleTimer);

    this.idleTimer = setTimeout(() => {
      // Re-check after debounce — a new comment may have arrived
      if (
        this.processingAgents.size > 0
        || this.drainPromises.size > 0
        || this.activePromises.size > 0
        || this.idleFired
      ) return;
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

        const thinkingReplyId = this.pendingThinkingReplies.get(item.id) ?? null;
        this.pendingThinkingReplies.delete(item.id);

        try {
          const result = await this.processComment(
            item.commentEvent as CommentEvent,
            agentName,
            thinkingReplyId,
          );
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
    const count = this.queueStore.resetAllProcessing();
    if (count > 0) this.debug(`Recovered ${count} stale queue item(s)`);

    const agents = this.queueStore.pendingAgents();
    for (const agentName of agents) {
      this.idleFired = false;

      if (this.forkMode) {
        // Fork mode: claim every pending row and fork-spawn it concurrently.
        let item;
        while ((item = this.queueStore.dequeue(agentName))) {
          this.spawnFork(item, agentName);
        }
      } else {
        this.drainQueue(agentName).catch((err) => {
          this.debug(`Recovery drain error for ${agentName}: ${err}`);
        });
      }
    }
  }

  /**
   * Process a single comment event end-to-end.
   *
   * One unified flow handles doc edits, code changes, and chat escalation.
   * The agent is not asked to classify up front; the orchestrator detects
   * what happened from side effects after the run:
   *   1. A chat marker file preempts everything and forks to a chat tab.
   *   2. Tracked files changed in the worktree → commit, push, draft PR.
   *   3. The design-doc snapshot changed → 3-way merge and apply to the doc.
   *
   * Code changes are only attempted when `codeMode` is 'pr' or 'direct'. In
   * 'off' mode the agent still gets the design doc file but the prompt tells
   * it that source modifications are disabled.
   */
  private async processComment(
    event: CommentEvent,
    agentName: string,
    preExistingThinkingReplyId: string | null = null,
  ): Promise<{ replyPreview: string; editSummary: string }> {
    const { documentId, comment } = event;
    const quotedText = comment.quotedText ?? '';
    const commentText = comment.content ?? '';
    const codeMode = this.getCodeMode();
    const codeEnabled = codeMode !== 'off';

    this.debug(`[processComment] Starting for ${agentName}: "${commentText.slice(0, 40)}" (codeMode=${codeMode})`);
    this.onAgentAssigned(agentName, commentText.slice(0, 60));

    // Thinking reply (reused from enqueue time if available)
    let thinkingReplyId: string | null = preExistingThinkingReplyId;
    if (!thinkingReplyId && comment.id) {
      try {
        thinkingReplyId = await this.postReply(documentId, comment.id, '\u{1F914}');
      } catch (err) {
        this.debug(`Failed to post thinking reply: ${err}`);
      }
    }

    // Worktree setup.
    //   • pr + follow-up: reuse the thread's existing worktree, rebase on base.
    //   • pr + new thread: create fresh worktree off default branch.
    //   • direct / off: run in repo root (no branch, no commits).
    let worktreePath: string;
    let branchName = '';
    let baseBranch = '';
    let existingTask: {
      id: number; branchName: string; worktreePath: string;
      prNumber: number | null; prUrl: string | null; baseBranch: string;
    } | null = null;
    let prNumber: number | null = null;
    let prUrl: string | null = null;
    let createdNewWorktree = false;

    if (codeMode === 'pr' && comment.id && this.codeTaskStore) {
      existingTask = this.codeTaskStore.getByComment(documentId, comment.id);
    }

    if (codeMode === 'pr' && existingTask) {
      worktreePath = existingTask.worktreePath;
      branchName = existingTask.branchName;
      baseBranch = existingTask.baseBranch;
      prNumber = existingTask.prNumber;
      prUrl = existingTask.prUrl;
      this.debug(`[processComment] Follow-up on branch ${branchName}`);
      const rebaseResult = await rebaseOnto(worktreePath, baseBranch);
      if (!rebaseResult.success) {
        this.debug('[processComment] Rebase had conflicts; agent works from current state');
      }
    } else if (codeMode === 'pr') {
      baseBranch = await getDefaultBranch(this.repoRoot);
      const slug = commentText
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'change';
      const uuid = randomUUID().slice(0, 8);
      branchName = `codocs/${agentName}/${slug}-${uuid}`;
      this.debug(`[processComment] Creating worktree: ${branchName}`);
      const wt = await createWorktree(this.repoRoot, baseBranch, branchName);
      worktreePath = wt.worktreePath;
      createdNewWorktree = true;
    } else {
      worktreePath = this.repoRoot;
    }

    // Snapshot the doc into the working directory. `.codocs/` is gitignored
    // (we ensure it below), so the design-doc snapshot never ends up in a PR.
    const document = await this.client.getDocument(documentId);
    const baseMarkdown = docsToMarkdown(document);
    const codocsDir = join(worktreePath, '.codocs');
    await mkdir(codocsDir, { recursive: true });
    const gitignorePath = join(codocsDir, '.gitignore');
    if (!existsSync(gitignorePath)) {
      await writeFile(gitignorePath, '*\n', 'utf-8');
    }
    // In direct/off mode multiple concurrent runs share cwd, so suffix paths.
    // In pr mode each worktree is per-thread, so fixed names are fine.
    const suffix = codeMode === 'pr' ? '' : `-${randomUUID().slice(0, 8)}`;
    const designDocPath = join(codocsDir, `design-doc${suffix}.md`);
    const baseDocPath = join(codocsDir, `.design-doc${suffix}-base.md`);
    const chatMarkerPath = join(codocsDir, `chat-tab${suffix}.json`);
    try { await unlink(chatMarkerPath); } catch { /* not present */ }
    await writeFile(designDocPath, baseMarkdown, 'utf-8');
    await writeFile(baseDocPath, baseMarkdown, 'utf-8');
    this.debug(`[processComment] Design doc snapshot at ${designDocPath}`);

    let replyContent = '';
    let editSummary = 'No changes';

    try {
      const prompt = buildPrompt({
        agentName,
        commentText,
        quotedText,
        documentId,
        thread: event.thread,
        workingDirectory: worktreePath,
        designDocPath,
        chatMarkerPath,
        codeEnabled,
        existingPR: prNumber && prUrl ? { number: prNumber, url: prUrl } : undefined,
      });

      // Session resolution:
      //   • Follow-up on an existing thread → resume the thread's session.
      //   • Brand-new thread → fork from the agent's base session for this doc.
      //   • Otherwise → start fresh.
      const sessionKey = comment.id ? `${documentId}:${comment.id}` : documentId;
      const baseKey = `${documentId}:base`;
      const threadSession = this.sessionStore.getSession(agentName, sessionKey);
      let parentSessionId: string | null = threadSession?.sessionId ?? null;
      let forkSession = false;

      if (!parentSessionId && this.forkMode) {
        const base = this.sessionStore.getSession(agentName, baseKey);
        if (base?.sessionId) {
          parentSessionId = base.sessionId;
          forkSession = true;
        }
      }

      this.debug(
        parentSessionId
          ? `${forkSession ? 'Forking' : 'Resuming'} session: ${parentSessionId}`
          : 'Creating new session',
      );

      // Agent runs in the worktree for pr mode; in cwd for direct/off.
      const runOpts = {
        workingDirectory: codeMode === 'pr' ? worktreePath : undefined,
        agentName,
        permissionMode: this.getPermissionMode(),
        model: this.getModel(),
        harnessSettings: this.getHarnessSettings(),
        forkSession,
      };

      this.debug(`[processComment] Running agent in ${runOpts.workingDirectory ?? 'cwd'}`);
      let result = await this.agentRunner.run(prompt, parentSessionId, runOpts);
      this.debug(`[processComment] Agent finished (exit: ${result.exitCode}, stdout: ${result.stdout.length} chars)`);

      // On failure with a parent session, retry fresh.
      if (result.exitCode !== 0 && parentSessionId) {
        this.debug(`Session ${forkSession ? 'fork' : 'resume'} failed (exit ${result.exitCode}), retrying with fresh session`);
        if (!forkSession) {
          this.sessionStore.deleteSession(agentName, sessionKey);
        }
        result = await this.agentRunner.run(prompt, null, { ...runOpts, forkSession: false });
      }

      this.sessionStore.upsertSession(agentName, sessionKey, result.sessionId);

      // --- Detect outcome from side effects, in priority order ---

      // 1. Chat escalation preempts everything else.
      if (existsSync(chatMarkerPath)) {
        let chatTitle: string | undefined;
        try {
          const raw = await readFile(chatMarkerPath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.title === 'string' && parsed.title.trim()) {
            chatTitle = parsed.title.trim();
          }
        } catch (err) {
          this.debug(`Chat marker malformed, ignoring: ${err}`);
        }
        if (chatTitle && this.getChatEnabled() && this.chatTabManager) {
          this.debug(`[processComment] Chat escalation requested: "${chatTitle}"`);
          await this.replaceThinkingReply(documentId, comment.id, thinkingReplyId, null);
          thinkingReplyId = null;
          if (createdNewWorktree) {
            try { await removeWorktree(this.repoRoot, worktreePath); } catch { /* ignore */ }
          }
          await cleanupTempFiles(designDocPath, baseDocPath, chatMarkerPath);
          return await this.forkToChat(event, agentName, chatTitle, result.stdout.trim());
        } else if (chatTitle) {
          this.debug('Chat escalation requested but chat is disabled — treating as a regular comment');
        }
      }

      // 2. Code changes — pr mode only. `.codocs/` is gitignored so design-doc
      //    edits don't trigger a commit.
      let codeChangesMade = false;
      if (codeMode === 'pr') {
        const commitMessage = commentText.slice(0, 72) || 'codocs change';
        const sha = await commitAll(worktreePath, commitMessage);
        if (sha) {
          codeChangesMade = true;
          this.debug(`[processComment] Committed: ${sha}`);
          await pushBranch(worktreePath, branchName);
          this.debug(`[processComment] Pushed branch ${branchName}`);

          const ghToken = this.getGithubToken();
          if (ghToken && !prNumber) {
            try {
              const repoInfo = await getRepoInfo(this.repoRoot);
              const prInfo = await createDraftPR({
                token: ghToken,
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                branch: branchName,
                baseBranch,
                title: commentText.slice(0, 72) || 'Codocs change',
                body: buildPRBody({ commentText, documentId, agentName }),
              });
              prNumber = prInfo.number;
              prUrl = prInfo.url;
              this.debug(`[processComment] Created draft PR #${prNumber}: ${prUrl}`);
            } catch (prErr: any) {
              this.debug(`[processComment] Failed to create PR: ${prErr.message}`);
            }
          } else if (ghToken && prNumber) {
            try {
              const repoInfo = await getRepoInfo(this.repoRoot);
              await addPRComment({
                token: ghToken,
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                prNumber,
                body: `Follow-up from Google Doc comment:\n> ${commentText}\n\n${result.stdout.trim()}`,
              });
            } catch (prErr: any) {
              this.debug(`[processComment] Failed to add PR comment: ${prErr.message}`);
            }
          }

          // Record/update the code task so future follow-ups reuse this worktree.
          if (this.codeTaskStore && comment.id) {
            if (!existingTask) {
              const newTaskId = this.codeTaskStore.create({
                documentId, commentId: comment.id, agentName,
                branchName, worktreePath, baseBranch,
              });
              if (prNumber != null && prUrl != null) {
                this.codeTaskStore.updatePR(newTaskId, prNumber, prUrl);
              }
            } else if (prNumber != null && prUrl != null && existingTask.prNumber == null) {
              this.codeTaskStore.updatePR(existingTask.id, prNumber, prUrl);
            }
          }

          if (this.forkMode) {
            this.sessionStore.upsertSession(agentName, baseKey, result.sessionId);
          }
        } else {
          this.debug('[processComment] No code changes to commit');
        }
      }

      // 3. Doc changes — always check. Compares the snapshot against base.
      const editedMarkdown = await readFile(designDocPath, 'utf-8');
      const base = await readFile(baseDocPath, 'utf-8');
      let docEditCount = 0;
      let conflictsResolved = 0;

      if (editedMarkdown !== base) {
        this.debug(`Design doc changed: ${base.length} → ${editedMarkdown.length} chars`);
        const currentDoc = await this.client.getDocument(documentId);
        const { markdown: theirs, indexMap } = docsToMarkdownWithMapping(currentDoc);
        const diffResult = await computeDocDiff(
          base, editedMarkdown, theirs, currentDoc, indexMap, agentName,
          async (conflictText) => {
            this.debug('Sending merge conflicts to agent for resolution');
            const conflictPrompt = buildConflictPrompt(designDocPath, conflictText);
            await writeFile(designDocPath, conflictText, 'utf-8');
            const resolveResult = await this.agentRunner.run(
              conflictPrompt, result.sessionId, runOpts,
            );
            if (resolveResult.exitCode !== 0) {
              this.debug('Conflict resolution failed; using conflict markers as-is');
              return conflictText;
            }
            return await readFile(designDocPath, 'utf-8');
          },
        );
        if (diffResult.hasChanges) {
          this.debug(`Applying ${diffResult.requests.length} doc operations (${diffResult.conflictsResolved} conflicts resolved)`);
          await this.client.batchUpdate(documentId, diffResult.requests);
          docEditCount = diffResult.requests.length;
          conflictsResolved = diffResult.conflictsResolved;
          if (this.forkMode) {
            this.sessionStore.upsertSession(agentName, baseKey, result.sessionId);
          }
        }
      } else {
        this.debug('Design doc unchanged');
      }

      // 4. Compose reply and summary.
      const agentResponse = result.stdout.trim();
      const docChanged = docEditCount > 0;
      if (codeChangesMade || docChanged) {
        replyContent = agentResponse || 'Done \u2014 changes applied.';
      } else {
        replyContent = agentResponse || 'Done \u2014 no changes needed.';
      }
      if (prUrl && codeChangesMade) {
        replyContent += `\n\nDraft PR: ${prUrl}`;
      }

      const summaryParts: string[] = [];
      if (prUrl && codeChangesMade) summaryParts.push(`PR ${prUrl}`);
      else if (codeChangesMade) summaryParts.push('Committed');
      if (docChanged) {
        const editText = `${docEditCount} doc edit${docEditCount !== 1 ? 's' : ''}`;
        const conflictText = conflictsResolved > 0
          ? `, ${conflictsResolved} conflict${conflictsResolved !== 1 ? 's' : ''} resolved`
          : '';
        summaryParts.push(editText + conflictText);
      }
      editSummary = summaryParts.length ? summaryParts.join(', ') : 'No changes';

      // 5. If we spun up a fresh worktree that produced nothing, tear it down.
      if (createdNewWorktree && !codeChangesMade) {
        this.debug('[processComment] Tearing down empty worktree');
        try { await removeWorktree(this.repoRoot, worktreePath); } catch { /* ignore */ }
      }
    } catch (err: any) {
      this.debug(`Error during processing: ${err.message ?? err}`);
      replyContent = replyContent || `Error: ${err.message ?? 'unknown error'}`;
      throw err;
    } finally {
      await this.replaceThinkingReply(documentId, comment.id, thinkingReplyId, replyContent);
      // In pr mode the design-doc files live inside the worktree (next run
      // overwrites them, or they're gone with the torn-down worktree). In
      // direct/off mode they share cwd with other runs, so clean up.
      if (codeMode !== 'pr') {
        await cleanupTempFiles(designDocPath, baseDocPath, chatMarkerPath);
      }
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
          await this.postContentReply(documentId, commentId, replyContent);
          this.debug(`Posted final reply`);
        } catch (replyErr: any) {
          this.debug(`Failed to post final reply: ${replyErr.message ?? replyErr}`);
        }
      }
    } else if (commentId && replyContent) {
      try {
        await this.postContentReply(documentId, commentId, replyContent);
        this.debug(`Reply created (no thinking reply to update)`);
      } catch (err: any) {
        this.debug(`Reply failed: ${err.message ?? err}`);
      }
    }
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
        await this.postContentReply(documentId, comment.id, replyContent);
      } catch (err) {
        this.debug(`[forkToChat] Failed to post redirect reply: ${err}`);
      }
    }

    this.debug(`[forkToChat] Done — tab ${tabId}, chat ${chatTabId}`);
    return { replyPreview: replyContent, editSummary: `Chat tab created: ${title}` };
  }
}
