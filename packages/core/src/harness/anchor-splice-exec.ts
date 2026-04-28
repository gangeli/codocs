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
 */
export function locateOldTextRange(
  document: docs_v1.Schema$Document,
  oldText: string,
): { startIndex: number; endIndex: number } | null {
  if (!oldText) return null;
  const elements = document.body?.content ?? [];
  // Build a flat sequence of {index, char} pairs across all paragraph
  // text-runs, preserving body indices.
  const flat: Array<{ index: number; ch: string }> = [];
  for (const el of elements) {
    const para = el.paragraph;
    if (!para?.elements) continue;
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
  const joined = flat.map((f) => f.ch).join('');
  const first = joined.indexOf(oldText);
  if (first < 0) return null;
  const second = joined.indexOf(oldText, first + 1);
  if (second >= 0) return null; // ambiguous
  const startIndex = flat[first].index;
  const endIndex = flat[first + oldText.length - 1].index + 1;
  return { startIndex, endIndex };
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

  const splicePoint = fresh.startIndex + 1;

  // Step 1: insert newText just inside the anchor.
  try {
    await client.batchUpdate(documentId, [
      { insertText: { location: { index: splicePoint }, text: op.newText } },
    ]);
  } catch (err: any) {
    log?.(`[splice] ${op.commentId}: step-1 insert failed (${err?.message ?? err}) — skipping`);
    return 'skipped';
  }

  // After step 1, anchor covers [fresh.startIndex, fresh.endIndex + newLen].
  // Trim leading 1-char prefix and trailing oldSuffix.
  const newLen = op.newText.length;
  const trim = computeTrimRanges(fresh, newLen);

  try {
    await client.batchUpdate(documentId, trim.map(rangeToDeleteRequest));
    log?.(`[splice] ${op.commentId}: spliced (${op.oldText.length}→${newLen} chars)`);
    return 'spliced';
  } catch (firstErr: any) {
    log?.(`[splice] ${op.commentId}: step-2 trim failed (${firstErr?.message ?? firstErr}) — retrying with refreshed indices`);
  }

  // Retry once with refreshed indices. The post-step-1 anchor covers
  // `oldPrefix + newText + oldSuffix`, so we look for that string.
  const retryDoc = await client.getDocument(documentId);
  const concat = op.oldText.slice(0, 1) + op.newText + op.oldText.slice(1);
  const retryRange = locateOldTextRange(retryDoc, concat);
  if (retryRange) {
    const refreshedTrim = [
      // trailing first (descending order)
      {
        startIndex: retryRange.startIndex + 1 + newLen,
        endIndex: retryRange.endIndex,
      },
      {
        startIndex: retryRange.startIndex,
        endIndex: retryRange.startIndex + 1,
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
    const newTextStart = restoreRange.startIndex + 1;
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
 * Compute trim ranges in post-step-1 index space, given the freshly
 * resolved pre-step-1 anchor range and the inserted newText length.
 *
 * Exposed for unit testing.
 */
export function computeTrimRanges(
  freshAnchor: { startIndex: number; endIndex: number },
  newLen: number,
): Array<{ startIndex: number; endIndex: number }> {
  const start = freshAnchor.startIndex;
  const end = freshAnchor.endIndex;
  const leading = { startIndex: start, endIndex: start + 1 };
  const trailingStart = start + 1 + newLen;
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
