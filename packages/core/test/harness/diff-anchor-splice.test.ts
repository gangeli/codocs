/**
 * Unit tests for `preserveCommentAnchors` splice mode (design doc §3.7.1).
 *
 * Focus on the pure computation — eligibility checks, splice op
 * construction, multi-anchor resolution, and revert fallback. The
 * orchestrator-side two-step batchUpdate dance is exercised in
 * `diff-anchor-splice-exec.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { preserveCommentAnchors } from '../../src/harness/diff.js';
import {
  planAnchorOutcomes,
  tryBuildSpliceOp,
  MIN_SPLICE_LEN,
  type CommentAnchor,
} from '../../src/harness/anchor-splice.js';
import type { IndexMapEntry } from '../../src/converter/element-parser.js';

/**
 * Build a flat single-paragraph doc plus an indexMap that maps each
 * markdown char 1:1 onto a body-index char. Identity mapping makes
 * splice math easy to read in assertions: docIndex == mdOffset + 1.
 */
function flatDoc(text: string): {
  doc: docs_v1.Schema$Document;
  indexMap: IndexMapEntry[];
  bodyEndIndex: number;
} {
  const docText = text + '\n';
  const doc: docs_v1.Schema$Document = {
    body: {
      content: [
        { startIndex: 0, endIndex: 1, sectionBreak: {} },
        {
          startIndex: 1,
          endIndex: 1 + docText.length,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 1 + docText.length,
                textRun: { content: docText },
              },
            ],
          },
        },
      ],
    },
  };
  // Identity index map: one entry per character position in markdown.
  const indexMap: IndexMapEntry[] = [];
  for (let i = 0; i <= text.length; i++) {
    indexMap.push({ mdOffset: i, docIndex: i + 1 });
  }
  return { doc, indexMap, bodyEndIndex: 1 + docText.length };
}

describe('tryBuildSpliceOp — eligibility', () => {
  const theirs = '# Heading\n\nThe quick brown fox jumps.\n';
  const merged = '# Heading\n\nThe quick red fox jumps.\n';
  const { indexMap, bodyEndIndex } = flatDoc(theirs);

  it('emits a splice op when anchor >= MIN_SPLICE_LEN and replacement is non-empty', () => {
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'brown' },
      theirs, mergedMarkdown: merged, indexMap, bodyEndIndex,
    });
    if ('ineligible' in out) throw new Error(`expected splice, got ineligible: ${out.ineligible}`);
    expect(out.commentId).toBe('c1');
    expect(out.newText).toBe('red');
    expect(out.oldText).toBe('brown');
    // splicePoint is 1 past the start of the anchor.
    expect(out.splicePoint).toBe(out.currentRange.startIndex + 1);
    // currentRange must span exactly the anchor text.
    expect(out.currentRange.endIndex - out.currentRange.startIndex).toBe('brown'.length);
  });

  it('falls back when anchor is shorter than MIN_SPLICE_LEN', () => {
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'b' },
      theirs: 'b is a single char', mergedMarkdown: 'X is a single char',
      indexMap: flatDoc('b is a single char').indexMap,
      bodyEndIndex: flatDoc('b is a single char').bodyEndIndex,
    });
    expect('ineligible' in out && out.ineligible).toBe('anchor-too-short');
    expect(MIN_SPLICE_LEN).toBe(2);
  });

  it('falls back when the anchor is empty', () => {
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: '' },
      theirs, mergedMarkdown: merged, indexMap, bodyEndIndex,
    });
    expect('ineligible' in out && out.ineligible).toBe('anchor-empty');
  });

  it('falls back when the merged result has no replacement (fully deleted)', () => {
    const deletedMerged = '# Heading\n\nThe quick fox jumps.\n';
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'brown ' },
      theirs, mergedMarkdown: deletedMerged, indexMap, bodyEndIndex,
    });
    expect('ineligible' in out && out.ineligible).toBe('replacement-empty');
  });

  it('falls back when the anchor occurs more than once in current doc', () => {
    const dupTheirs = 'a fox and a fox.\n';
    const dupMerged = 'a cat and a fox.\n';
    const fd = flatDoc(dupTheirs);
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'fox' },
      theirs: dupTheirs, mergedMarkdown: dupMerged,
      indexMap: fd.indexMap, bodyEndIndex: fd.bodyEndIndex,
    });
    expect('ineligible' in out && out.ineligible).toBe('multiple-anchor-occurrences');
  });

  it('falls back when the anchor crosses a heading boundary', () => {
    const t = '# A heading\n\nbody text\n';
    const m = '# A heading\n\nrewritten body\n';
    const fd = flatDoc(t);
    const out = tryBuildSpliceOp({
      // anchor straddles the heading line + body
      anchor: { commentId: 'c1', quotedText: '# A heading\n\nbody text' },
      theirs: t, mergedMarkdown: m, indexMap: fd.indexMap, bodyEndIndex: fd.bodyEndIndex,
    });
    expect('ineligible' in out && out.ineligible).toBe('structural-boundary-cross');
  });
});

describe('tryBuildSpliceOp — op construction', () => {
  it('places splicePoint just after the first character of the anchor', () => {
    const t = 'before brown after\n';
    const m = 'before red after\n';
    const fd = flatDoc(t);
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'brown' },
      theirs: t, mergedMarkdown: m, indexMap: fd.indexMap, bodyEndIndex: fd.bodyEndIndex,
    });
    if ('ineligible' in out) throw new Error('expected splice');
    expect(out.splicePoint).toBe(out.currentRange.startIndex + 1);
  });

  it('trim ranges sum to (oldText.length - 0) and isolate newText after step 1', () => {
    // anchor = "BROWN" (5 chars), newText = "RED" (3 chars)
    // After step 1 (insert RED at start+1):
    //   layout: [B][RED][ROWN] — size 1 + 3 + 4 = 8
    // Step 2 trims: leading [start, start+1] (the B), trailing [start+1+3, start+1+3+4] = [start+4, start+8] (ROWN)
    const t = 'X BROWN Y\n';
    const m = 'X RED Y\n';
    const fd = flatDoc(t);
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'BROWN' },
      theirs: t, mergedMarkdown: m, indexMap: fd.indexMap, bodyEndIndex: fd.bodyEndIndex,
    });
    if ('ineligible' in out) throw new Error('expected splice');
    const start = out.currentRange.startIndex;
    // Two ranges: trailing first (descending), then leading.
    expect(out.trimRanges).toEqual([
      { startIndex: start + 4, endIndex: start + 8 },
      { startIndex: start, endIndex: start + 1 },
    ]);
    // Total trim length must equal old anchor length minus what's left
    // (the 1-char prefix went to leading; the rest went to trailing).
    const totalTrim = out.trimRanges.reduce((s, r) => s + (r.endIndex - r.startIndex), 0);
    expect(totalTrim).toBe('BROWN'.length);
  });

  it('2-char anchor uses the minimal interior splice point (1 char on each side)', () => {
    // anchor = "OK" (2 chars). splicePoint = start+1, leaving 1 char of
    // prefix and 1 char of suffix. After step 1 with newText="YES":
    //   [O][YES][K] — size 1 + 3 + 1 = 5
    // Step 2 trims: trailing [start+4, start+5] and leading [start, start+1].
    const t = 'pre OK post\n';
    const m = 'pre YES post\n';
    const fd = flatDoc(t);
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'OK' },
      theirs: t, mergedMarkdown: m, indexMap: fd.indexMap, bodyEndIndex: fd.bodyEndIndex,
    });
    if ('ineligible' in out) throw new Error('expected splice');
    const start = out.currentRange.startIndex;
    expect(out.splicePoint).toBe(start + 1);
    expect(out.trimRanges).toEqual([
      { startIndex: start + 4, endIndex: start + 5 },
      { startIndex: start, endIndex: start + 1 },
    ]);
  });
});

describe('planAnchorOutcomes — multi-anchor', () => {
  const theirs = 'pre brown post and also yellow there\n';
  const merged = 'pre red post and also green there\n';
  const fd = flatDoc(theirs);

  it('emits independent splice ops for two non-overlapping anchors', () => {
    const outcomes = planAnchorOutcomes({
      anchors: [
        { commentId: 'a', quotedText: 'brown' },
        { commentId: 'b', quotedText: 'yellow' },
      ],
      theirs, mergedMarkdown: merged,
      indexMap: fd.indexMap, bodyEndIndex: fd.bodyEndIndex,
    });
    expect(outcomes.map((o) => o.kind)).toEqual(['splice', 'splice']);
  });

  it('downgrades the narrower anchor to revert when two anchors overlap', () => {
    // Two anchors over a single edit (brown → red). "quick brown fox"
    // (wider) fully covers the edit; "brown" (narrower) sits inside
    // it. Both individually map to clean splices, but their body-index
    // ranges overlap so only the wider one survives.
    const t = 'The quick brown fox jumps over.\n';
    const m = 'The quick red fox jumps over.\n';
    const fd2 = flatDoc(t);
    const outcomes = planAnchorOutcomes({
      anchors: [
        { commentId: 'wider', quotedText: 'quick brown fox' },
        { commentId: 'narrower', quotedText: 'brown' },
      ],
      theirs: t, mergedMarkdown: m,
      indexMap: fd2.indexMap, bodyEndIndex: fd2.bodyEndIndex,
    });
    // Wider one splices, narrower reverts.
    const wider = outcomes.find((o) => o.kind === 'splice' && o.op.commentId === 'wider');
    const narrower = outcomes.find((o) => o.kind === 'revert' && o.quotedText === 'brown');
    expect(wider).toBeTruthy();
    expect(narrower).toBeTruthy();
    if (narrower && narrower.kind === 'revert') {
      expect(narrower.reason).toBe('overlapping-anchor');
    }
  });

  it('leaves an unchanged anchor as a no-op (no splice, no revert)', () => {
    const t = 'pre stable text more\n';
    const m = 'pre stable text more\n';
    const fd2 = flatDoc(t);
    const outcomes = planAnchorOutcomes({
      anchors: [{ commentId: 'c', quotedText: 'stable text' }],
      theirs: t, mergedMarkdown: m,
      indexMap: fd2.indexMap, bodyEndIndex: fd2.bodyEndIndex,
    });
    expect(outcomes[0].kind).toBe('noop');
  });
});

describe('preserveCommentAnchors — top-level wiring', () => {
  it('returns spliceOps + preservedAnchors with via:"splice" labels', () => {
    const t = 'pre brown post\n';
    const m = 'pre red post\n';
    const fd = flatDoc(t);
    const out = preserveCommentAnchors(
      m, t,
      [{ commentId: 'c1', quotedText: 'brown' }],
      fd.indexMap, fd.bodyEndIndex,
    );
    expect(out.spliceOps.length).toBe(1);
    expect(out.spliceOps[0].newText).toBe('red');
    expect(out.preservedAnchors).toEqual([{ quotedText: 'brown', via: 'splice' }]);
    // mergedMarkdown is left untouched in splice mode (the splice op
    // carries the rewrite) — caller still issues main batch + splice.
    expect(out.mergedMarkdown).toBe(m);
  });

  it('reverts an ineligible (1-char) anchor and labels via:"revert"', () => {
    const t = 'X is a marker\n';
    const m = 'Y is a marker\n';
    const fd = flatDoc(t);
    const out = preserveCommentAnchors(
      m, t,
      [{ commentId: 'c1', quotedText: 'X' }],
      fd.indexMap, fd.bodyEndIndex,
    );
    expect(out.spliceOps).toEqual([]);
    expect(out.preservedAnchors).toEqual([{ quotedText: 'X', via: 'revert' }]);
    // Revert path: merged result is reverted to theirs.
    expect(out.mergedMarkdown).toContain('X is a marker');
  });

  it('leaves untouched anchors out of preservedAnchors', () => {
    const t = 'pre stable\n\n# Section\n\nedited later\n';
    const m = 'pre stable\n\n# Section\n\nrewritten later\n';
    const fd = flatDoc(t);
    const out = preserveCommentAnchors(
      m, t,
      [{ commentId: 'c1', quotedText: 'stable' }],
      fd.indexMap, fd.bodyEndIndex,
    );
    expect(out.preservedAnchors).toEqual([]);
    expect(out.spliceOps).toEqual([]);
    expect(out.mergedMarkdown).toBe(m);
  });
});
