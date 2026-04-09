/**
 * Manage comments on Google Docs via the Drive API.
 */

import type { DriveApi } from '../client/drive-api.js';
import type { CommentInput, DocComment, AgentIdentity } from '../types.js';

/**
 * Build the comment content string, prefixed with agent name if provided.
 */
function formatCommentContent(content: string, agent?: AgentIdentity): string {
  if (agent) {
    return `[${agent.name}]: ${content}`;
  }
  return content;
}

/**
 * Build the anchor JSON for positioning a comment on quoted text.
 * Uses the undocumented but widely-used Drive API anchor format.
 */
function buildAnchor(quotedText: string): string {
  return JSON.stringify({
    r: 0,
    a: [{ txt: quotedText }],
  });
}

/**
 * Add a comment to a document.
 */
export async function addComment(
  driveApi: DriveApi,
  fileId: string,
  input: CommentInput,
): Promise<string> {
  const content = formatCommentContent(input.content, input.agent);
  const anchor = input.quotedText ? buildAnchor(input.quotedText) : undefined;
  return driveApi.createComment(fileId, content, anchor);
}

/**
 * List all comments on a document.
 */
export async function listComments(
  driveApi: DriveApi,
  fileId: string,
): Promise<DocComment[]> {
  const raw = await driveApi.listComments(fileId);
  return raw.map((c) => ({
    id: c.id ?? '',
    content: c.content ?? '',
    author: c.author?.displayName ?? 'Unknown',
    quotedText: c.quotedFileContent?.value,
    resolved: c.resolved ?? false,
    createdTime: c.createdTime ?? '',
  }));
}

/**
 * Resolve a comment.
 */
export async function resolveComment(
  driveApi: DriveApi,
  fileId: string,
  commentId: string,
): Promise<void> {
  return driveApi.resolveComment(fileId, commentId);
}
