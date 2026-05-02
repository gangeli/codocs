/**
 * Executor for `AnchorSpliceOp`s (design doc §3.7.1).
 *
 * Lives in its own module so the orchestrator stays small and the
 * two-step batchUpdate dance can be unit-tested with a mock client.
 *
 * Per op:
 *   1. Re-resolve the anchor's range against the *post-main-batch*
 *      doc state (offsets may have shifted; the anchor text may have
 *      moved or been edited by a concurrent user).
 *   2. Issue insert (step 1).
 *   3. Issue trim (step 2). On step-2 failure, retry once with
 *      refreshed indices; on second failure restore the original
 *      quoted text and report the failure to the caller.
 */

import type { docs_v1 } from 'googleapis';
import type { AnchorSpliceOp } from './anchor-splice.js';

/** Subset of the docs client we depend on — easy to mock in tests. */
export interface SpliceDocsClient {
  getDocument(docId: string): Promise<docs_v1.Schema$Document>;
  batchUpdate(docId: string, requests: docs_v1.Schema$Request[]): Promise<void>;
}

export interface SpliceExecResult {
  /** Comment ids whose anchors were successfully spliced. */
  spliced: string[];
  /** Comment ids whose splice failed and were restored to original. */
  restored: string[];
  /** Comment ids whose anchor could not be re-resolved at execution time. */
  skipped: string[];
}

/**
 * Re-resolve where `oldText` currently sits in the doc. Returns null
 * if the text isn't there (concurrent delete) or appears more than
 * once (ambiguous). Body indices come from walking the document's
 * paragraph elements end-to-end and matching on raw text content.
 *
 * Match strategy is two-pass:
 *
 *   1. Exact code-unit `indexOf`. Handles the common case.
 *   2. Ignorable-tolerant fallback: strip variation selectors
 *      (U+FE00–U+FE0F), zero-width space (U+200B), and BOM (U+FEFF)
 *      from BOTH the doc and the search string, then retry. Drive's
 *      body textRun sometimes carries U+FE0F (emoji presentation
 *      selector) on emoji even when the source markdown / the
 *      comment's `quotedFileContent.value` did not, so a literal
 *      indexOf misses despite the text visibly matching. The
 *      returned range still references ORIGINAL doc indices —
 *      stripping is only for matching, not output.
 */
export function locateOldTextRange(
  document: docs_v1.Schema$Document,
  oldText: string,
): { startIndex: number; endIndex: number } | null {
  if (!oldText) return null;
  // Build a flat sequence of {index, char} pairs across every text
  // run in the doc, preserving body indices. Walks BOTH top-level
  // paragraph elements and the paragraphs nested inside table cells
  // (`el.table.tableRows[].tableCells[].content[]`); without the
  // table walk, anchors on table-cell text are silently lost.
  const flat: Array<{ index: number; ch: string }> = [];
  collectTextRuns(document.body?.content ?? [], flat);

  // Pass 1: exact code-unit match.
  const exact = findUniqueIn(flat, oldText, false);
  if (exact) return exact;

  // Pass 2: ignorable-tolerant match. Variation selectors
  // (U+FE00–U+FE0F), zero-width space (U+200B), and BOM (U+FEFF)
  // are stripped from both the doc walk and the search string. ZWJ
  // (U+200D) is intentionally NOT stripped — it's structural inside
  // compound emoji.
  //
  // Triggered even when the search string has no ignorable chars:
  // the asymmetry where Drive's body has VS-16 but the comment's
  // `quotedFileContent.value` does not is the load-bearing case
  // we're targeting (observed in CA13 e2e). Only bail when the
  // stripped search is empty.
  const strippedNeedle = oldText.replace(IGNORABLE_CHARS, '');
  if (!strippedNeedle) return null;
  return findUniqueIn(flat, strippedNeedle, true);
}

// Variation selectors (U+FE00–U+FE0F), zero-width space (U+200B),
// and BOM (U+FEFF). ZWJ (U+200D) is deliberately omitted because it
// is structural inside compound emoji. Built via RegExp constructor
// so the source uses unambiguous \uXXXX escapes — the equivalent
// inline literal regex would contain invisible chars that don't
// survive copy/paste cleanly.
const IGNORABLE_CHARS = new RegExp('[\\uFE00-\\uFE0F\\u200B\\uFEFF]', 'g');
const IGNORABLE_TEST = new RegExp('[\\uFE00-\\uFE0F\\u200B\\uFEFF]');

/**
 * Walk every text run in `elements`, including paragraphs nested
 * inside tables (cells contain their own list of structural
 * elements). Pushes one {index, ch} per UTF-16 code unit, with
 * `index` set to the body index that char occupies in the doc.
 */
function collectTextRuns(
  elements: docs_v1.Schema$StructuralElement[],
  flat: Array<{ index: number; ch: string }>,
): void {
  for (const el of elements) {
    const para = el.paragraph;
    if (para?.elements) {
      for (const pe of para.elements) {
        const tr = pe.textRun;
        if (!tr || tr.content == null) continue;
        const start = pe.startIndex ?? 0;
        const text = tr.content;
        for (let i = 0; i < text.length; i++) {
          flat.push({ index: start + i, ch: text[i] });
        }
      }
    }
    // Recurse into table cells. Each cell's `content` is itself a
    // list of structural elements (typically paragraphs).
    const table = el.table;
    if (table?.tableRows) {
      for (const row of table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          if (cell.content) collectTextRuns(cell.content, flat);
        }
      }
    }
  }
}

function findUniqueIn(
  flat: Array<{ index: number; ch: string }>,
  needle: string,
  stripIgnorable: boolean,
): { startIndex: number; endIndex: number } | null {
  // Pair kept chars with their original `flat` indices so the
  // returned doc-index range can include any ignorable chars sitting
  // between matched positions (e.g. a VS-16 between the emoji and
  // the next char).
  const filtered: Array<{ flatIdx: number; ch: string }> = [];
  for (let i = 0; i < flat.length; i++) {
    if (stripIgnorable && IGNORABLE_TEST.test(flat[i].ch)) continue;
    filtered.push({ flatIdx: i, ch: flat[i].ch });
  }
  const joined = filtered.map((f) => f.ch).join('');
  const first = joined.indexOf(needle);
  if (first < 0) return null;
  const second = joined.indexOf(needle, first + 1);
  if (second >= 0) return null;
  const startFlatIdx = filtered[first].flatIdx;
  const endFlatIdx = filtered[first + needle.length - 1].flatIdx;
  return {
    startIndex: flat[startFlatIdx].index,
    endIndex: flat[endFlatIdx].index + 1,
  };
}

/**
 * Execute a list of splice ops sequentially. Each op is two API
 * round-trips (insert, then trim). On step-2 failure we retry once
 * with refreshed indices; on second failure we restore the original
 * quoted text.
 */
export async function executeAnchorSpliceOps(
  client: SpliceDocsClient,
  documentId: string,
  ops: AnchorSpliceOp[],
  log?: (msg: string) => void,
): Promise<SpliceExecResult> {
  const result: SpliceExecResult = { spliced: [], restored: [], skipped: [] };
  for (const op of ops) {
    const outcome = await executeOne(client, documentId, op, log);
    if (outcome === 'spliced') result.spliced.push(op.commentId);
    else if (outcome === 'restored') result.restored.push(op.commentId);
    else result.skipped.push(op.commentId);
  }
  return result;
}

async function executeOne(
  client: SpliceDocsClient,
  documentId: string,
  op: AnchorSpliceOp,
  log?: (msg: string) => void,
): Promise<'spliced' | 'restored' | 'skipped'> {
  // Resolve the anchor's CURRENT body-index range from a fresh doc
  // read. The op's stored currentRange is pre-main-batch; offsets may
  // have shifted.
  const docBefore = await client.getDocument(documentId);
  const fresh = locateOldTextRange(docBefore, op.oldText);
  if (!fresh) {
    log?.(`[splice] ${op.commentId}: anchor text not found in current doc — skipping`);
    return 'skipped';
  }

  // Splice point must skip past the leading grapheme cluster of the
  // anchor — Drive's batchUpdate rejects insertText whose location
  // falls inside a grapheme cluster (surrogate pair, base + VS-16,
  // ZWJ-glued sequence). For ASCII this is just startIndex + 1.
  const leadingLen = leadingGraphemeCodeUnitLength(op.oldText);
  if (leadingLen >= fresh.endIndex - fresh.startIndex) {
    log?.(`[splice] ${op.commentId}: anchor only one grapheme — no safe interior splice point — skipping`);
    return 'skipped';
  }
  const splicePoint = fresh.startIndex + leadingLen;

  // Step 1: insert newText just inside the anchor (after the
  // leading grapheme so the insertion index is grapheme-aligned).
  try {
    await client.batchUpdate(documentId, [
      { insertText: { location: { index: splicePoint }, text: op.newText } },
    ]);
  } catch (err: any) {
    log?.(`[splice] ${op.commentId}: step-1 insert failed (${err?.message ?? err}) — skipping`);
    return 'skipped';
  }

  // After step 1, anchor covers [fresh.startIndex, fresh.endIndex + newLen].
  // Trim leading-grapheme prefix and trailing oldSuffix.
  const newLen = op.newText.length;
  const trim = computeTrimRanges(fresh, newLen, leadingLen);

  try {
    await client.batchUpdate(documentId, trim.map(rangeToDeleteRequest));
    log?.(`[splice] ${op.commentId}: spliced (${op.oldText.length}→${newLen} chars)`);
    return 'spliced';
  } catch (firstErr: any) {
    log?.(`[splice] ${op.commentId}: step-2 trim failed (${firstErr?.message ?? firstErr}) — retrying with refreshed indices`);
  }

  // Retry once with refreshed indices. The post-step-1 anchor covers
  // `oldPrefix + newText + oldSuffix`, where oldPrefix is the
  // leading grapheme of the original anchor.
  const retryDoc = await client.getDocument(documentId);
  const concat = op.oldText.slice(0, leadingLen) + op.newText + op.oldText.slice(leadingLen);
  const retryRange = locateOldTextRange(retryDoc, concat);
  if (retryRange) {
    const refreshedTrim = [
      // trailing first (descending order)
      {
        startIndex: retryRange.startIndex + leadingLen + newLen,
        endIndex: retryRange.endIndex,
      },
      {
        startIndex: retryRange.startIndex,
        endIndex: retryRange.startIndex + leadingLen,
      },
    ].filter((r) => r.endIndex > r.startIndex);
    try {
      await client.batchUpdate(documentId, refreshedTrim.map(rangeToDeleteRequest));
      log?.(`[splice] ${op.commentId}: spliced after retry`);
      return 'spliced';
    } catch (secondErr: any) {
      log?.(`[splice] ${op.commentId}: step-2 retry failed (${secondErr?.message ?? secondErr}) — restoring original`);
    }
  } else {
    log?.(`[splice] ${op.commentId}: post-step-1 state unrecoverable — restoring original`);
  }

  // Restore: post step-1 the doc reads `oldPrefix + newText + oldSuffix`.
  // To get back to the original `oldText`, just delete the inserted
  // newText — the surrounding old prefix/suffix is already there.
  const restoreDoc = await client.getDocument(documentId);
  const restoreRange = locateOldTextRange(restoreDoc, concat);
  if (restoreRange) {
    const newTextStart = restoreRange.startIndex + leadingLen;
    const newTextEnd = newTextStart + newLen;
    try {
      await client.batchUpdate(documentId, [
        { deleteContentRange: { range: { startIndex: newTextStart, endIndex: newTextEnd } } },
      ]);
      log?.(`[splice] ${op.commentId}: restored to original`);
      return 'restored';
    } catch (restoreErr: any) {
      log?.(`[splice] ${op.commentId}: restore failed (${restoreErr?.message ?? restoreErr})`);
      return 'restored'; // count as restored attempt — caller is told it didn't land
    }
  }
  log?.(`[splice] ${op.commentId}: could not locate concat for restore — leaving doc as is`);
  return 'restored';
}

/**
 * Length of the first grapheme cluster of `s`, in UTF-16 code units.
 * Mirrors the helper in anchor-splice.ts (kept local to this file
 * to avoid introducing a cross-module dependency for a tiny utility).
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
    // Fall through.
  }
  const c = s.charCodeAt(0);
  if (c >= 0xD800 && c <= 0xDBFF && s.length >= 2) {
    const c2 = s.charCodeAt(1);
    if (c2 >= 0xDC00 && c2 <= 0xDFFF) return 2;
  }
  return 1;
}

/**
 * Compute trim ranges in post-step-1 index space, given the freshly
 * resolved pre-step-1 anchor range, the inserted newText length, and
 * the number of code units occupied by the leading grapheme of the
 * anchor (defaults to 1, the historical assumption — pass 2 when
 * the anchor begins with a UTF-16 surrogate pair, etc).
 *
 * Exposed for unit testing.
 */
export function computeTrimRanges(
  freshAnchor: { startIndex: number; endIndex: number },
  newLen: number,
  leadingLen: number = 1,
): Array<{ startIndex: number; endIndex: number }> {
  const start = freshAnchor.startIndex;
  const end = freshAnchor.endIndex;
  const leading = { startIndex: start, endIndex: start + leadingLen };
  const trailingStart = start + leadingLen + newLen;
  const trailingEnd = end + newLen;
  const trailing = trailingStart < trailingEnd
    ? { startIndex: trailingStart, endIndex: trailingEnd }
    : null;
  // Apply trailing first (higher indices) so leading deletion doesn't
  // invalidate trailing range.
  return trailing ? [trailing, leading] : [leading];
}

function rangeToDeleteRequest(
  r: { startIndex: number; endIndex: number },
): docs_v1.Schema$Request {
  return { deleteContentRange: { range: { startIndex: r.startIndex, endIndex: r.endIndex } } };
}
