/**
 * Routes incoming comment events to either the main doc flow or a chat tab.
 *
 * Drive API comments are per-document, not per-tab. This module uses a
 * multi-strategy approach to determine if a comment belongs to a chat tab:
 *
 * 1. Active comment ID match (fastest, most reliable)
 * 2. Anchor text marker match
 * 3. Content + position matching (fallback for edge cases)
 */

import type { CommentEvent } from '../types.js';
import type { CodocsClient } from '../client/index.js';
import type { ChatTabStore, ChatTab } from '@codocs/db';
import { CHAT_INPUT_ANCHOR, CHAT_COMMENT_PREFIX } from './chat-tab-manager.js';
import { getTabBody } from '../converter/docs-to-md.js';

export type RouteResult =
  | { type: 'chat'; chatTab: ChatTab }
  | { type: 'doc' };

/**
 * Determine if a comment event belongs to a chat tab or the main document.
 *
 * Uses a layered routing strategy:
 * 1. Check if the comment ID matches any chat tab's active input comment
 * 2. Check if the quotedText contains the chat input anchor marker
 * 3. Check if the comment text starts with the chat comment prefix
 * 4. Fall back to content matching across active chat tabs
 */
export async function routeComment(
  event: CommentEvent,
  chatTabStore: ChatTabStore,
  client: CodocsClient,
): Promise<RouteResult> {
  const { documentId, comment } = event;
  const commentId = comment.id;
  const quotedText = comment.quotedText ?? '';

  // Strategy 1: Active comment ID match
  // When a user replies to the input comment we placed, the comment ID
  // in the event is the parent comment's ID — which is our active_comment_id.
  if (commentId) {
    const chatTab = chatTabStore.getByActiveComment(commentId);
    if (chatTab) {
      return { type: 'chat', chatTab };
    }
  }

  // Strategy 2: Anchor text match
  // The input comment is anchored to CHAT_INPUT_ANCHOR. If the quotedText
  // matches, this is definitely a chat tab comment.
  if (quotedText.includes(CHAT_INPUT_ANCHOR)) {
    const chatTabs = chatTabStore.getActiveByDocument(documentId);
    if (chatTabs.length === 1) {
      return { type: 'chat', chatTab: chatTabs[0] };
    }
    // Multiple chat tabs — need to disambiguate
    if (chatTabs.length > 1) {
      const match = await matchByContent(documentId, quotedText, chatTabs, client);
      if (match) return { type: 'chat', chatTab: match };
    }
  }

  // Strategy 3: Comment prefix match
  // Comments placed by Codocs on chat tabs are prefixed with [Chat].
  const commentText = comment.content ?? '';
  if (commentText.startsWith(CHAT_COMMENT_PREFIX)) {
    const chatTabs = chatTabStore.getActiveByDocument(documentId);
    if (chatTabs.length === 1) {
      return { type: 'chat', chatTab: chatTabs[0] };
    }
  }

  // Strategy 4: Content matching across tabs (fallback)
  // If the quotedText is non-empty and non-trivial, check if it appears
  // in any chat tab's content rather than the main document.
  if (quotedText.length > 0) {
    const chatTabs = chatTabStore.getActiveByDocument(documentId);
    if (chatTabs.length > 0) {
      const match = await matchByContent(documentId, quotedText, chatTabs, client);
      if (match) return { type: 'chat', chatTab: match };
    }
  }

  return { type: 'doc' };
}

/**
 * Match a quotedText to a specific chat tab by checking if the text
 * exists in the tab's content. Uses positional matching to disambiguate
 * when the same text appears in multiple locations.
 *
 * Returns null if no match or if the text is ambiguous (appears in
 * multiple tabs or in both a tab and the main doc).
 */
async function matchByContent(
  documentId: string,
  quotedText: string,
  chatTabs: ChatTab[],
  client: CodocsClient,
): Promise<ChatTab | null> {
  // Skip matching for empty or very short quoted text — too ambiguous
  if (quotedText.trim().length < 3) return null;

  try {
    const doc = await client.getDocumentWithTabs(documentId);

    // Check each chat tab's content
    const matches: ChatTab[] = [];
    for (const tab of chatTabs) {
      const tabBody = getTabBody(doc, tab.tabId);
      if (!tabBody?.content) continue;

      if (bodyContainsText(tabBody, quotedText)) {
        matches.push(tab);
      }
    }

    if (matches.length === 1) {
      return matches[0];
    }

    // Multiple matches or no matches — ambiguous, don't route to chat
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a document body contains the given text.
 */
function bodyContainsText(
  body: import('googleapis').docs_v1.Schema$Body,
  text: string,
): boolean {
  for (const element of body.content ?? []) {
    if (!element.paragraph?.elements) continue;
    const paragraphText = element.paragraph.elements
      .map((el) => el.textRun?.content ?? '')
      .join('');
    if (paragraphText.includes(text)) return true;
  }
  return false;
}
