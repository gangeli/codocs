/**
 * Prompt construction for agent tasks.
 *
 * A single unified prompt covers three possible outcomes — doc edit, code
 * change, chat escalation — without asking the agent to classify up front.
 * The orchestrator detects which happened from side effects after the run.
 */

import type { ThreadMessage } from '../types.js';

export interface PromptContext {
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
  /** Working directory the agent will run in. Worktree when code is enabled; scratch dir when codeMode='off'. */
  workingDirectory: string;
  /** Absolute path to the design doc snapshot the agent can edit. */
  designDocPath: string;
  /** Path for the chat-escalation marker file. Relative to workingDirectory. */
  chatMarkerPath: string;
  /** When code modifications are permitted (worktree available). */
  codeEnabled: boolean;
  /** If this is a follow-up on an existing draft PR (only set when codeEnabled). */
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

export function buildPrompt(ctx: PromptContext): string {
  const threadSection = ctx.thread && ctx.thread.length > 1
    ? `This is a reply in an ongoing conversation. Full thread:\n\n${formatThread(ctx.thread)}\n\nThe latest message (respond to this):\n> ${ctx.commentText}`
    : `A user left this comment on the document:\n> ${ctx.commentText}`;

  const quoteSection = ctx.quotedText
    ? `\n\nThe comment was placed on this highlighted text:\n> ${ctx.quotedText}`
    : '';

  const prSection = ctx.existingPR
    ? `\n\nThis thread already has a draft PR open: #${ctx.existingPR.number} (${ctx.existingPR.url}). Previous changes are on the branch; build on top of them.`
    : '';

  const codeSection = ctx.codeEnabled
    ? `
### When the comment asks the software to behave differently

Modify source files in the working directory. This covers bug fixes, new features, behavior changes, refactors, and new components — regardless of whether the user phrased the request in implementation terms ("modify file X") or product terms ("when the build fails, show a banner"). If the request would require new code to produce the information or behavior it describes, it's a code change. The system will commit, push, and open a draft PR after you finish.

Do NOT create commits yourself. Do NOT push. Do NOT delete or move files outside what the comment asks for.
`
    : `
### Code changes are disabled for this run

You cannot modify source files. If the comment asks for software behavior changes, reply explaining that code modifications are not enabled and describe what would need to change.
`;

  return `You are agent "${ctx.agentName}" responding to a comment on a shared Google Doc. The doc is the project's design doc — a high-level description of the software that collaborators critique and evolve through comments.

${threadSection}${quoteSection}${prSection}

Your working directory is: ${ctx.workingDirectory}

The current state of the design doc is in this markdown file: ${ctx.designDocPath}
${codeSection}
## How to respond

The comment might ask for a documentation change, a software change, both, or neither. Do whatever the comment actually calls for — you don't need to announce which kind it is. The system detects what you did from what changed on disk.

### When the comment is about the document's content

Edit ${ctx.designDocPath} directly with the Edit or Write tool. This covers rewording, restructuring, fixing inaccuracies about *existing* behavior, or trimming stale content. Reading the file and describing the change is not enough — actually write the change. Changes to this file will be merged back into the Google Doc.

Do NOT use doc edits to describe features or behaviors that don't yet exist in the code. If the comment asks for the doc to describe new behavior, that behavior needs to be built first (a code change), and the doc update should reflect what the code does after the change.
${ctx.codeEnabled ? `
### When the comment asks for both

Do both in this run. Modify source files AND update ${ctx.designDocPath} to reflect the new behavior. The PR and the doc update happen together.
` : ''}
### When the comment is just a question or discussion

Answer in your text output and change nothing on disk.

### When the comment opens a genuinely multi-turn discussion

If the comment is clearly a "let's discuss…", brainstorming, or open-ended design exploration — with no concrete change being requested — escalate to a chat tab by writing a JSON file to ${ctx.chatMarkerPath} with this exact shape:

\`\`\`json
{"title": "<short topic, ~40 chars>"}
\`\`\`

Then stop. Don't also edit the doc or change code in the same run.

## Watch out for

A comment phrased like "add a section about X to the doc" is a code change when X is information the software doesn't currently produce (e.g., "note build failures at the top of the doc" — that's a feature, not a doc edit). Adding a paragraph that describes a feature does not build the feature.

## Reply format

Write a brief summary of what you did as your text output. It will be posted as a reply on the Google Doc comment. Keep it concise and avoid formatting that renders poorly in a plain comment (tables, large code blocks). Don't narrate that you're replying to a comment or editing the doc — the viewer sees both the comment and the resulting changes.

For architecture diagrams, data flows, or relationships inside the design doc, use mermaid fenced blocks (\`\`\`mermaid). They render as images in the Google Doc. Prefer mermaid over ASCII art.
`;
}

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
