/**
 * Anchor splice mode for `preserveCommentAnchors` (design doc §3.7.1).
 *
 * Goal: let agent edits rewrite a passage someone is commenting on
 * without orphaning the comment. Drive comments anchor on a body-index
 * range and survive any `batchUpdate` that doesn't fully delete that
 * range in a single call. Splice mode replaces the anchor's content in
 * two sequential `batchUpdate` calls:
 *
 *   1. Insert the new text just inside the anchor (after the first
 *      char), so the anchor expands to `oldPrefix + newText + oldSuffix`.
 *   2. Delete the leading `oldPrefix` and trailing `oldSuffix` ranges,
 *      shrinking the anchor down to exactly `newText`.
 *
 * Step 2 only deletes from the edges, never the whole range, so the
 * comment thread, author, and resolution state stay attached to the
 * rewritten span.
 *
 * This module owns the *computation* (eligibility + index math). The
 * actual two-step execution and restore-on-failure path live in
 * `orchestrator.ts`'s `executeAnchorSpliceOps` so the diff layer stays
 * pure.
 */

import { interpolateDocIndex } from './diff.js';
import type { IndexMapEntry } from '../converter/element-parser.js';
import { parseSections, type MdSection } from './diff.js';

/**
 * Minimum anchor length (in markdown chars) eligible for splice. With
 * fewer than 2 chars there's no interior splice point that leaves at
 * least one char on each side, so we fall back to revert.
 */
export const MIN_SPLICE_LEN = 2;

/** A single splice operation the orchestrator should execute. */
export interface AnchorSpliceOp {
  /** Drive comment id whose anchor is being preserved. */
  commentId: string;
  /**
   * Doc-body range covering the anchor BEFORE step 1 runs. Used by the
   * orchestrator to verify the range still resolves to the same text
   * before issuing requests, and to compute the restore payload if
   * step 2 fails.
   */
  currentRange: { startIndex: number; endIndex: number };
  /** Replacement text to place inside the anchor. Always non-empty. */
  newText: string;
  /** The text the anchor currently covers — needed for restore-on-failure. */
  oldText: string;
  /**
   * Body index where step 1 inserts `newText`. Always lies strictly
   * inside `currentRange` (never at the edge), so the anchor expands
   * rather than ambiguously growing into adjacent content.
   */
  splicePoint: number;
  /**
   * Ranges to delete in step 2. Already adjusted for the offset shift
   * caused by step 1's insertion, and ordered descending by startIndex
   * so applying them in order doesn't invalidate later ranges.
   */
  trimRanges: Array<{ startIndex: number; endIndex: number }>;
}

/** A comment whose anchor we want to preserve. */
export interface CommentAnchor {
  commentId: string;
  /** The `quotedText` value from the Drive comment. */
  quotedText: string;
}

/** Outcome describing what happened to a single anchor. */
export type AnchorOutcome =
  | { kind: 'splice'; op: AnchorSpliceOp; quotedText: string }
  | { kind: 'revert'; quotedText: string; reason: SpliceIneligibilityReason }
  | { kind: 'noop'; quotedText: string };

export type SpliceIneligibilityReason =
  | 'anchor-too-short'
  | 'anchor-empty'
  | 'replacement-empty'
  | 'multiple-anchor-occurrences'
  | 'anchor-not-in-current-doc'
  | 'multi-edit-section'
  | 'structural-boundary-cross'
  | 'overlapping-anchor';

/**
 * Try to build a splice op for one anchor. Returns null when the anchor
 * is ineligible — caller falls back to revert in that case.
 *
 * Eligibility rules (from §3.7.1):
 *   - anchor span >= MIN_SPLICE_LEN (so an interior splice point exists)
 *   - anchor appears exactly once in `theirs` (no ambiguity)
 *   - the merged section that contained the anchor produces a single,
 *     non-empty replacement string for the anchor (no anchor-crossing
 *     structural moves, no full deletion)
 */
export function tryBuildSpliceOp(args: {
  anchor: CommentAnchor;
  theirs: string;
  mergedMarkdown: string;
  indexMap: IndexMapEntry[];
  /** End-of-body fallback for index interpolation. */
  bodyEndIndex: number;
}): AnchorSpliceOp | { ineligible: SpliceIneligibilityReason } {
  const { anchor, theirs, mergedMarkdown, indexMap, bodyEndIndex } = args;
  const quoted = anchor.quotedText;

  if (!quoted || quoted.length === 0) return { ineligible: 'anchor-empty' };
  if (quoted.length < MIN_SPLICE_LEN) return { ineligible: 'anchor-too-short' };

  const firstHit = theirs.indexOf(quoted);
  if (firstHit < 0) return { ineligible: 'anchor-not-in-current-doc' };
  const secondHit = theirs.indexOf(quoted, firstHit + 1);
  if (secondHit >= 0) return { ineligible: 'multiple-anchor-occurrences' };

  // Structural-boundary check happens before content matching: a
  // heading-crossing anchor is structurally ineligible regardless of
  // whether the merged side has a clean replacement.
  if (crossesStructuralBoundary(theirs, firstHit, firstHit + quoted.length)) {
    return { ineligible: 'structural-boundary-cross' };
  }

  const newText = findReplacement(theirs, mergedMarkdown, firstHit, quoted);
  if (newText == null) return { ineligible: 'multi-edit-section' };
  if (newText.length === 0) return { ineligible: 'replacement-empty' };
  // Same text on both sides — no edit, no need to splice.
  if (newText === quoted) return { ineligible: 'replacement-empty' };

  // Map markdown offsets → doc body indices.
  const startIndex = interpolateDocIndex(firstHit, indexMap, bodyEndIndex);
  const endIndex = interpolateDocIndex(firstHit + quoted.length, indexMap, bodyEndIndex);

  if (endIndex - startIndex < MIN_SPLICE_LEN) {
    // Index map collapsed the anchor (e.g. mostly markdown punctuation
    // that doesn't appear in the body). Fall back rather than splicing
    // a degenerate range.
    return { ineligible: 'anchor-too-short' };
  }

  // Default splice point: just after the first GRAPHEME of the
  // anchor. Going just one code unit in is unsafe when the anchor
  // begins with a multi-code-unit grapheme (most commonly a UTF-16
  // surrogate-pair emoji like 🤖, but also variation selectors and
  // ZWJ-glued sequences). Drive's batchUpdate rejects insertText
  // whose location lands inside a grapheme cluster — observed as
  // "Invalid requests[0].insertText: The insertion index cannot be
  // within a grapheme cluster." — so the splice exec would skip
  // and the comment would orphan.
  const leadingGraphemeLen = leadingGraphemeCodeUnitLength(quoted);
  const splicePoint = startIndex + leadingGraphemeLen;
  // After advancing past the leading grapheme, ensure there's still
  // at least one code unit of suffix to keep the anchor inside the
  // remaining old text. Anchors that consist of a SINGLE grapheme
  // (e.g. just "🤖") can't be spliced safely — caller falls back to
  // revert.
  if (splicePoint >= endIndex) {
    return { ineligible: 'anchor-too-short' };
  }

  // Step 2 indices live in post-step-1 space.
  // After inserting `newText` at splicePoint:
  //   leading prefix: [startIndex, splicePoint)             (the leading grapheme)
  //   newText:        [splicePoint, splicePoint + newText.length)
  //   trailing:       [splicePoint + newText.length, endIndex + newText.length)
  const newLen = newText.length;
  const leadingTrim = { startIndex, endIndex: splicePoint };
  const trailingStart = splicePoint + newLen;
  const trailingEnd = endIndex + newLen;
  const trailingTrim = trailingStart < trailingEnd
    ? { startIndex: trailingStart, endIndex: trailingEnd }
    : null;

  // Descending by startIndex so applying them in order doesn't shift
  // earlier ranges.
  const trimRanges = trailingTrim
    ? [trailingTrim, leadingTrim]
    : [leadingTrim];

  return {
    commentId: anchor.commentId,
    currentRange: { startIndex, endIndex },
    newText,
    oldText: quoted,
    splicePoint,
    trimRanges,
  };
}

/**
 * Plan splice/revert outcomes for every anchor on a doc. Anchors that
 * overlap (two comments on the same rewritten span) are resolved per
 * §3.7.1: the wider one splices, the narrower one reverts.
 */
export function planAnchorOutcomes(args: {
  anchors: CommentAnchor[];
  theirs: string;
  mergedMarkdown: string;
  indexMap: IndexMapEntry[];
  bodyEndIndex: number;
}): AnchorOutcome[] {
  const { anchors, theirs, mergedMarkdown, indexMap, bodyEndIndex } = args;
  const outcomes: AnchorOutcome[] = [];

  // First pass: for each anchor decide splice / revert / noop independently.
  for (const a of anchors) {
    if (!a.quotedText) {
      outcomes.push({ kind: 'noop', quotedText: a.quotedText ?? '' });
      continue;
    }
    // No-op: anchor text appears UNIQUELY unchanged in both sides.
    // The single-occurrence requirement is critical — when the
    // anchor text appears more than once in `theirs` (e.g. one copy
    // in an instructional preface and another in the actual body
    // line that holds the comment), the agent may have edited the
    // body occurrence while leaving the preface alone. A naïve
    // "both sides contain it" check would then incorrectly call
    // this a noop and silently drop the splice/revert that should
    // have fired. tryBuildSpliceOp's ambiguity detection handles
    // the multi-occurrence case via 'multiple-anchor-occurrences'.
    const inTheirs = countOccurrences(theirs, a.quotedText);
    const inMerged = countOccurrences(mergedMarkdown, a.quotedText);
    if (inTheirs === 1 && inMerged === 1) {
      outcomes.push({ kind: 'noop', quotedText: a.quotedText });
      continue;
    }
    const tried = tryBuildSpliceOp({
      anchor: a, theirs, mergedMarkdown, indexMap, bodyEndIndex,
    });
    if ('ineligible' in tried) {
      outcomes.push({ kind: 'revert', quotedText: a.quotedText, reason: tried.ineligible });
    } else {
      outcomes.push({ kind: 'splice', op: tried, quotedText: a.quotedText });
    }
  }

  // Second pass: resolve overlap. If two splice ops cover overlapping
  // body-index ranges, keep the wider one and downgrade the narrower
  // to revert. (Per §3.7.1 out-of-scope note.)
  const splices = outcomes
    .map((o, i) => ({ o, i }))
    .filter((x): x is { o: Extract<AnchorOutcome, { kind: 'splice' }>; i: number } => x.o.kind === 'splice');
  for (let a = 0; a < splices.length; a++) {
    for (let b = a + 1; b < splices.length; b++) {
      const oa = splices[a].o.op.currentRange;
      const ob = splices[b].o.op.currentRange;
      const overlap = Math.max(oa.startIndex, ob.startIndex) < Math.min(oa.endIndex, ob.endIndex);
      if (!overlap) continue;
      const wa = oa.endIndex - oa.startIndex;
      const wb = ob.endIndex - ob.startIndex;
      const loser = wa >= wb ? splices[b] : splices[a];
      outcomes[loser.i] = {
        kind: 'revert',
        quotedText: loser.o.quotedText,
        reason: 'overlapping-anchor',
      };
    }
  }

  return outcomes;
}

/**
 * Locate the merged-side replacement for an anchor that's been edited.
 *
 * Strategy: find which `theirs` section the anchor lived in, look up
 * the merged-side counterpart of that section by heading position, and
 * align the surrounding context to extract the replacement substring.
 *
 * Returns null if the section can't be matched, or if the anchor's
 * surrounding context is too garbled to extract a single contiguous
 * replacement (e.g. the prefix or suffix vanished, or the section was
 * deleted entirely — those paths fall back to revert).
 */
function findReplacement(
  theirs: string,
  mergedMarkdown: string,
  anchorOffsetInTheirs: number,
  anchorText: string,
): string | null {
  const theirsSections = parseSections(theirs);
  const mergedSections = parseSections(mergedMarkdown);
  const sec = locateSection(theirsSections, theirs, anchorOffsetInTheirs);
  if (!sec) return null;

  const counterpart = matchMergedCounterpart(theirsSections, mergedSections, sec);
  if (!counterpart) return null; // Section was deleted — revert handles this.

  // Find the anchor's paragraph within the section. parseSections
  // returns one MdSection per heading; within a section the body is
  // typically multiple `\n\n`-separated paragraphs (an instruction
  // blockquote, a list, the actual sentence the anchor sits on). We
  // narrow the context-match to JUST the anchor's paragraph rather
  // than the whole section — section-level windows like
  // "instruction.\n\n" repeat across sibling paragraphs and the
  // top-level extractBetween then can't disambiguate which copy
  // bounds the anchor.
  const sectionStart = sec.startOffset;
  const anchorStartInSection = anchorOffsetInTheirs - sectionStart;
  const theirsParas = splitParagraphsWithOffsets(sec.content);
  const mergedParas = splitParagraphsWithOffsets(counterpart.content);
  const theirsParaIdx = theirsParas.findIndex(
    (p) => anchorStartInSection >= p.start && anchorStartInSection < p.start + p.text.length,
  );
  // When the agent rewrote the anchored paragraph into MORE
  // paragraphs (introduced a `\n\n` paragraph break inside the
  // newText), bail to revert. Section-level extractBetween would
  // otherwise treat the new paragraph break as the after-anchor
  // alignment marker and silently return only the FIRST half of
  // the agent's split — losing the second paragraph entirely.
  // The conservative outcome is to revert: keep the anchor's
  // original paragraph, drop the agent's structural split.
  if (
    theirsParaIdx >= 0 &&
    mergedParas.length > theirsParas.length &&
    anchorText === theirsParas[theirsParaIdx].text.replace(/\s+$/, '')
  ) {
    return null;
  }
  if (theirsParaIdx >= 0 && theirsParas.length === mergedParas.length) {
    // Trim trailing whitespace from the matched paragraphs — the
    // last paragraph in a section often carries a single trailing
    // \n that's NOT a paragraph separator (`\n\n+`) but isn't part
    // of the body text the anchor covers. Without trimming, the
    // whole-paragraph match below misses on the very last
    // paragraph of a section.
    const theirsParaText = theirsParas[theirsParaIdx].text.replace(/\s+$/, '');
    const mergedParaText = mergedParas[theirsParaIdx].text.replace(/\s+$/, '');
    const anchorOffsetInPara = anchorStartInSection - theirsParas[theirsParaIdx].start;
    // Whole-paragraph anchor: the merged paragraph IS the
    // replacement, no context-search needed. Common case for
    // sentence-level anchors.
    if (anchorOffsetInPara === 0 && anchorText === theirsParaText) {
      return mergedParaText;
    }
    // Sub-paragraph anchor: align by context within just this
    // paragraph (much smaller search space than the whole section).
    // Each side that's empty (anchor at the very start or very end
    // of the paragraph) anchors against the paragraph boundary
    // instead of needing a context window — that's what the
    // edge-aware extractBetween branches handle.
    const before = theirsParaText.slice(0, anchorOffsetInPara);
    const after = theirsParaText.slice(anchorOffsetInPara + anchorText.length);
    for (const ctxLen of [16, 8, 4, 2, 1]) {
      const ctxBefore = before.slice(Math.max(0, before.length - ctxLen));
      const ctxAfter = after.slice(0, ctxLen);
      // If both sides happen to have no context, that's the
      // whole-paragraph case already handled above; skip.
      if (ctxBefore.length === 0 && ctxAfter.length === 0) continue;
      const replacement = extractBetweenInParagraph(
        mergedParaText, ctxBefore, ctxAfter,
        before.length === 0,
        after.length === 0,
      );
      if (replacement !== null) return replacement;
    }
    // No paragraph-level match. Fall through to the section-level
    // strategy below — the paragraph counts could be the same by
    // coincidence rather than because of a clean rewrite.
  }

  // Section-level fallback (legacy strategy). Used when the
  // paragraph counts diverge or paragraph-level alignment didn't
  // succeed. Try progressively shorter contexts; long contexts are
  // selective but easily contain unrelated edits, short ones risk
  // ambiguity. Accept the first size where both sides match uniquely.
  const sectionContent = sec.content;
  const before = sectionContent.slice(0, anchorStartInSection);
  const after = sectionContent.slice(anchorStartInSection + anchorText.length);

  for (const ctxLen of [16, 8, 4, 2, 1]) {
    const ctxBefore = before.slice(Math.max(0, before.length - ctxLen));
    const ctxAfter = after.slice(0, ctxLen);
    if (ctxBefore.length === 0 || ctxAfter.length === 0) continue;
    const replacement = extractBetween(counterpart.content, ctxBefore, ctxAfter);
    if (replacement !== null) return replacement;
  }
  return null;
}

/**
 * Split a markdown chunk into paragraphs by blank-line separators
 * (`\n\n` or longer runs of newlines). Returns each paragraph's
 * offset within the chunk so callers can map a char offset back to
 * a paragraph index without re-walking. The offset is the start of
 * the paragraph's body text — separator runs are NOT included in
 * any paragraph's offset/text. Trailing/leading empty paragraphs
 * are skipped.
 */
function splitParagraphsWithOffsets(
  content: string,
): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  const sepRe = /\n\n+/g;
  let cursor = 0;
  for (let m = sepRe.exec(content); m; m = sepRe.exec(content)) {
    const text = content.slice(cursor, m.index);
    if (text.length > 0) out.push({ start: cursor, text });
    cursor = m.index + m[0].length;
  }
  const tail = content.slice(cursor);
  if (tail.length > 0) out.push({ start: cursor, text: tail });
  return out;
}

/**
 * Paragraph-aware extractBetween. Identical to the section-level
 * version when both `before` and `after` are non-empty, but with
 * extra branches for the edge cases:
 *
 *   - Anchor sits at the START of its paragraph (`anchorAtStart`):
 *     `before` is empty and we can't match it. The replacement is
 *     everything in `text` UP TO the unique occurrence of `after`.
 *   - Anchor sits at the END of its paragraph (`anchorAtEnd`):
 *     `after` is empty. Replacement runs from the end of the unique
 *     `before` occurrence to the end of `text`.
 *
 * When neither edge applies the function delegates to `extractBetween`.
 */
function extractBetweenInParagraph(
  text: string,
  before: string,
  after: string,
  anchorAtStart: boolean,
  anchorAtEnd: boolean,
): string | null {
  if (anchorAtStart && anchorAtEnd) {
    // Whole-paragraph anchor — caller handles this case directly.
    return text;
  }
  if (anchorAtStart) {
    if (after.length === 0) return null;
    const afterIdx = text.indexOf(after);
    if (afterIdx < 0) return null;
    if (text.indexOf(after, afterIdx + 1) >= 0) return null;
    return text.slice(0, afterIdx);
  }
  if (anchorAtEnd) {
    if (before.length === 0) return null;
    const firstBefore = text.indexOf(before);
    if (firstBefore < 0) return null;
    if (text.indexOf(before, firstBefore + 1) >= 0) return null;
    return text.slice(firstBefore + before.length);
  }
  return extractBetween(text, before, after);
}

/**
 * Find the substring of `text` that lies between the unique occurrence
 * of `before` (rightmost-anchored) and the next occurrence of `after`.
 * Returns null when either marker is absent or ambiguous in a way that
 * leaves the bracket unresolvable.
 */
function extractBetween(text: string, before: string, after: string): string | null {
  // `before` must occur exactly once. If it occurs multiple times we
  // can't tell which one bounds the replacement.
  const firstBefore = text.indexOf(before);
  if (firstBefore < 0) return null;
  const secondBefore = text.indexOf(before, firstBefore + 1);
  if (secondBefore >= 0) return null;
  const afterStart = firstBefore + before.length;
  const afterIdx = text.indexOf(after, afterStart);
  if (afterIdx < 0) return null;
  return text.slice(afterStart, afterIdx);
}

interface SectionLoc {
  startOffset: number;
  content: string;
  index: number;
}

function locateSection(
  sections: MdSection[],
  full: string,
  charOffset: number,
): SectionLoc | null {
  // parseSections doesn't track byte offsets directly; reconstruct them
  // by walking the joined output the same way mergeDocuments does.
  let cursor = 0;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const at = full.indexOf(sec.content, cursor);
    if (at < 0) continue;
    const end = at + sec.content.length;
    if (charOffset >= at && charOffset < end) {
      return { startOffset: at, content: sec.content, index: i };
    }
    cursor = end;
  }
  return null;
}

/** Match a `theirs` section to its counterpart in the merged output.
 *
 * Pairing strategy, in order of preference:
 *   1. Same heading text at the same positional index.
 *   2. First section in merged with the same heading text.
 *   3. Positional fallback: same index, regardless of heading text.
 *      Needed when the agent's edit RENAMES the heading itself —
 *      heading-text equality fails but the section is still the
 *      same one positionally, and `findReplacement` can recover the
 *      new heading text from the surrounding context.
 *   4. If both sides have exactly one same-length section list, the
 *      positional index is unambiguous and (3) is reliable. If the
 *      lengths differ, fall through to null — the structural
 *      change (insert/delete of a section) is too ambiguous for a
 *      surgical splice.
 */
function matchMergedCounterpart(
  theirsSections: MdSection[],
  mergedSections: MdSection[],
  sec: SectionLoc,
): MdSection | null {
  const target = theirsSections[sec.index];
  if (!target) return null;
  if (
    mergedSections[sec.index] &&
    mergedSections[sec.index].heading === target.heading
  ) {
    return mergedSections[sec.index];
  }
  const sameHeading = mergedSections.find((s) => s.heading === target.heading);
  if (sameHeading) return sameHeading;
  // Positional fallback for the heading-rename case. Only safe when
  // the section count is the same on both sides — different counts
  // imply a section was inserted or deleted, and positional index
  // alone can't disambiguate which counterpart is "the same one".
  if (
    mergedSections.length === theirsSections.length &&
    mergedSections[sec.index]
  ) {
    return mergedSections[sec.index];
  }
  return null;
}

/**
 * Length, in UTF-16 code units, of the first grapheme cluster of
 * `s`. Drive's batchUpdate `insertText` rejects locations that fall
 * inside a grapheme cluster — surrogate pair, base + variation
 * selector, base + combining marks, ZWJ-glued emoji sequence — so
 * the splice point has to advance past the entire leading grapheme
 * before inserting `newText`.
 *
 * Uses `Intl.Segmenter` when available (Node 16+, all modern
 * browsers); falls back to detecting just UTF-16 surrogate pairs,
 * which covers the most common case (single-codepoint emoji) but
 * misses combining marks and ZWJ sequences. The fallback exists
 * defensively — every supported runtime ships Intl.Segmenter.
 */
function leadingGraphemeCodeUnitLength(s: string): number {
  if (s.length === 0) return 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Seg = (Intl as any).Segmenter;
    if (typeof Seg === 'function') {
      const seg = new Seg(undefined, { granularity: 'grapheme' });
      const it = seg.segment(s)[Symbol.iterator]();
      const first = it.next();
      if (!first.done && first.value && typeof first.value.segment === 'string') {
        return first.value.segment.length;
      }
    }
  } catch {
    // Fall through to surrogate-pair fallback.
  }
  const c = s.charCodeAt(0);
  if (c >= 0xD800 && c <= 0xDBFF && s.length >= 2) {
    const c2 = s.charCodeAt(1);
    if (c2 >= 0xDC00 && c2 <= 0xDFFF) return 2;
  }
  return 1;
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Returns 0 for an empty needle (defensive — the noop check would
 * otherwise loop forever and the caller already filters empty
 * anchors upstream).
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const hit = haystack.indexOf(needle, from);
    if (hit < 0) return count;
    count += 1;
    from = hit + needle.length;
  }
}

/**
 * Returns true if the anchor straddles a heading or other structural
 * boundary inside `theirs`. Splice mode bails on those (Drive's range
 * model treats list/heading boundary moves as structural and behavior
 * is under-specified).
 */
function crossesStructuralBoundary(
  text: string,
  start: number,
  end: number,
): boolean {
  const slice = text.slice(start, end);
  // A heading line inside the anchor → structural cross.
  return /(^|\n)#{1,6}\s/.test(slice);
}
