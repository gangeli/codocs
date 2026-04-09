/**
 * Agent orchestrator — coordinates comment handling end-to-end.
 *
 * Flow: comment event → agent assignment → session lookup/create →
 * run agent → 3-way merge → apply changes to Google Doc.
 */

import { readFile } from 'node:fs/promises';
import type { CodocsClient } from '../client/index.js';
import type { CommentEvent } from '../types.js';
import type { SessionStore } from './types.js';
import type { AgentRunner } from './agent.js';
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
  /** Optional logger. */
  debug?: (msg: string) => void;
}

export class AgentOrchestrator {
  private client: CodocsClient;
  private replyClient: CodocsClient;
  private sessionStore: SessionStore;
  private agentRunner: AgentRunner;
  private fallbackAgent: string | ((documentId: string) => string);
  private onAgentAssigned: (agentName: string, task: string) => void;
  private debug: (msg: string) => void;

  constructor(config: OrchestratorConfig) {
    this.client = config.client;
    this.replyClient = config.replyClient ?? config.client;
    this.sessionStore = config.sessionStore;
    this.agentRunner = config.agentRunner;
    this.fallbackAgent = config.fallbackAgent;
    this.onAgentAssigned = config.onAgentAssigned ?? (() => {});
    this.debug = config.debug ?? (() => {});
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
   * Handle a single comment event end-to-end.
   */
  async handleComment(event: CommentEvent): Promise<{
    agentName: string;
    replyPreview: string;
    editSummary: string;
  }> {
    const { documentId, comment } = event;
    const quotedText = comment.quotedText ?? '';
    const commentText = comment.content ?? '';

    if (!commentText) {
      this.debug('Skipping comment with no content');
      return { agentName: '', replyPreview: '', editSummary: 'No content' };
    }

    this.debug(`Handling comment on doc ${documentId}: "${commentText}"`);

    // Step 1: Fetch document and attributions
    const document = await this.client.getDocument(documentId);
    const attributions = await this.client.getAttributions(documentId);

    // Step 2: Assign agent
    const agentName = assignAgent(quotedText, attributions, document, {
      fallbackAgent: this.resolveFallbackAgent(documentId),
    });
    this.debug(`Assigned to agent: ${agentName}`);
    this.onAgentAssigned(agentName, commentText.slice(0, 60));

    // Step 3: Post a thinking reply so the user knows the agent picked it up
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

    // Step 4: Snapshot the document as markdown (the "base" for 3-way merge)
    const baseMarkdown = docsToMarkdown(document);

    // Step 4: Write temp files in a dedicated workspace directory
    const { editPath, basePath } = await writeTempContext(baseMarkdown, documentId, agentName);
    this.debug(`Edit file: ${editPath}`);

    try {
      // Step 5: Build prompt
      const prompt = buildPrompt({
        mdFilePath: editPath,
        commentText,
        quotedText,
        agentName,
        documentId,
      });

      // Step 6: Look up or create session
      let session = this.sessionStore.getSession(agentName, documentId);
      const existingSessionId = session?.sessionId ?? null;
      this.debug(
        existingSessionId
          ? `Resuming session: ${existingSessionId}`
          : 'Creating new session',
      );

      // Step 7: Run the agent
      let result = await this.agentRunner.run(prompt, existingSessionId, {
        workingDirectory: undefined,
        agentName,
      });

      // Handle session resume failure — retry with fresh session
      if (result.exitCode !== 0 && existingSessionId) {
        this.debug(
          `Session resume failed (exit ${result.exitCode}), retrying with fresh session`,
        );
        this.sessionStore.deleteSession(agentName, documentId);
        result = await this.agentRunner.run(prompt, null, {
          workingDirectory: undefined,
          agentName,
        });
      }

      // Step 8: Store session mapping
      this.sessionStore.upsertSession(agentName, documentId, result.sessionId);

      // Step 9: Read the agent's edited file
      const editedMarkdown = await readFile(editPath, 'utf-8');

      // Step 10: Fetch current document state (may have changed during agent run)
      const currentDoc = await this.client.getDocument(documentId);
      const { markdown: theirs, indexMap } = docsToMarkdownWithMapping(currentDoc);

      // Step 11: 3-way merge and compute doc operations
      const base = await readFile(basePath, 'utf-8');
      const diffResult = await computeDocDiff(
        base,
        editedMarkdown,
        theirs,
        currentDoc,
        indexMap,
        agentName,
        async (conflictText) => {
          // Send conflicts back to agent for resolution
          this.debug('Sending merge conflicts to agent for resolution');
          const conflictPrompt = buildConflictPrompt(editPath, conflictText);

          // Write conflict text to the edit file for the agent
          const { writeFile } = await import('node:fs/promises');
          await writeFile(editPath, conflictText, 'utf-8');

          const resolveResult = await this.agentRunner.run(
            conflictPrompt,
            result.sessionId,
            { workingDirectory: undefined, agentName },
          );

          if (resolveResult.exitCode !== 0) {
            this.debug('Conflict resolution failed, using conflict markers as-is');
            return conflictText;
          }

          return await readFile(editPath, 'utf-8');
        },
      );

      // Step 12: Apply changes to Google Doc
      if (diffResult.hasChanges) {
        this.debug(
          `Applying ${diffResult.requests.length} doc operations (${diffResult.conflictsResolved} conflicts resolved)`,
        );
        await this.client.batchUpdate(documentId, diffResult.requests);
      } else {
        this.debug('No changes to apply');
      }

      // Step 13: Update the thinking reply with the agent's actual response
      const agentResponse = result.stdout.trim();
      const replyContent = agentResponse
        || (diffResult.hasChanges ? 'Done \u2014 changes applied to the document.' : 'Done \u2014 no changes needed.');

      if (comment.id) {
        try {
          if (thinkingReplyId) {
            await this.replyClient.updateReply(documentId, comment.id, thinkingReplyId, replyContent);
            this.debug('Updated thinking reply with response');
          } else {
            await this.replyClient.replyToComment(documentId, comment.id, replyContent);
            this.debug('Replied to comment');
          }
        } catch (err) {
          this.debug(`Failed to reply to comment: ${err}`);
        }
      }

      // Build edit summary
      const editSummary = diffResult.hasChanges
        ? `${diffResult.requests.length} edit${diffResult.requests.length !== 1 ? 's' : ''}${diffResult.conflictsResolved ? `, ${diffResult.conflictsResolved} conflict${diffResult.conflictsResolved !== 1 ? 's' : ''} resolved` : ''}`
        : 'No changes';

      return {
        agentName,
        replyPreview: replyContent,
        editSummary,
      };
    } finally {
      // Step 14: Cleanup
      await cleanupTempFiles(editPath, basePath);
    }
  }
}
