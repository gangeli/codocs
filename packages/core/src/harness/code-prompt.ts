/**
 * Prompt construction for code modification tasks.
 *
 * Unlike the doc-mode prompt which asks the agent to edit a markdown file,
 * this prompt instructs the agent to make code changes in a git worktree
 * (or directly in the repo root).
 */

import type { ThreadMessage } from '../types.js';

export interface CodePromptContext {
  /** The agent name being addressed. */
  agentName: string;
  /** The comment text (the user's instruction). */
  commentText: string;
  /** The quoted/highlighted text from the document. */
  quotedText: string;
  /** Google Doc ID for reference. */
  documentId: string;
  /** Thread history (when this is a reply to an existing conversation). */
  thread?: ThreadMessage[];
  /** The working directory where the agent will run (worktree or repo root). */
  workingDirectory: string;
  /** If this is a follow-up on an existing PR. */
  existingPR?: {
    number: number;
    url: string;
  };
}

function formatThread(thread: ThreadMessage[]): string {
  return thread
    .map((msg) => `**${msg.author ?? 'Unknown'}**: ${msg.content ?? '(empty)'}`)
    .join('\n');
}

/**
 * Build the prompt for a code modification task.
 */
export function buildCodePrompt(ctx: CodePromptContext): string {
  const threadSection = ctx.thread && ctx.thread.length > 1
    ? `\nThis is a reply in an ongoing conversation. Here is the full thread:\n\n${formatThread(ctx.thread)}\n\nThe latest message (which you should respond to) is:\n> ${ctx.commentText}\n`
    : `\nA user left a comment on a shared Google Doc requesting a code change:\n> ${ctx.commentText}\n`;

  const quoteSection = ctx.quotedText
    ? `\nThe comment was placed on this highlighted text in the document:\n> ${ctx.quotedText}\n`
    : '';

  const prSection = ctx.existingPR
    ? `\nThis is a follow-up on an existing draft PR #${ctx.existingPR.number} (${ctx.existingPR.url}).
Previous changes are already on the branch. Build on top of them.\n`
    : '';

  return `You are agent "${ctx.agentName}" making code changes requested via a Google Doc comment.
${threadSection}${quoteSection}${prSection}
Your working directory is: ${ctx.workingDirectory}

Make the requested code changes. You have full access to the codebase.

Guidelines:
- Make focused, minimal changes that address the request
- Do NOT create git commits — the system handles commits after you finish
- Do NOT push to any remote

Write a brief summary of what you changed as your text output. This will be posted as a reply to the Google Doc comment, so keep it concise and avoid formatting that doesn't render well in a plain comment (e.g., tables, code blocks).
`;
}
