/**
 * Prompt construction for agent tasks.
 */

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
}

/**
 * Build the prompt string to send to a coding agent.
 */
export function buildPrompt(ctx: PromptContext): string {
  return `You are agent "${ctx.agentName}" working on a Google Doc (ID: ${ctx.documentId}).

A user left a comment on the document:
> ${ctx.commentText}

The comment was placed on this highlighted text:
> ${ctx.quotedText}

The full document is at: ${ctx.mdFilePath}
The highlighted text can be found by searching for the quoted text above in that file.

Please edit ${ctx.mdFilePath} to address the comment. Focus your changes on the section related to the highlighted text. Keep unrelated sections unchanged.

When you're done editing, briefly explain what you changed.`;
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
