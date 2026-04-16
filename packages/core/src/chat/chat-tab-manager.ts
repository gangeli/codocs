/**
 * Manages chat tab lifecycle: creation, message rendering, and input comment placement.
 */

import type { CodocsClient } from '../client/index.js';
import type { ChatTabStore, ChatMessage } from '@codocs/db';

/** Marker text used as the anchor for the input comment. */
export const CHAT_INPUT_ANCHOR = '\u{1F4AC} Reply to this comment to send a message';

/** Prefix used in input comments to identify them as chat input prompts. */
export const CHAT_COMMENT_PREFIX = '[Chat]';

export interface SeedContext {
  /** The original comment text that triggered the fork. */
  commentText: string;
  /** The highlighted text the comment was placed on. */
  quotedText?: string;
  /** Full thread history from the source comment. */
  threadHistory?: Array<{ author?: string; content?: string }>;
}

export class ChatTabManager {
  constructor(
    private client: CodocsClient,
    private chatTabStore: ChatTabStore,
    private debug: (msg: string) => void = () => {},
  ) {}

  /**
   * Create a new chat tab in a document.
   *
   * 1. Creates a Google Docs tab via the API
   * 2. Writes initial content (header, context, input anchor)
   * 3. Places the first input comment on the anchor text
   * 4. Stores the chat tab in the database
   *
   * Returns the chat tab DB ID and the Google Docs tab ID.
   */
  async createChatTab(
    documentId: string,
    title: string,
    agentName: string,
    seed?: SeedContext,
    sourceCommentId?: string,
  ): Promise<{ chatTabId: number; tabId: string }> {
    // Create the tab
    const tabId = await this.client.createTab(documentId, `Chat: ${title}`);
    this.debug(`Created tab "${title}" with id ${tabId}`);

    // Build initial content
    const parts: string[] = [];
    parts.push(`# Chat: ${title}`);

    if (seed) {
      if (seed.quotedText) {
        parts.push(`> ${seed.quotedText}`);
      }
      if (seed.threadHistory && seed.threadHistory.length > 0) {
        parts.push('---');
        for (const msg of seed.threadHistory) {
          const author = msg.author ?? 'Unknown';
          parts.push(`**${author}:** ${msg.content ?? '(empty)'}`);
        }
      } else if (seed.commentText) {
        parts.push('---');
        parts.push(`**You:** ${seed.commentText}`);
      }
    }

    parts.push('---');
    parts.push(CHAT_INPUT_ANCHOR);

    const markdown = parts.join('\n\n');

    // Write initial content to the tab
    await this.client.writeTabMarkdown(documentId, tabId, markdown);
    this.debug(`Wrote initial content to tab ${tabId}`);

    // Store in database
    const chatTabId = this.chatTabStore.create({
      documentId,
      tabId,
      title,
      agentName,
      sourceCommentId,
    });

    // Store seed messages in chat history
    if (seed?.threadHistory) {
      for (const msg of seed.threadHistory) {
        const role = msg.author === agentName ? 'agent' : 'user';
        this.chatTabStore.addMessage(chatTabId, role, msg.content ?? '');
      }
    } else if (seed?.commentText) {
      this.chatTabStore.addMessage(chatTabId, 'user', seed.commentText);
    }

    // Place the input comment on the anchor text
    await this.placeInputComment(documentId, chatTabId);

    return { chatTabId, tabId };
  }

  /**
   * Append a message to the chat tab, rendered above the input anchor.
   *
   * The message is inserted just before the final separator + anchor text.
   */
  async appendMessage(
    documentId: string,
    tabId: string,
    chatTabId: number,
    author: string,
    role: ChatMessage['role'],
    content: string,
  ): Promise<void> {
    // Store in database
    this.chatTabStore.addMessage(chatTabId, role, content);

    // Read current tab content to find insertion point
    const doc = await this.client.getDocumentWithTabs(documentId);
    const { getTabBody } = await import('../converter/docs-to-md.js');
    const tabBody = getTabBody(doc, tabId);
    if (!tabBody?.content) return;

    // Find the anchor text paragraph to insert before it
    const anchorIndex = findAnchorIndex(tabBody, CHAT_INPUT_ANCHOR);
    if (anchorIndex === null) {
      this.debug(`Could not find anchor text in tab ${tabId}, appending to end`);
      return;
    }

    // Build the message markdown: "---\n\n**Author:** content"
    // We insert before the anchor's separator (---), so we need the separator
    // that precedes the anchor. Find the horizontal rule before the anchor.
    const prefix = role === 'agent' ? `**${author}:**` : '**You:**';
    const messageText = `${prefix} ${content}\n\n`;

    // Insert before the anchor paragraph
    const { injectTabId } = await import('../client/docs-api.js');
    const requests = injectTabId([{
      insertText: {
        text: messageText,
        location: { index: anchorIndex },
      },
    }], tabId);

    await this.client.batchUpdate(documentId, requests);
    this.debug(`Appended ${role} message to tab ${tabId}`);
  }

  /**
   * Place (or re-place) the input comment on the anchor text in a chat tab.
   *
   * The comment is anchored to CHAT_INPUT_ANCHOR and prefixed with
   * CHAT_COMMENT_PREFIX for routing identification.
   */
  async placeInputComment(
    documentId: string,
    chatTabId: number,
  ): Promise<string> {
    const commentId = await this.client.addComment(documentId, {
      content: `${CHAT_COMMENT_PREFIX} Type your reply to continue the conversation.`,
      quotedText: CHAT_INPUT_ANCHOR,
    });

    this.chatTabStore.updateActiveComment(chatTabId, commentId);
    this.debug(`Placed input comment ${commentId} on chat tab ${chatTabId}`);
    return commentId;
  }

  /**
   * Read the full chat history from the database for prompt building.
   */
  readChatHistory(chatTabId: number): ChatMessage[] {
    return this.chatTabStore.getMessages(chatTabId);
  }
}

/**
 * Find the document index of the chat input anchor text within a tab body.
 */
function findAnchorIndex(
  body: import('googleapis').docs_v1.Schema$Body,
  anchorText: string,
): number | null {
  for (const element of body.content ?? []) {
    if (!element.paragraph?.elements) continue;
    for (const el of element.paragraph.elements) {
      const text = el.textRun?.content ?? '';
      if (text.includes(anchorText)) {
        return element.startIndex ?? null;
      }
    }
  }
  return null;
}
