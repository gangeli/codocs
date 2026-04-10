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
  /** Display names of known bot identities (fallback when email is unavailable). */
  botDisplayNames?: string[];
}

/**
 * Determine whether the latest activity on a comment thread came from
 * a human or a bot.
 *
 * Looks at the last non-action reply (or the root comment if no replies),
 * and checks the author's email and display name against known bot identities.
 *
 * Note: when fetching comments via a service account, other users' email
 * addresses may be unavailable (returned as undefined). We fall back to
 * matching on display name in that case.
 */
export function classifyComment(
  comment: drive_v3.Schema$Comment,
  opts: ClassifyOptions,
): CommentOrigin {
  // Find the latest non-action reply, or fall back to the root comment
  const replies = (comment.replies ?? []).filter((r) => !r.action);
  const lastEntry = replies.length > 0 ? replies[replies.length - 1] : comment;

  const email = lastEntry.author?.emailAddress ?? '';
  const displayName = lastEntry.author?.displayName ?? '';

  // Match on email if available
  if (email && opts.botEmails.some((botEmail) => email === botEmail)) {
    return { type: 'bot', author: displayName || email };
  }

  // Match on display name as fallback (service accounts may not expose
  // emailAddress when fetched by a different service account)
  // Build display name candidates: explicit list, plus the raw emails themselves
  // (service accounts often show the full email as their display name)
  const botNames = [
    ...(opts.botDisplayNames ?? []),
    ...opts.botEmails,
    ...opts.botEmails.map(extractNameFromEmail),
  ];
  if (displayName && botNames.some((name) => displayName === name)) {
    return { type: 'bot', author: displayName };
  }

  if (!email && !displayName) {
    return { type: 'unknown' };
  }

  return { type: 'human', author: displayName || email };
}

/** Extract the local part of an email for display name matching. */
function extractNameFromEmail(email: string): string {
  return email.split('@')[0];
}
