/**
 * Tests for `executeAnchorSpliceOps` — the orchestrator-side
 * two-step batchUpdate dance from §3.7.1, with retry + restore on
 * step-2 failure.
 *
 * Uses an in-memory mutable doc as the mock. Each batchUpdate is
 * applied in-place so subsequent getDocument/locateOldTextRange calls
 * see the running state — which is what the executor relies on.
 */
import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import {
  executeAnchorSpliceOps,
  computeTrimRanges,
  locateOldTextRange,
  type SpliceDocsClient,
} from '../../src/harness/anchor-splice-exec.js';
import type { AnchorSpliceOp } from '../../src/harness/anchor-splice.js';

class FakeDoc {
  text: string;
  failuresLeft: number;
  calls: docs_v1.Schema$Request[][] = [];

  constructor(text: string, failuresLeft = 0) {
    this.text = text;
    this.failuresLeft = failuresLeft;
  }

  /** Current doc snapshot as a Schema$Document with body-index 1 = first char. */
  asDoc(): docs_v1.Schema$Document {
    return {
      body: {
        content: [
          { startIndex: 0, endIndex: 1, sectionBreak: {} },
          {
            startIndex: 1,
            endIndex: 1 + this.text.length,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: 1 + this.text.length,
                  textRun: { content: this.text },
                },
              ],
            },
          },
        ],
      },
    };
  }

  apply(requests: docs_v1.Schema$Request[]) {
    // Sort by descending startIndex so deletes/inserts at higher
    // indices don't invalidate lower ones.
    const sorted = [...requests].sort((a, b) => {
      const ai = reqIndex(a);
      const bi = reqIndex(b);
      return bi - ai;
    });
    for (const r of sorted) {
      if (r.deleteContentRange?.range) {
        const { startIndex, endIndex } = r.deleteContentRange.range;
        if (startIndex == null || endIndex == null) continue;
        // body-index 1 = text[0], so we slice text by (idx - 1).
        const a = startIndex - 1;
        const b = endIndex - 1;
        this.text = this.text.slice(0, a) + this.text.slice(b);
      } else if (r.insertText?.location?.index != null && r.insertText.text != null) {
        const at = r.insertText.location.index - 1;
        this.text = this.text.slice(0, at) + r.insertText.text + this.text.slice(at);
      }
    }
  }
}

function reqIndex(r: docs_v1.Schema$Request): number {
  return r.deleteContentRange?.range?.startIndex
    ?? r.insertText?.location?.index
    ?? 0;
}

function makeClient(doc: FakeDoc, opts: { failStep2?: number } = {}): SpliceDocsClient {
  let updateCount = 0;
  let stepInOp = 0; // 0 = next is step-1 insert, 1 = next is step-2 trim
  return {
    async getDocument() {
      return doc.asDoc();
    },
    async batchUpdate(_docId, requests) {
      doc.calls.push(requests);
      updateCount++;
      const isInsert = requests.some((r) => r.insertText && !r.deleteContentRange);
      const isTrim = requests.some((r) => r.deleteContentRange && !r.insertText);
      if (isInsert && stepInOp === 0) {
        // Step 1
        doc.apply(requests);
        stepInOp = 1;
        return;
      }
      if (isTrim && stepInOp === 1) {
        if ((opts.failStep2 ?? 0) > 0) {
          opts.failStep2!--;
          throw new Error(`simulated step-2 failure (${updateCount})`);
        }
        doc.apply(requests);
        stepInOp = 0;
        return;
      }
      // Mixed (restore path) or anything else — apply unconditionally.
      doc.apply(requests);
    },
  };
}

describe('computeTrimRanges', () => {
  it('returns leading + trailing in descending order, sized to oldText', () => {
    // anchor [10, 15) (5 chars), newText length 3
    // expected leading [10, 11), trailing [14, 18)
    const out = computeTrimRanges({ startIndex: 10, endIndex: 15 }, 3);
    expect(out).toEqual([
      { startIndex: 14, endIndex: 18 }, // trailing first
      { startIndex: 10, endIndex: 11 }, // leading second
    ]);
  });

  it('omits trailing range when oldText length is exactly MIN_SPLICE_LEN', () => {
    // anchor [10, 12) (2 chars), newText length 4
    // After step 1: [O][NEWT][K] — trailing would be [15, 16) if length 1
    const out = computeTrimRanges({ startIndex: 10, endIndex: 12 }, 4);
    expect(out).toEqual([
      { startIndex: 15, endIndex: 16 },
      { startIndex: 10, endIndex: 11 },
    ]);
  });
});

describe('locateOldTextRange', () => {
  it('finds text and returns 1-based body indices', () => {
    const doc = new FakeDoc('the quick brown fox\n');
    const r = locateOldTextRange(doc.asDoc(), 'brown');
    expect(r).toEqual({ startIndex: 11, endIndex: 16 });
    // Verify by extracting that range from the body text:
    expect(doc.text.slice(11 - 1, 16 - 1)).toBe('brown');
  });

  it('returns null when the text appears more than once', () => {
    const doc = new FakeDoc('fox and fox\n');
    expect(locateOldTextRange(doc.asDoc(), 'fox')).toBeNull();
  });

  it('returns null when text does not appear', () => {
    const doc = new FakeDoc('hello world\n');
    expect(locateOldTextRange(doc.asDoc(), 'banana')).toBeNull();
  });
});

describe('executeAnchorSpliceOps', () => {
  function makeOp(): AnchorSpliceOp {
    return {
      commentId: 'c1',
      currentRange: { startIndex: 5, endIndex: 10 },
      newText: 'RED',
      oldText: 'BROWN',
      splicePoint: 6,
      trimRanges: [],
    };
  }

  it('splices in two batchUpdate calls, anchor ends at exactly newText', async () => {
    const doc = new FakeDoc('pre BROWN post\n');
    const client = makeClient(doc);
    const result = await executeAnchorSpliceOps(client, 'doc1', [makeOp()]);
    expect(result.spliced).toEqual(['c1']);
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(doc.text).toBe('pre RED post\n');
    // Exactly two API calls in the success path (step 1 + step 2). The
    // initial getDocument and post-step-1 fresh fetch don't count as
    // batchUpdates.
    expect(doc.calls.length).toBe(2);
    expect(doc.calls[0].some((r) => r.insertText)).toBe(true);
    expect(doc.calls[1].every((r) => r.deleteContentRange)).toBe(true);
  });

  it('skips an op when the anchor text is missing from the current doc', async () => {
    const doc = new FakeDoc('pre WHITE post\n');
    const client = makeClient(doc);
    const result = await executeAnchorSpliceOps(client, 'doc1', [makeOp()]);
    expect(result.skipped).toEqual(['c1']);
    expect(result.spliced).toEqual([]);
    // Doc is unchanged.
    expect(doc.text).toBe('pre WHITE post\n');
    expect(doc.calls.length).toBe(0);
  });

  it('retries step-2 once on failure with refreshed indices', async () => {
    const doc = new FakeDoc('pre BROWN post\n');
    const client = makeClient(doc, { failStep2: 1 });
    const result = await executeAnchorSpliceOps(client, 'doc1', [makeOp()]);
    expect(result.spliced).toEqual(['c1']);
    expect(doc.text).toBe('pre RED post\n');
  });

  it('restores original text on second step-2 failure', async () => {
    const doc = new FakeDoc('pre BROWN post\n');
    const client = makeClient(doc, { failStep2: 2 });
    const result = await executeAnchorSpliceOps(client, 'doc1', [makeOp()]);
    expect(result.restored).toEqual(['c1']);
    expect(result.spliced).toEqual([]);
    // Restore put BROWN back where it was.
    expect(doc.text).toBe('pre BROWN post\n');
  });
});
