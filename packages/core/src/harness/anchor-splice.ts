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

  // Default splice point: just after the first character of the anchor.
  // This leaves >= 1 char on each side so the anchor cannot collapse to
  // a single edge point.
  const splicePoint = startIndex + 1;

  // Step 2 indices live in post-step-1 space.
  // After inserting `newText` at splicePoint:
  //   leading prefix: [startIndex, startIndex + 1]   (1 char of oldText)
  //   newText:        [startIndex + 1, startIndex + 1 + newText.length]
  //   trailing:       [startIndex + 1 + newText.length, endIndex + newText.length]
  const newLen = newText.length;
  const leadingTrim = { startIndex, endIndex: startIndex + 1 };
  const trailingStart = startIndex + 1 + newLen;
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
    // No-op: anchor text appears unchanged in the merged result, no
    // edit overlaps it. Don't splice, don't revert, don't log.
    if (theirs.includes(a.quotedText) && mergedMarkdown.includes(a.quotedText)) {
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

  // Within the section, find anchor by offset and look up an
  // alignment context on each side. Try progressively shorter
  // contexts: a long context is more selective but more likely to
  // contain unrelated edits and miss; a short context risks ambiguity.
  // We accept the first size where both sides match uniquely.
  const sectionStart = sec.startOffset;
  const anchorStartInSection = anchorOffsetInTheirs - sectionStart;
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

/** Match a `theirs` section to its counterpart in the merged output. */
function matchMergedCounterpart(
  theirsSections: MdSection[],
  mergedSections: MdSection[],
  sec: SectionLoc,
): MdSection | null {
  const target = theirsSections[sec.index];
  if (!target) return null;
  // Prefer same-heading match at the same positional index. Fall back
  // to first same-heading match.
  if (
    mergedSections[sec.index] &&
    mergedSections[sec.index].heading === target.heading
  ) {
    return mergedSections[sec.index];
  }
  return mergedSections.find((s) => s.heading === target.heading) ?? null;
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
