/**
 * TDD scaffold for `preserveCommentAnchors` splice mode (design doc §3.7.1).
 *
 * The function does not yet exist; these cases enumerate the invariants
 * that the implementation must satisfy. They are written as `it.todo()`
 * so the file compiles green and the suite documents intended behavior
 * without claiming to verify it. When the implementation lands, replace
 * each `todo` with a real `it()` body.
 *
 * Covered axes:
 *   1. API shape  (mode parameter, return type)
 *   2. Eligibility (anchor length, single-edit, non-empty replacement)
 *   3. Splice op construction (splice point, trim ranges, post-merge indices)
 *   4. Fallback to revert
 *   5. Concurrent-edit / partial-failure semantics (spec only — these
 *      live above preserveCommentAnchors but are listed here so the
 *      orchestrator-side test-bed picks them up)
 *
 * Reference: `.codocs/design-doc.md` §3.7.1 "Anchor splice mode".
 */
import { describe, it } from 'vitest';

describe('preserveCommentAnchors — API shape', () => {
  it.todo('accepts mode: "revert" | "splice", defaults to "revert"');
  it.todo('in "revert" mode returns { mergedMarkdown, preservedAnchors[] } unchanged from current behavior');
  it.todo('in "splice" mode returns { mergedMarkdown, preservedAnchors[], spliceOps: AnchorSpliceOp[] }');
  it.todo('AnchorSpliceOp carries { commentId, currentRange, newText, splicePoint, trimRanges }');
});

describe('preserveCommentAnchors — splice eligibility', () => {
  it.todo('emits a splice op when anchor span >= MIN_SPLICE_LEN (default 2) and replacement is non-empty');
  it.todo('falls back to revert when anchor span is exactly 1 char (no interior splice point exists)');
  it.todo('falls back to revert when anchor span is 0 (degenerate / already-orphaned anchor)');
  it.todo('falls back to revert when the merged markdown deletes the anchor entirely (empty new text)');
  it.todo('falls back to revert when the anchor straddles a structural boundary (heading/list-item move)');
  it.todo('falls back to revert when more than one contiguous edit overlaps the anchor');
  it.todo('skips splice (no-op, no fallback) when the merged markdown leaves the anchor text byte-identical');
});

describe('preserveCommentAnchors — splice op construction', () => {
  it.todo('places splicePoint just after the first character of the anchor by default');
  it.todo('trimRanges cover exactly the leading oldPrefix and trailing oldSuffix — together they reduce the anchor to newText');
  it.todo('splicePoint and trimRanges use post-merge body indices (recomputed if main batch shifts offsets)');
  it.todo('splice op for a 2-char anchor uses the minimal interior point (after char 0, leaving 1 char on each side)');
  it.todo('multi-byte / surrogate-pair anchor: splicePoint never lands inside a code unit pair');
  it.todo('does not emit an insert at the anchor edge (would risk Drive expanding/contracting the range)');
});

describe('preserveCommentAnchors — multi-anchor handling', () => {
  it.todo('two non-overlapping comments on the same merged section each get their own splice op');
  it.todo('two comments whose ranges overlap the same rewritten span: splice the wider, revert the narrower (per §3.7.1 out-of-scope note)');
  it.todo('comment whose anchor lies entirely outside the edited region is left alone (no op emitted)');
});

describe('preserveCommentAnchors — fallback bookkeeping', () => {
  it.todo('preservedAnchors entry for a reverted anchor is labelled "preserved by revert"');
  it.todo('preservedAnchors entry for a spliced anchor is labelled "preserved by splice"');
  it.todo('a section that was reverted keeps the current doc text byte-for-byte (no incidental whitespace changes)');
});

/**
 * The orchestrator side of splice (two batchUpdate calls + restore-on-failure)
 * is tested at a higher layer than diff.ts. Listed here so the spec stays in
 * one place; move into `orchestrator.test.ts` when the implementation lands.
 */
describe('orchestrator splice execution (spec — implement in orchestrator.test.ts)', () => {
  it.todo('executes splice ops AFTER the main batchUpdate and BEFORE posting the reply');
  it.todo('issues exactly two batchUpdate calls per splice op (insert, then trim)');
  it.todo('on step-2 failure: retries once with refreshed body indices');
  it.todo('on second step-2 failure: emits a restore batchUpdate that puts the original quoted text back');
  it.todo('on second step-2 failure: surfaces the failure in the reply so the user knows the rewrite did not land');
  it.todo('re-fetches doc revision id before step 2; aborts + restores if it changed inside the affected range');
  it.todo('a no-op edit on commented text never enters the splice path (no extra batchUpdate)');
});
