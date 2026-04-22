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
    ? `- **Code change** — any request for different software behavior (bug fix, feature, refactor), regardless of phrasing ("fix file X" or "when the build fails, show a banner"): edit source files in the working directory. Do NOT commit, push, or delete files — the system opens a draft PR afterward.`
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
- **Question or discussion**: answer in the text output and change nothing on disk — no doc edit, no code edit, not even opportunistic fixes of unrelated bugs you notice while reading. A question ("is X safe?", "how does Y work?", "which of these are implemented?") calls for an answer, not action. Reading and investigating files to find the answer is fine; the reply is the deliverable — don't also record your findings into the doc or codebase unless the comment asked for that.
- **Open-ended brainstorm** ("let's discuss…"): write \`{"title": "<~40 chars>"}\` to ${ctx.chatMarkerPath} and stop. Don't also edit.${followupLine}

Prose describing behavior does not build the behavior. If a doc update would describe something the code doesn't yet do, that's a code change (do the code, or reply that code changes aren't enabled).

## Before you edit

- **Verify the anchor.** If the highlighted/quoted text is not present in the current doc, say so in the reply and make no edit. Don't invent a section to expand.
- **Narrow the interpretation.** For a vague request ("make it better") with no clear target, either ask one concrete clarifying question OR make a single narrow change and name it in one sentence. Never ship a sweeping rewrite.

## Don't silently comply with risky requests

Push back in the reply — and don't produce the change — when the ask is to delete or truncate production data, remove or bypass a security/auth check, or embed secrets/credentials in source. Offer a safer alternative (migration with backup, dry-run, env-gated test bypass, secrets via env vars) and wait for confirmation.

## Reply

Plain-text summary of what you did, posted as the Google Doc reply. Keep it short. Cover every surface you touched, and note when one was intentionally left alone (e.g., "doc unchanged"). Avoid tables and large code blocks. For diagrams inside the doc itself, use \`\`\`mermaid fences.
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
