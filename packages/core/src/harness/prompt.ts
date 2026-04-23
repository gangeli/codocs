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
  const isFollowup = !!(ctx.thread && ctx.thread.length > 1) || !!ctx.existingPR;

  const threadSection = ctx.thread && ctx.thread.length > 1
    ? `This is a reply in an ongoing thread. Full history:\n\n${formatThread(ctx.thread)}\n\nLatest message (respond to this):\n> ${ctx.commentText}`
    : `A user left this comment on the doc:\n> ${ctx.commentText}`;

  const quoteSection = ctx.quotedText
    ? `\n\nHighlighted text the comment is anchored to:\n> ${ctx.quotedText}`
    : '';

  const prSection = ctx.existingPR
    ? `\n\nThis thread already has draft PR #${ctx.existingPR.number} (${ctx.existingPR.url}) — build on top of the branch.`
    : '';

  const codeLine = ctx.codeEnabled
    ? `- **Code change** — any request for different software behavior (bug fix, feature, refactor), regardless of phrasing ("fix file X" or "when the build fails, show a banner"): edit the source files directly — create, modify, or remove files as the task requires. Don't run git yourself; the system commits, pushes, and opens a draft PR afterward.`
    : `- **Code change** — code edits are disabled this run. Reply explaining what would need to change; don't edit source files.`;

  const followupLine = isFollowup
    ? `\n- **Thread reply** — this is a follow-up. Re-read the files before editing; your prior context is stale and the doc/code already reflect earlier turns. If the request is to revert, tighten, or rename something from a prior turn, locate and actually edit the current content on disk.`
    : '';

  return `You are agent "${ctx.agentName}", replying to a comment on a shared design doc in Google Docs. The doc describes the software; collaborators critique and evolve it via comments.

${threadSection}${quoteSection}${prSection}

Working directory: ${ctx.workingDirectory}
Design doc file: ${ctx.designDocPath}

## What to do

Just do what the comment calls for — don't classify out loud. The system detects outcomes from disk side effects.

- **Doc edit** — reword, restructure, or correct descriptions of *existing* behavior: use Edit/Write on ${ctx.designDocPath}. Reading alone isn't a change.
${codeLine}
- **Both**: do both in the same run.${ctx.codeEnabled ? '' : ' (Code is disabled.)'}
- **Question or verification** ("is X safe?", "how does Y work?", "which of these are implemented?"): answer in the reply and change nothing on disk. If you spot a discrepancy, report it and let the user decide. Reading and investigating is fine; the reply is the deliverable.
- **Open-ended brainstorm** ("let's discuss…"): write \`{"title": "<~40 chars>"}\` to ${ctx.chatMarkerPath} and stop. Don't also edit.${followupLine}

Prose describing behavior does not build the behavior. If a doc update would describe something the code doesn't yet do, that's a code change (do the code, or reply that code changes aren't enabled).

## Before you edit

- **Verify the anchor.** If the highlighted/quoted text isn't present in the current doc, say so in the reply and make no edit — don't pick a nearby target and act as if it were the ask.
- **Check current state.** Read the relevant files first. If the state already matches the ask, reply saying so rather than producing a change to justify the turn.
- **Narrow the interpretation.** For a vague request with no clear target, either ask one concrete clarifying question OR make a single narrow change and name it in one sentence. Never ship a sweeping rewrite.

## Don't silently comply with risky requests

Push back in the reply — and don't produce the change — when the ask would cause hard-to-reverse harm: destroying stored data, weakening a security or authentication boundary, or placing credentials into source. Propose a safer path and wait for confirmation. Don't echo sensitive input (e.g. pasted credentials) back in the reply.

## Reply

Plain-text summary of what you actually did, posted as the Google Doc reply. Keep it short, honest, and concrete: identify what you touched by name. If you made no change, say so. Avoid tables and large code blocks. For diagrams inside the doc itself, use \`\`\`mermaid fences.
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
