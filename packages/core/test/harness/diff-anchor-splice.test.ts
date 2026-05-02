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

  // Reproduces an e2e-CA13 failure: a splice op for an anchor whose
  // first character is a multi-code-unit emoji (UTF-16 surrogate
  // pair) ends up with a `currentRange` whose length is one MORE
  // than the anchor's UTF-16 code-unit count. Downstream trim
  // arithmetic then shifts by +1 too, and `splicePoint = start + 1`
  // lands BETWEEN the two surrogates of the emoji — Drive then
  // either rejects the insertText or the subsequent locate fails.
  // Reproduces an e2e CA13 failure: Drive's batchUpdate rejects an
  // insertText whose location is INSIDE a grapheme cluster (e.g.
  // between the two UTF-16 code units of an emoji surrogate pair).
  // splicePoint = startIndex + 1 used to land between the high and
  // low surrogate of a leading 🤖. Drive returns
  // "Invalid requests[0].insertText: The insertion index cannot be
  // within a grapheme cluster." and the splice exec skips. Fix:
  // splicePoint must skip the leading grapheme cluster of the anchor.
  // Reproduces e2e CA8: when a section contains MULTIPLE
  // structurally-similar paragraphs and TWO of them are anchored
  // and being edited, findReplacement's section-level context
  // matching can't disambiguate which paragraph is which (every
  // ctxBefore window like "instruction.\n\n" appears multiple times
  // in the section). Both anchors fall to revert and neither edit
  // lands. A paragraph-aware findReplacement should handle this:
  // split section into paragraphs, pair by position, then
  // context-match within just one paragraph.
  // Reproduces e2e CA14: agent splits a single anchored paragraph
  // into two by introducing a `\n\n` paragraph break inside the
  // newText. Section-level extractBetween then matches against the
  // FIRST `\n\n` it finds in the merged section, which is the new
  // paragraph break the agent introduced — so newText comes back
  // truncated to "first half only" and the agent's intent is
  // silently dropped. Conservative fix: treat this as
  // 'multi-edit-section' and let revert/main-batch handle the
  // structural change. The agent's split won't happen, but the
  // anchor stays alive.
  it('does not silently truncate newText when the agent splits the anchored paragraph in two', () => {
    // Mirrors the e2e CA14 layout: anchored paragraph is the LAST
    // paragraph of its heading section (no body content after it
    // in the same section). Section-level extractBetween finds the
    // FIRST `\n\n` it can in the merged side, which happens to be
    // the new paragraph break the agent introduced — so it
    // silently returns just the first half.
    const t = `# CA14
\n> instruction blockquote.\n\nThe sentence to split.\n\n# Next\n\nLater section body.\n`;
    const m = t.replace(
      'The sentence to split.',
      'The sentence has been split.\n\nInto two parts now.',
    );
    const fd = flatDoc(t);
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'The sentence to split.' },
      theirs: t,
      mergedMarkdown: m,
      indexMap: fd.indexMap,
      bodyEndIndex: fd.bodyEndIndex,
    });
    // Either ineligible (preferred — falls back to revert), or a
    // splice with newText that captures BOTH split paragraphs.
    // What's NOT acceptable is a splice whose newText is just
    // "The sentence has been split." (truncated to the first half).
    if ('ineligible' in out) {
      expect(out.ineligible).toBe('multi-edit-section');
    } else {
      expect(out.newText).toContain('Into two parts now.');
    }
  });

  // KNOWN LIMITATION (e2e CA15): an anchor whose plain text spans
  // inline markdown markers (bold/italic/code/link) doesn't match
  // `theirs` because indexOf is literal. Drive returns the comment's
  // `quotedFileContent` as plain text without markers, but `theirs`
  // (markdown) has the markers. The planner classifies as
  // 'anchor-not-in-current-doc' → revert; meanwhile the main batch
  // line-diffs the bold-styled paragraph and rewrites it via
  // delete+insert, which orphans the comment on Drive. Proper fix
  // is non-trivial: anchor matching needs to either (a) work
  // against the doc body (no markers) instead of markdown, or
  // (b) use a position-mapped strip that preserves bold-run
  // boundaries through the splice. Deferred.
  it('returns ineligible when the anchor spans inline markdown markers (current limitation)', () => {
    const t = 'Sentence with an **important** word in it.\n';
    const m = 'Sentence with an **critical** word in it.\n';
    const fd = flatDoc(t);
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: 'an important word' },
      theirs: t,
      mergedMarkdown: m,
      indexMap: fd.indexMap,
      bodyEndIndex: fd.bodyEndIndex,
    });
    expect('ineligible' in out && out.ineligible).toBe('anchor-not-in-current-doc');
  });

  it('finds replacements when a section has two anchored sibling paragraphs', () => {
    // Mirror the e2e CA8 fixture: each anchored body sentence is
    // preceded by a same-shaped instruction blockquote, so the
    // section-level context windows ("instruction.\n\n",
    // "comment.\n\n", etc.) appear MULTIPLE times in the section.
    // Section-level findReplacement can't disambiguate.
    const t =
      '# CA8 — two anchors in the same section\n\n' +
      '> **Action [pair-a]:** highlight the FIRST body sentence and add a comment.\n\n' +
      'First pair sentence here.\n\n' +
      '> **Action [pair-b]:** highlight the SECOND body sentence and add a comment.\n\n' +
      'Second pair sentence here.\n';
    const m = t
      .replace('First pair sentence here.', 'First pair sentence rewritten.')
      .replace('Second pair sentence here.', 'Second pair sentence rewritten.');
    const fd = flatDoc(t);

    const outA = tryBuildSpliceOp({
      anchor: { commentId: 'a', quotedText: 'First pair sentence here.' },
      theirs: t, mergedMarkdown: m, indexMap: fd.indexMap, bodyEndIndex: fd.bodyEndIndex,
    });
    const outB = tryBuildSpliceOp({
      anchor: { commentId: 'b', quotedText: 'Second pair sentence here.' },
      theirs: t, mergedMarkdown: m, indexMap: fd.indexMap, bodyEndIndex: fd.bodyEndIndex,
    });
    if ('ineligible' in outA) {
      throw new Error(`expected pair-a splice, got ineligible: ${outA.ineligible}`);
    }
    if ('ineligible' in outB) {
      throw new Error(`expected pair-b splice, got ineligible: ${outB.ineligible}`);
    }
    expect(outA.newText).toBe('First pair sentence rewritten.');
    expect(outB.newText).toBe('Second pair sentence rewritten.');
  });

  it('places splicePoint AFTER the leading grapheme when the anchor begins with a surrogate-pair emoji', () => {
    // anchor "🤖 happy" — 🤖 is two code units (a surrogate pair).
    // splicePoint must be >= startIndex + 2, not startIndex + 1.
    const t = 'pre.\n\n🤖 happy bot says hello.\n\nsuffix.\n';
    const m = 'pre.\n\n🤖 cheerful bot says hello.\n\nsuffix.\n';
    const fd = flatDoc(t);
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: '🤖 happy bot says hello.' },
      theirs: t,
      mergedMarkdown: m,
      indexMap: fd.indexMap,
      bodyEndIndex: fd.bodyEndIndex,
    });
    if ('ineligible' in out) throw new Error(`expected splice, got ineligible: ${out.ineligible}`);
    // Splice point must NOT land inside the surrogate pair. Since
    // the leading codepoint 🤖 is 2 UTF-16 code units, the earliest
    // valid splice point is startIndex + 2.
    expect(out.splicePoint).toBeGreaterThanOrEqual(out.currentRange.startIndex + 2);
    // And the leading trim must cover those same 2 code units (not
    // 1) so step 2 deletes the whole emoji rather than leaving a
    // dangling surrogate.
    const leadingTrim = out.trimRanges[out.trimRanges.length - 1];
    expect(leadingTrim.startIndex).toBe(out.currentRange.startIndex);
    expect(leadingTrim.endIndex - leadingTrim.startIndex).toBeGreaterThanOrEqual(2);
  });

  it('produces a currentRange whose length matches the anchor in code units (emoji prefix)', () => {
    // Section needs some leading context so findReplacement can pick
    // a unique alignment marker; the anchor itself starts at the
    // first emoji.
    const t = 'pre.\n\n🤖 happy bot says hello.\n\nsuffix.\n';
    const m = 'pre.\n\n🤖 cheerful bot says hello.\n\nsuffix.\n';
    const fd = flatDoc(t);
    const anchor = '🤖 happy bot says hello.';
    const out = tryBuildSpliceOp({
      anchor: { commentId: 'c1', quotedText: anchor },
      theirs: t,
      mergedMarkdown: m,
      indexMap: fd.indexMap,
      bodyEndIndex: fd.bodyEndIndex,
    });
    if ('ineligible' in out) throw new Error(`expected splice, got ineligible: ${out.ineligible}`);
    // The currentRange must span exactly anchor.length code units.
    // Off-by-one here causes the trim ranges to read past the end of
    // the anchored span, which the splice exec catches by skipping.
    const observedLen = out.currentRange.endIndex - out.currentRange.startIndex;
    expect(observedLen).toBe(anchor.length);
    // splicePoint must skip past the leading grapheme (the 🤖
    // surrogate pair = 2 code units). Inserting at startIndex + 1
    // would land between the two surrogates of the emoji and Drive
    // would reject the batch with "The insertion index cannot be
    // within a grapheme cluster."
    expect(out.splicePoint).toBe(out.currentRange.startIndex + 2);
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
    // mergedMarkdown is reverted to theirs for the section holding the
    // splice anchor: the section-diff sees no change there and emits
    // no main-batch requests, so Drive doesn't orphan the anchor by
    // deleting its underlying span. The splice op runs after and
    // performs the rewrite via insert+trim, which never deletes the
    // whole anchor in a single batch.
    expect(out.mergedMarkdown).toBe(t);
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

  // Reproduces an e2e failure mode: when the anchor's quotedText
  // appears MULTIPLE TIMES in `theirs` (e.g. once in an instruction
  // blockquote and once in the actual body line that the user
  // anchored on), and the body occurrence is edited, the planner
  // should NOT classify the anchor as noop just because some other
  // occurrence still survives in merged. Doing so silently drops
  // the splice/revert outcome and leaves the comment exposed to
  // orphaning.
  it('does not falsely classify a multi-occurrence anchor as noop when one occurrence is edited', () => {
    // Anchor text appears in an instructional blockquote AND in the
    // body line. The agent edits ONLY the body line (e.g. inside a
    // table row / heading). Naïve noop check would say "unchanged"
    // because both `theirs` and `merged` contain the text — the
    // instruction occurrence was untouched. But the body occurrence
    // (where Drive's anchor is bound) WAS edited.
    const t = '> highlight TARGETED in the body below.\n\n| TARGETED | other |\n';
    const m = '> highlight TARGETED in the body below.\n\n| EDITED | other |\n';
    const fd = flatDoc(t);
    const out = preserveCommentAnchors(
      m, t,
      [{ commentId: 'c1', quotedText: 'TARGETED' }],
      fd.indexMap, fd.bodyEndIndex,
    );
    // The planner can't safely splice (ambiguous which TARGETED is
    // the bound one) and can't claim noop. Expected outcome: revert
    // via 'multiple-anchor-occurrences' falling through to revert.
    expect(out.preservedAnchors.length).toBe(1);
    expect(out.preservedAnchors[0].quotedText).toBe('TARGETED');
    // We don't pin via to splice or revert — the planner's job is
    // to NOT silently accept the edit. A revert is the safe outcome.
    expect(['revert', 'splice']).toContain(out.preservedAnchors[0].via);
  });

  it('still classifies a single-occurrence anchor as noop when truly unchanged', () => {
    // Sanity check the fix doesn't regress the simple case: anchor
    // text occurs once in theirs, still occurs once in merged after
    // an unrelated edit elsewhere.
    const t = 'Stable line.\n\nEditable line.\n';
    const m = 'Stable line.\n\nModified line.\n';
    const fd = flatDoc(t);
    const out = preserveCommentAnchors(
      m, t,
      [{ commentId: 'c1', quotedText: 'Stable line.' }],
      fd.indexMap, fd.bodyEndIndex,
    );
    expect(out.preservedAnchors).toEqual([]);
    expect(out.spliceOps).toEqual([]);
  });
});
