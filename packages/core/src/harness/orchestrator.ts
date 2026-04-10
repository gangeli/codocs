/**
 * Agent orchestrator — coordinates comment handling end-to-end.
 *
 * Flow: comment event → agent assignment → enqueue → drain (serialize per agent) →
 * session lookup/create → run agent → 3-way merge → apply changes to Google Doc.
 */

import { readFile } from 'node:fs/promises';
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
  /** Called when an agent is assigned to handle a comment, before processing starts. */
  onAgentAssigned?: (agentName: string, task: string) => void;
  /** Called when a comment has been fully processed (agent ran, reply posted). */
  onCommentProcessed?: (result: { agentName: string; replyPreview: string; editSummary: string }) => void;
  /** Called when processing a comment fails. */
  onCommentFailed?: (agentName: string, error: string) => void;
  /** How tool permissions are handled for agent processes. Called per-invocation to support runtime changes. */
  permissionMode?: PermissionMode | (() => PermissionMode);
  /** Optional logger. */
  debug?: (msg: string) => void;
}

export class AgentOrchestrator {
  private client: CodocsClient;
  private replyClient: CodocsClient;
  private sessionStore: SessionStore;
  private queueStore: QueueStore;
  private agentRunner: AgentRunner;
  private fallbackAgent: string | ((documentId: string) => string);
  private onAgentAssigned: (agentName: string, task: string) => void;
  private onCommentProcessed: (result: { agentName: string; replyPreview: string; editSummary: string }) => void;
  private onCommentFailed: (agentName: string, error: string) => void;
  private debug: (msg: string) => void;
  private getPermissionMode: () => PermissionMode;

  /** Agents currently being drained. Prevents double-drain. */
  private processingAgents = new Set<string>();
  /** Active drain promises, keyed by agent name. */
  private drainPromises = new Map<string, Promise<void>>();

  constructor(config: OrchestratorConfig) {
    this.client = config.client;
    this.replyClient = config.replyClient ?? config.client;
    this.sessionStore = config.sessionStore;
    this.queueStore = config.queueStore;
    this.agentRunner = config.agentRunner;
    this.fallbackAgent = config.fallbackAgent;
    this.onAgentAssigned = config.onAgentAssigned ?? (() => {});
    this.onCommentProcessed = config.onCommentProcessed ?? (() => {});
    this.onCommentFailed = config.onCommentFailed ?? (() => {});
    this.debug = config.debug ?? (() => {});

    const pm = config.permissionMode;
    this.getPermissionMode = typeof pm === 'function' ? pm : () => pm ?? { type: 'auto' };
  }

  /** Resolve the fallback agent name for a given document. */
  private resolveFallbackAgent(documentId: string): string {
    return typeof this.fallbackAgent === 'function'
      ? this.fallbackAgent(documentId)
      : this.fallbackAgent;
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
      this.drainQueue(agentName).catch((err) => {
        this.debug(`Recovery drain error for ${agentName}: ${err}`);
      });
    }
  }

  /**
   * Process a single comment event end-to-end.
   * The agent has already been assigned; this does the actual work.
   */
  private async processComment(event: CommentEvent, agentName: string): Promise<{ replyPreview: string; editSummary: string }> {
    const { documentId, comment } = event;
    const quotedText = comment.quotedText ?? '';
    const commentText = comment.content ?? '';

    this.debug(`[processComment] Starting for ${agentName}: "${commentText.slice(0, 40)}"`);
    this.onAgentAssigned(agentName, commentText.slice(0, 60));

    // Post a thinking reply so the user knows the agent picked it up
    let thinkingReplyId: string | null = null;
    if (comment.id) {
      try {
        thinkingReplyId = await this.replyClient.replyToComment(
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
      // Build prompt (include thread history for replies)
      const prompt = buildPrompt({
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
      this.debug(`[processComment] Finally block — replacing thinking reply (thinkingReplyId: ${thinkingReplyId}, replyContent: ${replyContent.length} chars)`);
      // Replace the thinking emoji with the actual response.
      //
      // We use delete + create instead of updateReply because Google Docs
      // does not live-refresh the comment sidebar when a reply is updated
      // via the API (drive.replies.update). The API call succeeds and
      // subsequent reads return the updated content, but the Docs UI won't
      // show the change until the user manually reloads the page. Creating
      // a new reply triggers a UI notification and renders immediately.
      //
      // No public bug tracker link found for this as of April 2026.
      // If Google fixes this, switch back to updateReply for cleaner
      // thread history (no delete gap).
      if (comment.id && thinkingReplyId) {
        try {
          await this.replyClient.deleteReply(documentId, comment.id, thinkingReplyId);
          this.debug(`[processComment] Deleted thinking reply`);
        } catch (delErr: any) {
          this.debug(`[processComment] Failed to delete thinking reply (continuing): ${delErr.message ?? delErr}`);
        }
        try {
          await this.replyClient.replyToComment(documentId, comment.id, replyContent);
          this.debug(`[processComment] Posted final reply`);
        } catch (replyErr: any) {
          this.debug(`[processComment] Failed to post final reply: ${replyErr.message ?? replyErr}`);
        }
      } else if (comment.id && replyContent) {
        try {
          await this.replyClient.replyToComment(documentId, comment.id, replyContent);
          this.debug(`[processComment] Reply created (no thinking reply to update)`);
        } catch (err: any) {
          this.debug(`[processComment] Reply failed: ${err.message ?? err}`);
        }
      }

      await cleanupTempFiles(editPath, basePath);
      this.debug(`[processComment] Done`);
    }

    return { replyPreview: replyContent, editSummary };
  }
}
