/**
 * Prompt construction for agent tasks.
 */

import type { ThreadMessage } from '../types.js';

export interface PromptContext {
  /** Path to the markdown file the agent should edit. */
  mdFilePath: string;
  /** The comment text (the user's instruction). */
  commentText: string;
  /** The quoted/highlighted text from the document. */
  quotedText: string;
  /** The agent name being addressed. */
  agentName: string;
  /** Google Doc ID for reference. */
  documentId: string;
  /** Thread history (when this is a reply to an existing conversation). */
  thread?: ThreadMessage[];
}

/**
 * Format a thread history into a readable conversation log.
 */
function formatThread(thread: ThreadMessage[]): string {
  return thread
    .map((msg) => `**${msg.author ?? 'Unknown'}**: ${msg.content ?? '(empty)'}`)
    .join('\n');
}

/**
 * Build the prompt string to send to a coding agent.
 */
export function buildPrompt(ctx: PromptContext): string {
  const threadSection = ctx.thread && ctx.thread.length > 1
    ? `\nThis is a reply in an ongoing conversation. Here is the full thread:\n\n${formatThread(ctx.thread)}\n\nThe latest message (which you should respond to) is:\n> ${ctx.commentText}\n`
    : `\nA user left a comment on the document:\n> ${ctx.commentText}\n`;

  return `You are agent "${ctx.agentName}" working on a shared Google Doc with other agents and with a human collaborator.
${threadSection}
The comment was placed on this highlighted text:
> ${ctx.quotedText}

The document content is in this markdown file: ${ctx.mdFilePath}

Use the Edit or Write tool to modify ${ctx.mdFilePath} if the comment asks for any changes, additions, or edits to the document. Reading the file and describing changes is NOT enough — you must actually write the changes to disk. The file will be diffed after you finish and changes will be applied back to the Google Doc.

After editing the file, write a brief summary of what you did. Your text output (stdout) will be posted as a reply to the user's comment on the Google Doc, so be brief and avoid formatting that doesn't show up well in a comment (e.g., tables)

If the comment is just a question that doesn't require document changes, you can respond with text only.

This is a shared overview document that all collaborators see. Keep it concise and up to date. Importantly, if you notice something out of date in the document with respect to the code you explored (whether you made the change or not), please update the relevant sections of the document to reflect the code.

Keep in mind:
* You don't need to mention that you're replying to a comment, or that you'll edit the doc, or this sort of thing. The viewer will see both the doc edits and the comment in the UI.
* For architecture diagrams, data flows, or relationships, use mermaid diagrams in fenced code blocks (\`\`\`mermaid). They render as images in the Google Doc. Prefer mermaid over ASCII art.
`;
}

/**
 * Build a follow-up prompt for conflict resolution.
 */
export function buildConflictPrompt(
  mdFilePath: string,
  conflictText: string,
): string {
  return `The document was edited by others while you were working. There are merge conflicts that need resolution.

The conflict markers are in: ${mdFilePath}

Conflicting content:
${conflictText}

Please edit ${mdFilePath} to resolve the conflicts. Remove all <<<<<<< / ======= / >>>>>>> markers and produce the correct merged text.`;
}
