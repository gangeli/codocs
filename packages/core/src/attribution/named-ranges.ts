/**
 * Manage named ranges for agent attribution in Google Docs.
 */

import type { docs_v1 } from 'googleapis';
import { AGENT_RANGE_PREFIX, type AttributionSpan, type RgbColor } from '../types.js';

/**
 * Build requests to create a named range for an agent and optionally color the text.
 */
export function createAttributionRequests(
  agentName: string,
  startIndex: number,
  endIndex: number,
  color?: RgbColor,
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [];

  requests.push({
    createNamedRange: {
      name: AGENT_RANGE_PREFIX + agentName,
      range: { startIndex, endIndex },
    },
  });

  if (color) {
    requests.push({
      updateTextStyle: {
        range: { startIndex, endIndex },
        textStyle: {
          foregroundColor: {
            color: {
              rgbColor: { red: color.red, green: color.green, blue: color.blue },
            },
          },
        },
        fields: 'foregroundColor',
      },
    });
  }

  return requests;
}

/**
 * Extract all agent attribution spans from a document.
 */
export function extractAttributions(
  document: docs_v1.Schema$Document,
): AttributionSpan[] {
  const namedRanges = document.namedRanges;
  if (!namedRanges) return [];

  const spans: AttributionSpan[] = [];
  const bodyContent = document.body?.content ?? [];

  for (const [name, rangeData] of Object.entries(namedRanges)) {
    if (!name.startsWith(AGENT_RANGE_PREFIX)) continue;

    const agentName = name.slice(AGENT_RANGE_PREFIX.length);

    for (const namedRange of rangeData.namedRanges ?? []) {
      const ranges: Array<{ startIndex: number; endIndex: number }> = [];

      for (const range of namedRange.ranges ?? []) {
        ranges.push({
          startIndex: range.startIndex ?? 0,
          endIndex: range.endIndex ?? 0,
        });
      }

      // Extract text for these ranges from the document body
      const text = extractTextFromRanges(bodyContent, ranges);

      spans.push({
        agentName,
        namedRangeId: namedRange.namedRangeId ?? '',
        ranges,
        text,
      });
    }
  }

  return spans;
}

/**
 * Build a request to delete a named range by ID.
 */
export function deleteNamedRangeRequest(
  namedRangeId: string,
): docs_v1.Schema$Request {
  return {
    deleteNamedRange: { namedRangeId },
  };
}

/**
 * Extract plain text from document body content within the given index ranges.
 */
function extractTextFromRanges(
  content: docs_v1.Schema$StructuralElement[],
  ranges: Array<{ startIndex: number; endIndex: number }>,
): string {
  let text = '';

  for (const element of content) {
    if (!element.paragraph) continue;

    for (const el of element.paragraph.elements ?? []) {
      if (!el.textRun?.content) continue;

      const elStart = el.startIndex ?? 0;
      const elEnd = el.endIndex ?? 0;

      for (const range of ranges) {
        // Check overlap
        const overlapStart = Math.max(elStart, range.startIndex);
        const overlapEnd = Math.min(elEnd, range.endIndex);

        if (overlapStart < overlapEnd) {
          const content = el.textRun.content!;
          const sliceStart = overlapStart - elStart;
          const sliceEnd = overlapEnd - elStart;
          text += content.slice(sliceStart, sliceEnd);
        }
      }
    }
  }

  return text;
}
