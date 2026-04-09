/**
 * Agent assignment — determine which agent should handle a comment
 * based on attribution overlap with the quoted text.
 */

import type { docs_v1 } from 'googleapis';
import type { AttributionSpan } from '../types.js';

export interface AssignmentConfig {
  /** Agent to use when no attributions overlap the quoted text. */
  fallbackAgent: string;
}

/**
 * Build flat plain text from a Google Doc body, with a mapping from
 * text offset to document index.
 */
export function buildFlatText(
  body: docs_v1.Schema$Body | undefined,
): { text: string; offsets: number[] } {
  const textParts: string[] = [];
  const offsets: number[] = [];

  for (const element of body?.content ?? []) {
    if (!element.paragraph) continue;

    for (const el of element.paragraph.elements ?? []) {
      if (!el.textRun?.content) continue;
      const elStart = el.startIndex ?? 0;
      const content = el.textRun.content;

      for (let i = 0; i < content.length; i++) {
        textParts.push(content[i]);
        offsets.push(elStart + i);
      }
    }
  }

  return { text: textParts.join(''), offsets };
}

/**
 * Find the document index range of a quoted text substring within
 * the document body. Returns null if not found.
 */
export function findQuotedTextIndices(
  document: docs_v1.Schema$Document,
  quotedText: string,
): { startIndex: number; endIndex: number } | null {
  if (!quotedText) return null;

  const { text, offsets } = buildFlatText(document.body);
  const idx = text.indexOf(quotedText);
  if (idx === -1) return null;

  return {
    startIndex: offsets[idx],
    endIndex: offsets[idx + quotedText.length - 1] + 1,
  };
}

/**
 * Compute overlap length between two index ranges.
 */
function overlapLength(
  a: { startIndex: number; endIndex: number },
  b: { startIndex: number; endIndex: number },
): number {
  const start = Math.max(a.startIndex, b.startIndex);
  const end = Math.min(a.endIndex, b.endIndex);
  return Math.max(0, end - start);
}

/**
 * Determine which agent should handle a comment based on attribution
 * overlap with the quoted text.
 *
 * Algorithm:
 * 1. Find the quoted text's position in the document.
 * 2. Check which attribution spans overlap those indices.
 * 3. Weight each agent by total character overlap.
 * 4. Return the majority agent. Ties broken by largest single contiguous overlap.
 * 5. Fall back to config.fallbackAgent if no overlaps.
 */
export function assignAgent(
  quotedText: string,
  attributions: AttributionSpan[],
  document: docs_v1.Schema$Document,
  config: AssignmentConfig,
): string {
  if (!quotedText) return config.fallbackAgent;

  const quoted = findQuotedTextIndices(document, quotedText);
  if (!quoted) return config.fallbackAgent;

  // Accumulate overlap per agent
  const agentOverlap = new Map<string, { total: number; maxContiguous: number }>();

  for (const span of attributions) {
    for (const range of span.ranges) {
      const overlap = overlapLength(quoted, range);
      if (overlap <= 0) continue;

      const existing = agentOverlap.get(span.agentName) ?? { total: 0, maxContiguous: 0 };
      existing.total += overlap;
      existing.maxContiguous = Math.max(existing.maxContiguous, overlap);
      agentOverlap.set(span.agentName, existing);
    }
  }

  if (agentOverlap.size === 0) return config.fallbackAgent;

  // Sort by total overlap descending, then by max contiguous descending
  const sorted = [...agentOverlap.entries()].sort((a, b) => {
    if (b[1].total !== a[1].total) return b[1].total - a[1].total;
    return b[1].maxContiguous - a[1].maxContiguous;
  });

  return sorted[0][0];
}
