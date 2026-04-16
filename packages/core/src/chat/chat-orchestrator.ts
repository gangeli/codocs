/**
 * Chat orchestrator — handles the chat message processing loop.
 *
 * Flow: comment reply on chat tab → extract message → run agent →
 * append response to tab → apply doc edits → place new input comment.
 */

import { readFile } from 'node:fs/promises';
import type { CodocsClient } from '../client/index.js';
import type { CommentEvent } from '../types.js';
import type { AgentRunner, PermissionMode } from '../harness/agent.js';
import type { SessionStore } from '../harness/types.js';
import type { ChatTabStore, ChatTab } from '@codocs/db';
import { ChatTabManager } from './chat-tab-manager.js';
import { buildChatPrompt } from './chat-prompt.js';
import { writeTempContext, cleanupTempFiles } from '../harness/context.js';
import { docsToMarkdown } from '../converter/docs-to-md.js';
import { docsToMarkdownWithMapping } from '../converter/docs-to-md.js';
import { computeDocDiff } from '../harness/diff.js';
import { buildConflictPrompt } from '../harness/prompt.js';

export interface ChatOrchestratorConfig {
  client: CodocsClient;
  replyClient?: CodocsClient;
  sessionStore: SessionStore;
  chatTabStore: ChatTabStore;
  chatTabManager: ChatTabManager;
  agentRunner: AgentRunner;
  permissionMode?: PermissionMode | (() => PermissionMode);
  model?: string | (() => string | undefined);
  harnessSettings?: Record<string, string> | (() => Record<string, string>);
  debug?: (msg: string) => void;
}

export class ChatOrchestrator {
  private client: CodocsClient;
  private replyClient: CodocsClient;
  private sessionStore: SessionStore;
  private chatTabStore: ChatTabStore;
  private chatTabManager: ChatTabManager;
  private agentRunner: AgentRunner;
  private getPermissionMode: () => PermissionMode;
  private getModel: () => string | undefined;
  private getHarnessSettings: () => Record<string, string>;
  private debug: (msg: string) => void;

  constructor(config: ChatOrchestratorConfig) {
    this.client = config.client;
    this.replyClient = config.replyClient ?? config.client;
    this.sessionStore = config.sessionStore;
    this.chatTabStore = config.chatTabStore;
    this.chatTabManager = config.chatTabManager;
    this.agentRunner = config.agentRunner;
    this.debug = config.debug ?? (() => {});

    const pm = config.permissionMode;
    this.getPermissionMode = typeof pm === 'function' ? pm : () => pm ?? { type: 'auto' };
    const m = config.model;
    this.getModel = typeof m === 'function' ? m : () => m;
    const hs = config.harnessSettings;
    this.getHarnessSettings = typeof hs === 'function' ? hs : () => hs ?? {};
  }

  /**
   * Handle a chat message received as a comment reply on a chat tab.
   *
   * 1. Extract user message from the comment event
   * 2. Append user message to chat tab
   * 3. Run the agent with full chat context
   * 4. Append agent response to chat tab
   * 5. Apply any document edits to the main tab
   * 6. Resolve old input comment, place new one
   */
  async handleChatMessage(
    chatTab: ChatTab,
    event: CommentEvent,
  ): Promise<{ replyPreview: string; editSummary: string }> {
    const { documentId, comment } = event;
    const agentName = chatTab.agentName;

    // Extract the user's message from the last thread reply
    const userMessage = this.extractUserMessage(event);
    if (!userMessage) {
      this.debug('[chat] No user message found in event');
      return { replyPreview: '', editSummary: 'No message' };
    }

    this.debug(`[chat] Message from user: "${userMessage.slice(0, 60)}"`);

    // Append user message to the chat tab
    await this.chatTabManager.appendMessage(
      documentId, chatTab.tabId, chatTab.id,
      'You', 'user', userMessage,
    );

    // Post thinking emoji on the comment thread
    let thinkingReplyId: string | null = null;
    if (comment.id) {
      try {
        thinkingReplyId = await this.replyClient.replyToComment(
          documentId, comment.id, '\u{1F914}',
        );
      } catch (err) {
        this.debug(`[chat] Failed to post thinking reply: ${err}`);
      }
    }

    // Snapshot the main document for the agent
    const mainDoc = await this.client.getDocument(documentId);
    const baseMarkdown = docsToMarkdown(mainDoc);
    const { editPath, basePath } = await writeTempContext(baseMarkdown, documentId, agentName);

    let replyContent = '';
    let editSummary = 'No changes';

    try {
      // Build chat prompt with full history
      const messages = this.chatTabManager.readChatHistory(chatTab.id);
      const prompt = buildChatPrompt({
        agentName,
        documentId,
        messages,
        documentMarkdown: baseMarkdown,
        newMessage: userMessage,
        mdFilePath: editPath,
      });

      // Look up or create session (keyed by chat tab)
      const sessionKey = `${documentId}:chat:${chatTab.tabId}`;
      const session = this.sessionStore.getSession(agentName, sessionKey);
      const existingSessionId = session?.sessionId ?? null;

      const runOpts = {
        workingDirectory: undefined,
        agentName,
        permissionMode: this.getPermissionMode(),
        model: this.getModel(),
        harnessSettings: this.getHarnessSettings(),
      };

      // Run the agent
      this.debug(`[chat] Running agent (session: ${existingSessionId ?? 'new'})`);
      let result = await this.agentRunner.run(prompt, existingSessionId, runOpts);

      // Handle session resume failure
      if (result.exitCode !== 0 && existingSessionId) {
        this.debug('[chat] Session resume failed, retrying fresh');
        this.sessionStore.deleteSession(agentName, sessionKey);
        result = await this.agentRunner.run(prompt, null, runOpts);
      }

      this.sessionStore.upsertSession(agentName, sessionKey, result.sessionId);

      // Get agent's response
      const agentResponse = result.stdout.trim();
      replyContent = agentResponse || 'Done.';

      // Append agent response to chat tab
      await this.chatTabManager.appendMessage(
        documentId, chatTab.tabId, chatTab.id,
        agentName, 'agent', replyContent,
      );

      // Check if the agent modified the document file
      const editedMarkdown = await readFile(editPath, 'utf-8');
      const base = await readFile(basePath, 'utf-8');

      if (editedMarkdown !== base) {
        this.debug(`[chat] Agent modified document: ${base.length} → ${editedMarkdown.length} chars`);

        // Fetch current doc state for 3-way merge
        const currentDoc = await this.client.getDocument(documentId);
        const { markdown: theirs, indexMap } = docsToMarkdownWithMapping(currentDoc);

        const diffResult = await computeDocDiff(
          base,
          editedMarkdown,
          theirs,
          currentDoc,
          indexMap,
          agentName,
          async (conflictText) => {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(editPath, conflictText, 'utf-8');
            const conflictPrompt = buildConflictPrompt(editPath, conflictText);
            const resolveResult = await this.agentRunner.run(
              conflictPrompt, result.sessionId, runOpts,
            );
            if (resolveResult.exitCode !== 0) return conflictText;
            return await readFile(editPath, 'utf-8');
          },
        );

        if (diffResult.hasChanges) {
          await this.client.batchUpdate(documentId, diffResult.requests);
          editSummary = `${diffResult.requests.length} edit${diffResult.requests.length !== 1 ? 's' : ''}`;
          this.debug(`[chat] Applied ${diffResult.requests.length} doc edits`);
        }
      }
    } catch (err: any) {
      this.debug(`[chat] Error: ${err.message ?? err}`);
      replyContent = replyContent || `Error: ${err.message ?? 'unknown error'}`;
      throw err;
    } finally {
      // Clean up thinking reply
      if (comment.id && thinkingReplyId) {
        try {
          await this.replyClient.deleteReply(documentId, comment.id, thinkingReplyId);
        } catch { /* best-effort */ }
      }

      // Resolve the old input comment and place a new one
      if (comment.id) {
        try {
          await this.client.resolveComment(documentId, comment.id);
        } catch { /* best-effort */ }
      }
      try {
        await this.chatTabManager.placeInputComment(documentId, chatTab.id);
      } catch (err) {
        this.debug(`[chat] Failed to place new input comment: ${err}`);
      }

      await cleanupTempFiles(editPath, basePath);
    }

    return { replyPreview: replyContent, editSummary };
  }

  /**
   * Extract the user's message from a comment event.
   * The message is the last reply in the thread (which triggered the event).
   */
  private extractUserMessage(event: CommentEvent): string | null {
    // If there's a thread, the last entry is the triggering message
    if (event.thread && event.thread.length > 0) {
      const last = event.thread[event.thread.length - 1];
      return last.content ?? null;
    }
    // Fall back to the comment content itself
    return event.comment.content ?? null;
  }
}
