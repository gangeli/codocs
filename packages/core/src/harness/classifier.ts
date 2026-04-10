/**
 * Comment classification: determines whether a comment requests code
 * modifications or is informational / about the document itself.
 *
 * The agent self-classifies by outputting a [MODE: ...] header as the
 * first line of its response. This module builds the preamble prompt
 * and parses the classification from the agent's stdout.
 */

export interface Classification {
  /** Whether this is a code modification request or a document-level action. */
  mode: 'code' | 'doc';
  /** Brief description of the code change (only present for code mode). */
  description?: string;
  /** The agent's response with the classification header stripped. */
  response: string;
}

/**
 * Returns a prompt preamble that instructs the agent to classify
 * the comment before responding.
 */
export function buildClassificationPreamble(): string {
  return `IMPORTANT: Before your response, output exactly ONE of these on the FIRST line:
[MODE: code] <brief description of the code change>
[MODE: doc]

Use [MODE: code] if the comment asks you to modify, fix, add, remove, or refactor source code in the repository.
Use [MODE: doc] if the comment is about the document itself, is an informational question, or doesn't involve code changes.

Then provide your full response starting from the second line.
`;
}

const MODE_PATTERN = /^\[MODE:\s*(code|doc)\]\s*(.*)?$/i;

/**
 * Parse the classification header from agent stdout.
 *
 * Defaults to 'doc' mode if no valid header is found (safe fallback —
 * preserves existing behavior).
 */
export function parseClassification(stdout: string): Classification {
  const lines = stdout.split('\n');
  const firstLine = lines[0]?.trim() ?? '';

  const match = firstLine.match(MODE_PATTERN);
  if (!match) {
    // No valid header — default to doc mode
    return { mode: 'doc', response: stdout };
  }

  const mode = match[1].toLowerCase() as 'code' | 'doc';
  const description = match[2]?.trim() || undefined;
  const response = lines.slice(1).join('\n').trim();

  return { mode, description, response };
}
