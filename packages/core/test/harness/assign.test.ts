import { describe, it, expect } from 'vitest';
import { assignAgent, findQuotedTextIndices, buildFlatText } from '../../src/harness/assign.js';
import type { docs_v1 } from 'googleapis';
import type { AttributionSpan } from '../../src/types.js';

/** Helper to build a minimal Google Doc with given text. */
function makeDoc(text: string): docs_v1.Schema$Document {
  return {
    body: {
      content: [
        {
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 1 + text.length,
                textRun: { content: text },
              },
            ],
          },
        },
      ],
    },
  };
}

function makeSpan(
  agentName: string,
  startIndex: number,
  endIndex: number,
): AttributionSpan {
  return {
    agentName,
    namedRangeId: `range-${agentName}-${startIndex}`,
    ranges: [{ startIndex, endIndex }],
    text: '',
  };
}

describe('buildFlatText', () => {
  it('extracts text and offsets from a doc body', () => {
    const doc = makeDoc('Hello World');
    const { text, offsets } = buildFlatText(doc.body);

    expect(text).toBe('Hello World');
    expect(offsets).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe('findQuotedTextIndices', () => {
  it('finds quoted text in the document', () => {
    const doc = makeDoc('Hello World');
    const result = findQuotedTextIndices(doc, 'World');

    expect(result).toEqual({ startIndex: 7, endIndex: 12 });
  });

  it('returns null for missing text', () => {
    const doc = makeDoc('Hello World');
    expect(findQuotedTextIndices(doc, 'Missing')).toBeNull();
  });

  it('returns null for empty quoted text', () => {
    const doc = makeDoc('Hello World');
    expect(findQuotedTextIndices(doc, '')).toBeNull();
  });
});

describe('assignAgent', () => {
  const config = { fallbackAgent: 'coordinator' };

  it('returns fallback when no quoted text', () => {
    const doc = makeDoc('Hello');
    expect(assignAgent('', [], doc, config)).toBe('coordinator');
  });

  it('returns fallback when quoted text not found in doc', () => {
    const doc = makeDoc('Hello');
    expect(assignAgent('Missing', [], doc, config)).toBe('coordinator');
  });

  it('returns fallback when no attributions overlap', () => {
    const doc = makeDoc('Hello World');
    const attributions = [makeSpan('coder', 1, 6)]; // covers "Hello"
    expect(assignAgent('World', attributions, doc, config)).toBe('coordinator');
  });

  it('returns the single overlapping agent', () => {
    const doc = makeDoc('Hello World');
    // "World" is at doc indices 7-12
    const attributions = [makeSpan('coder', 7, 12)];
    expect(assignAgent('World', attributions, doc, config)).toBe('coder');
  });

  it('returns majority agent by total character overlap', () => {
    // "AAABBBBB" — 3 chars from agentA, 5 from agentB
    const doc = makeDoc('AAABBBBB');
    const attributions = [
      makeSpan('agentA', 1, 4),  // AAA (indices 1-4)
      makeSpan('agentB', 4, 9),  // BBBBB (indices 4-9)
    ];
    // Quoted text is the whole string: indices 1-9
    expect(assignAgent('AAABBBBB', attributions, doc, config)).toBe('agentB');
  });

  it('breaks ties by largest contiguous overlap', () => {
    // Both agents have total overlap of 4, but agentA has a single
    // 4-char contiguous span while agentB has two 2-char spans.
    // Tie-break on maxContiguous should pick agentA.
    const doc = makeDoc('AAAABBBB');
    const attributions: AttributionSpan[] = [
      {
        agentName: 'agentA',
        namedRangeId: 'rA',
        ranges: [{ startIndex: 1, endIndex: 5 }], // AAAA — 4 contiguous
        text: '',
      },
      {
        agentName: 'agentB',
        namedRangeId: 'rB',
        ranges: [
          { startIndex: 5, endIndex: 7 }, // BB — 2 chars
          { startIndex: 7, endIndex: 9 }, // BB — 2 chars
        ],
        text: '',
      },
    ];
    expect(assignAgent('AAAABBBB', attributions, doc, config)).toBe('agentA');
  });

  it('handles partial overlap with quoted text', () => {
    const doc = makeDoc('Hello World Foo');
    // Attribution covers indices 5..9 (partway into quoted range).
    // Quoted text "World" is at indices 7..12, so overlap is only
    // [7,9) = 2 chars — genuinely partial, not fully contained.
    const attributions: AttributionSpan[] = [
      {
        agentName: 'coder',
        namedRangeId: 'r1',
        ranges: [{ startIndex: 5, endIndex: 9 }],
        text: '',
      },
    ];
    expect(assignAgent('World', attributions, doc, config)).toBe('coder');
  });

  it('handles multiple spans from the same agent', () => {
    const doc = makeDoc('Hello World');
    // Same agent has two ranges overlapping the quoted text
    const attributions: AttributionSpan[] = [
      {
        agentName: 'coder',
        namedRangeId: 'r1',
        ranges: [
          { startIndex: 7, endIndex: 9 },   // "Wo"
          { startIndex: 9, endIndex: 12 },   // "rld"
        ],
        text: '',
      },
    ];
    expect(assignAgent('World', attributions, doc, config)).toBe('coder');
  });
});
