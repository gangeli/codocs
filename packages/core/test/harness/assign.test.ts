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
    expect(offsets[0]).toBe(1); // doc index starts at 1
    expect(offsets[text.length - 1]).toBe(11);
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
    // "AABBAA" — agentA has 2+2=4 total, agentB has 2+2=4 total
    // but agentA and agentB have same max contiguous (2)
    // Let's make agentA have one bigger contiguous block
    const doc = makeDoc('AAABB');
    const attributions = [
      makeSpan('agentA', 1, 4),  // AAA (3 chars)
      makeSpan('agentB', 4, 6),  // BB (2 chars)
    ];
    expect(assignAgent('AAABB', attributions, doc, config)).toBe('agentA');
  });

  it('handles partial overlap with quoted text', () => {
    const doc = makeDoc('Hello World Foo');
    // attribution covers "Hello World Foo" (1-16)
    // but quoted text is just "World" (7-12)
    const attributions = [makeSpan('coder', 1, 16)];
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
