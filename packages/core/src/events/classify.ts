/**
 * Classify whether a comment event should be processed.
 *
 * This is factored out so we can easily change classification logic
 * (e.g., respond to certain bot messages, ignore specific patterns, etc.).
 */

import type { drive_v3 } from 'googleapis';

export type CommentOrigin =
  | { type: 'human'; author: string }
  | { type: 'bot'; author: string }
  | { type: 'unknown' };

export interface ClassifyOptions {
  /** Email addresses of known bot identities. */
  botEmails: string[];
}

/**
 * Determine whether the latest activity on a comment thread came from
 * a human or a bot.
 *
 * Looks at the last non-action reply (or the root comment if no replies),
 * and checks the author's email against known bot emails.
 */
export function classifyComment(
  comment: drive_v3.Schema$Comment,
  opts: ClassifyOptions,
): CommentOrigin {
  // Find the latest non-action reply, or fall back to the root comment
  const replies = (comment.replies ?? []).filter((r) => !r.action);
  const lastEntry = replies.length > 0 ? replies[replies.length - 1] : comment;

  const email = lastEntry.author?.emailAddress ?? '';
  const displayName = lastEntry.author?.displayName ?? email;

  if (!email) {
    return { type: 'unknown' };
  }

  if (opts.botEmails.some((botEmail) => email === botEmail)) {
    return { type: 'bot', author: displayName };
  }

  return { type: 'human', author: displayName };
}
