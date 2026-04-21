/**
 * 3-way merge engine for syncing agent edits back to Google Docs.
 *
 * Uses section-level splitting (by headings) combined with node-diff3
 * for per-section 3-way merge. Untouched sections are taken verbatim
 * from "theirs" to preserve attribution and formatting.
 */

import { merge as diff3Merge, diffPatch } from 'node-diff3';
import type { docs_v1 } from 'googleapis';
import type { IndexMapEntry } from '../converter/element-parser.js';
import { markdownToDocsRequests } from '../converter/md-to-docs.js';
import { createAttributionRequests } from '../attribution/named-ranges.js';

/** A section of a markdown document, delimited by headings. */
export interface MdSection {
  /** Heading text (without `#` prefix), or null for content before the first heading. */
  heading: string | null;
  /** Full markdown content of this section, including the heading line. */
  content: string;
  /** Start line number (0-based) in the original markdown. */
  startLine: number;
  /** End line number (exclusive, 0-based). */
  endLine: number;
}

/** Result of a 3-way document merge. */
export interface MergeResult {
  /** The merged markdown content. */
  mergedMarkdown: string;
  /** Whether any sections had merge conflicts. */
  hasConflicts: boolean;
  /** Details of conflicting sections. */
  conflictSections: Array<{ heading: string | null; conflictText: string }>;
}

/** Result of computing doc-level diff operations. */
export interface DiffResult {
  /** Whether any changes were detected. */
  hasChanges: boolean;
  /** Google Docs API batchUpdate requests to apply the changes. */
  requests: docs_v1.Schema$Request[];
  /** Number of conflicts that were resolved (via callback). */
  conflictsResolved: number;
}

// Heading regex: line starting with 1-6 `#` followed by a space
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

// Fenced code-block opener/closer: 3+ backticks or tildes, optionally
// preceded by up to 3 spaces of indentation, with optional info string.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Parse a markdown string into sections split by headings.
 *
 * Heading-like lines inside a fenced code block (``` or ~~~) are treated
 * as body content, not section boundaries.
 */
export function parseSections(markdown: string): MdSection[] {
  const lines = markdown.split('\n');
  const sections: MdSection[] = [];
  let currentHeading: string | null = null;
  let currentStartLine = 0;
  let currentLines: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      currentLines.push(lines[i]);
      continue;
    }
    const match = inFence ? null : lines[i].match(HEADING_RE);

    if (match) {
      // Flush previous section if it has content
      if (currentLines.length > 0 || currentHeading !== null) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join('\n'),
          startLine: currentStartLine,
          endLine: i,
        });
      }

      currentHeading = match[2];
      currentStartLine = i;
      currentLines = [lines[i]];
    } else {
      currentLines.push(lines[i]);
    }
  }

  // Flush final section
  if (currentLines.length > 0 || currentHeading !== null) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join('\n'),
      startLine: currentStartLine,
      endLine: lines.length,
    });
  }

  // Remove empty null-heading section at the start (if doc starts with a heading)
  if (sections.length > 0 && sections[0].heading === null && sections[0].content.trim() === '') {
    sections.shift();
  }

  return sections;
}

/**
 * Match sections across three versions by (heading, occurrence-index).
 * Two sections sharing a heading text are kept distinct via their
 * 0-based position among same-heading siblings in the source list.
 * Returns aligned triples: [baseSection, oursSection, theirsSection].
 * Any may be null if the section doesn't exist in that version.
 */
function alignSections(
  baseSections: MdSection[],
  oursSections: MdSection[],
  theirsSections: MdSection[],
): Array<[MdSection | null, MdSection | null, MdSection | null]> {
  const NULL_HEADING = '\0null';
  function withKeys(sections: MdSection[]): Array<{ key: string; section: MdSection }> {
    const counts = new Map<string, number>();
    return sections.map((s) => {
      const h = s.heading ?? NULL_HEADING;
      const n = counts.get(h) ?? 0;
      counts.set(h, n + 1);
      return { key: `${h}\0${n}`, section: s };
    });
  }
  const base = withKeys(baseSections);
  const ours = withKeys(oursSections);
  const theirs = withKeys(theirsSections);

  // Pick the ordering authority: if exactly one side reordered the existing
  // sections relative to base, that side's ordering wins (walked first, so
  // its key positions seed `orderedKeys` before the other sides). Otherwise
  // fall back to base-first, which preserves the original ordering and lets
  // added/removed sections anchor after their predecessors.
  const baseKeys = base.map((e) => e.key);
  const oursReordered = isPermutationReordered(baseKeys, ours.map((e) => e.key));
  const theirsReordered = isPermutationReordered(baseKeys, theirs.map((e) => e.key));

  let walkOrder: Array<Array<{ key: string; section: MdSection }>>;
  if (theirsReordered && !oursReordered) walkOrder = [theirs, base, ours];
  else if (oursReordered && !theirsReordered) walkOrder = [ours, base, theirs];
  else walkOrder = [base, ours, theirs];

  // Merge the three keyed orderings, preserving each source's relative
  // positions. A new key from `ours` (or `theirs`) gets inserted after
  // its predecessor in that source, so a section the agent adds between
  // two existing ones lands in the middle of the merged order, not at
  // the tail.
  const seen = new Set<string>();
  const orderedKeys: string[] = [];
  for (const arr of walkOrder) {
    let anchor = -1; // index in orderedKeys of the last key seen/inserted from this source
    for (const { key } of arr) {
      if (seen.has(key)) {
        anchor = orderedKeys.indexOf(key);
      } else {
        orderedKeys.splice(anchor + 1, 0, key);
        seen.add(key);
        anchor += 1;
      }
    }
  }

  const findSection = (arr: Array<{ key: string; section: MdSection }>, key: string) =>
    arr.find((e) => e.key === key)?.section ?? null;

  return orderedKeys.map((k) => [
    findSection(base, k),
    findSection(ours, k),
    findSection(theirs, k),
  ]);
}

/**
 * True iff `sideKeys` is a non-trivial permutation of `baseKeys` — i.e. same
 * set of keys but different order. Additions or deletions disqualify.
 */
function isPermutationReordered(baseKeys: string[], sideKeys: string[]): boolean {
  if (baseKeys.length !== sideKeys.length) return false;
  const baseSet = new Set(baseKeys);
  for (const k of sideKeys) if (!baseSet.has(k)) return false;
  for (let i = 0; i < baseKeys.length; i++) {
    if (baseKeys[i] !== sideKeys[i]) return true;
  }
  return false;
}

/**
 * 3-way merge of three markdown document versions.
 *
 * - Sections untouched by agent (base === ours): take theirs
 * - Sections untouched by others (base === theirs): take ours
 * - Both changed: run diff3 merge, report conflicts
 * - Section only in ours: added by agent
 * - Section only in theirs: added by others
 * - Section missing from ours but in base+theirs: deleted by agent
 * - Section missing from theirs but in base+ours: deleted by others
 */
export function mergeDocuments(
  base: string,
  ours: string,
  theirs: string,
): MergeResult {
  const baseSections = parseSections(base);
  const oursSections = parseSections(ours);
  const theirsSections = parseSections(theirs);

  const aligned = alignSections(baseSections, oursSections, theirsSections);
  const mergedParts: string[] = [];
  const conflictSections: MergeResult['conflictSections'] = [];
  let hasConflicts = false;

  for (const [baseS, oursS, theirsS] of aligned) {
    const baseContent = baseS?.content ?? '';
    const oursContent = oursS?.content ?? '';
    const theirsContent = theirsS?.content ?? '';

    if (!oursS && !theirsS) {
      // Section only existed in base — both deleted, skip
      continue;
    }

    if (!baseS && oursS && !theirsS) {
      // Added by agent only
      mergedParts.push(oursContent);
      continue;
    }

    if (!baseS && !oursS && theirsS) {
      // Added by others only
      mergedParts.push(theirsContent);
      continue;
    }

    if (!baseS && oursS && theirsS) {
      // Both added a section with the same heading — conflict
      const result = diff3MergeSection(oursContent, '', theirsContent);
      mergedParts.push(result.text);
      if (result.conflict) {
        hasConflicts = true;
        conflictSections.push({ heading: oursS.heading, conflictText: result.text });
      }
      continue;
    }

    // Section exists in base
    if (!oursS) {
      // Deleted by agent
      if (theirsContent === baseContent) {
        // Others didn't change it — agent's deletion stands
        continue;
      }
      // Others changed it but agent deleted — conflict; keep theirs with warning
      mergedParts.push(theirsContent);
      continue;
    }

    if (!theirsS) {
      // Deleted by others
      if (oursContent === baseContent) {
        // Agent didn't change it — others' deletion stands
        continue;
      }
      // Agent changed it but others deleted — keep agent's version
      mergedParts.push(oursContent);
      continue;
    }

    // All three exist
    if (oursContent === baseContent) {
      // Agent didn't touch this section — take theirs verbatim
      mergedParts.push(theirsContent);
    } else if (theirsContent === baseContent) {
      // Others didn't touch this section — take ours
      mergedParts.push(oursContent);
    } else {
      // Both changed — 3-way merge
      const result = diff3MergeSection(oursContent, baseContent, theirsContent);
      mergedParts.push(result.text);
      if (result.conflict) {
        hasConflicts = true;
        conflictSections.push({ heading: oursS.heading, conflictText: result.text });
      }
    }
  }

  const mergedMarkdown = mergedParts.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  return { mergedMarkdown, hasConflicts, conflictSections };
}

/**
 * Run diff3 merge on a single section's content.
 */
function diff3MergeSection(
  ours: string,
  base: string,
  theirs: string,
): { text: string; conflict: boolean } {
  const oursLines = ours.split('\n');
  const baseLines = base.split('\n');
  const theirsLines = theirs.split('\n');

  const result = diff3Merge(oursLines, baseLines, theirsLines);

  return {
    text: result.result.join('\n'),
    conflict: result.conflict,
  };
}

/**
 * Compute Google Docs API batchUpdate requests from a 3-way merge.
 *
 * For each section that changed (comparing merged result to theirs/current),
 * generates deleteContentRange + insertText + styling requests.
 *
 * @param base - Markdown snapshot from when agent started
 * @param ours - Agent's edited markdown
 * @param theirs - Current Google Doc as markdown
 * @param document - Current Google Doc document object
 * @param indexMap - Markdown-to-doc index mapping from docsToMarkdownWithMapping
 * @param agentName - Name of the agent making the edit (for attribution)
 * @param resolveConflicts - Optional callback to resolve conflicts (e.g., send back to agent)
 */
export async function computeDocDiff(
  base: string,
  ours: string,
  theirs: string,
  document: docs_v1.Schema$Document,
  indexMap: IndexMapEntry[],
  agentName: string,
  resolveConflicts?: (conflictText: string) => Promise<string>,
): Promise<DiffResult> {
  let mergeResult = mergeDocuments(base, ours, theirs);
  let conflictsResolved = 0;

  // If there are conflicts and a resolver is provided, try to resolve
  if (mergeResult.hasConflicts && resolveConflicts) {
    const resolved = await resolveConflicts(mergeResult.mergedMarkdown);
    // Re-check for remaining conflict markers
    if (!resolved.includes('<<<<<<<') && !resolved.includes('>>>>>>>')) {
      mergeResult = {
        mergedMarkdown: resolved,
        hasConflicts: false,
        conflictSections: [],
      };
      conflictsResolved = mergeResult.conflictSections.length;
    }
  }

  // Compare merged result with theirs (current doc) to find what changed
  const theirsSections = parseSections(theirs);
  const mergedSections = parseSections(mergeResult.mergedMarkdown);

  // If nothing meaningful changed, return early. Trailing whitespace
  // within a line and leading/trailing blank lines at the doc level are
  // semantically insignificant — Google Docs doesn't preserve them and
  // readers/normalizers strip them, so producing a diff for them just
  // generates an immediately-discarded round-trip edit.
  if (normalizeForNoOpCheck(mergeResult.mergedMarkdown) === normalizeForNoOpCheck(theirs)) {
    return { hasChanges: false, requests: [], conflictsResolved };
  }

  const bodyEndIndex = getBodyEndIndex(document);
  const requests: docs_v1.Schema$Request[] = [];

  // Find sections that differ between theirs and merged
  const changedSections: Array<{
    theirsSection: MdSection | null;
    mergedSection: MdSection | null;
    docStartIndex: number;
    docEndIndex: number;
  }> = [];

  for (let mi = 0; mi < mergedSections.length; mi++) {
    const mergedS = mergedSections[mi];
    const theirsS = theirsSections.find((s) => s.heading === mergedS.heading);
    if (!theirsS || theirsS.content !== mergedS.content) {
      let docRange;
      if (!theirsS) {
        // New section — its doc position is the start of the first
        // following merged section that also exists in `theirs`. If
        // no such neighbour exists (new section is last), append at body end.
        let docStartIndex = bodyEndIndex;
        for (let j = mi + 1; j < mergedSections.length; j++) {
          const nextTheirs = theirsSections.find((s) => s.heading === mergedSections[j].heading);
          if (nextTheirs) {
            docStartIndex = findSectionDocRange(
              nextTheirs,
              theirsSections,
              indexMap,
              bodyEndIndex,
            ).docStartIndex;
            break;
          }
        }
        docRange = { docStartIndex, docEndIndex: docStartIndex };
      } else {
        docRange = findSectionDocRange(
          theirsS,
          theirsSections,
          indexMap,
          bodyEndIndex,
        );
      }
      changedSections.push({
        theirsSection: theirsS ?? null,
        mergedSection: mergedS,
        ...docRange,
      });
    }
  }

  // Also handle sections that were deleted (in theirs but not in merged)
  for (const theirsS of theirsSections) {
    const mergedS = mergedSections.find((s) => s.heading === theirsS.heading);
    if (!mergedS) {
      const docRange = findSectionDocRange(
        theirsS ?? null,
        theirsSections,
        indexMap,
        bodyEndIndex,
      );
      changedSections.push({
        theirsSection: theirsS,
        mergedSection: null,
        ...docRange,
      });
    }
  }

  // Sort by doc index descending — process from end to start to keep indices valid
  changedSections.sort((a, b) => b.docStartIndex - a.docStartIndex);

  for (const change of changedSections) {
    if (!change.theirsSection) {
      // New section. markdownToDocsRequests strips the trailing \n from its
      // last segment, so we have to inject a separator \n so our content
      // doesn't fuse into the neighbouring paragraph.
      //
      //   - Append at end (insertAt == bodyEndIndex-1, right before the
      //     doc's terminating \n): the separator \n goes BEFORE the
      //     content so the content lands in its own paragraph instead of
      //     extending the doc's last paragraph. The doc's existing final
      //     \n terminates our content.
      //   - Mid-doc (insertAt is the start of some following paragraph):
      //     insert the separator \n at the insert point BEFORE the
      //     content (sequentially). Google Docs processes requests in
      //     order, so the later content insert at the same index pushes
      //     our \n to `insertAt + text.length`. The key is that the \n
      //     request appears FIRST in the batch — that way, when Docs
      //     splits the following paragraph at our insert point, the
      //     split-left slot is what the content extends (and what our
      //     paragraph-style update targets), not the following
      //     paragraph itself. Inserting the \n AFTER the content is
      //     tempting but wrong: the content would first be merged into
      //     the following paragraph (inheriting its heading style), and
      //     the paragraph-style update would then strip the heading off
      //     the real next paragraph when the \n split it back out.
      if (change.mergedSection) {
        const insertAt = Math.min(Math.max(1, change.docStartIndex), bodyEndIndex - 1);
        const isAppendAtEnd = insertAt >= bodyEndIndex - 1;
        let actualInsertAt = insertAt;
        if (isAppendAtEnd) {
          requests.push({
            insertText: { location: { index: insertAt }, text: '\n' },
          });
          actualInsertAt = insertAt + 1;
        } else {
          // Separator \n inserted FIRST at the content-insert position.
          // The content request that follows lands at the same index and
          // pushes our \n to `insertAt + content.length`.
          requests.push({
            insertText: { location: { index: insertAt }, text: '\n' },
          });
        }
        const { text, requests: insertRequests } = markdownToDocsRequests(
          change.mergedSection.content,
          actualInsertAt,
          false,
          bodyEndIndex,
        );
        appendWithBulletClear(requests, insertRequests, document, actualInsertAt, text.length);
        if (text.length > 0) {
          requests.push(
            ...createAttributionRequests(agentName, actualInsertAt, actualInsertAt + text.length),
          );
        }
      }
      continue;
    }

    if (!change.mergedSection) {
      // Deleted section — delete the whole range
      const endIndex = change.docEndIndex >= bodyEndIndex ? bodyEndIndex - 1 : change.docEndIndex;
      if (endIndex > change.docStartIndex) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: change.docStartIndex, endIndex },
          },
        });
      }
      continue;
    }

    // Both exist — use line-level diff to produce minimal operations.
    // This preserves unchanged lines (and any comments anchored to them).
    const oldLines = change.theirsSection.content.split('\n');
    const newLines = change.mergedSection.content.split('\n');
    const hunks = diffPatch(oldLines, newLines);

    if (hunks.length === 0) continue; // no actual line changes

    // Build a line-to-doc-index map for the old section. The extra
    // sentinel at lineDocIndices[oldLines.length] = section end lets us
    // compute a delete range that runs up to the next line's start
    // without a special case for the last line.
    const sectionMdStart = computeMdOffset(change.theirsSection, theirsSections);
    const lineDocIndices = buildLineDocIndices(
      oldLines,
      sectionMdStart,
      indexMap,
      change.docEndIndex,
    );
    lineDocIndices.push(change.docEndIndex);

    // Google Docs batchUpdate processes requests sequentially.
    // Process hunks in reverse order (highest index first) so that
    // deletes don't shift the indices of subsequent operations.
    // Within each hunk: delete first, then insert at the same position.
    // Since we go in reverse, earlier hunks' positions are unaffected.

    for (let h = hunks.length - 1; h >= 0; h--) {
      const hunk = hunks[h];
      const oldOffset = hunk.buffer1.offset;
      const oldLength = hunk.buffer1.length;
      const newContent = hunk.buffer2.chunk.join('\n');

      const deleteStartIdx = Math.min(
        lineDocIndices[Math.min(oldOffset, lineDocIndices.length - 1)],
        bodyEndIndex - 1,
      );

      // deleteEndIdx is the min of two estimates — both are upper bounds
      // but each over-reads in cases the other gets right:
      //   - mdSumEnd sums markdown line lengths + \n. Over-counts for
      //     markdown lines with doc-less prefixes (`# `, `- `, `1. `,
      //     `**…**`), because `"# H".length + 1 == 4` while the doc only
      //     stores `H\n` == 2.
      //   - docSpanEnd uses the next line's doc index (via the sentinel
      //     for past-last). Over-reads when the next markdown line is a
      //     blank separator between two content paragraphs that were
      //     emitted with doc-side empty paragraphs between them —
      //     interpolateDocIndex snaps the empty mdOffset forward to the
      //     *next* content paragraph's docIndex, so the "gap" includes
      //     one extra empty-paragraph `\n`.
      // Neither estimate undershoots the real span, so taking the min
      // yields the correct delete range in both shapes.
      let mdSumEnd = deleteStartIdx;
      for (let k = oldOffset; k < oldOffset + oldLength && k < oldLines.length; k++) {
        mdSumEnd += oldLines[k].length + 1;
      }
      const docSpanEnd = lineDocIndices[Math.min(oldOffset + oldLength, lineDocIndices.length - 1)];
      const deleteEndIdx = Math.min(mdSumEnd, docSpanEnd);
      const wasClamped = deleteEndIdx >= bodyEndIndex;
      const clampedEnd = wasClamped ? bodyEndIndex - 1 : deleteEndIdx;

      // When replacing lines with new content, the delete range covers each
      // deleted line's content + its \n terminator. chunk.join('\n') has \n's
      // BETWEEN lines but no trailing \n, and markdownToDocsRequests further
      // strips any trailing \n. Without an explicit tail \n the replacement
      // fuses into the following paragraph. Skip when the delete was clamped
      // (the doc's final \n was NOT consumed, so re-inserting one would
      // duplicate).
      const needsTrailingNewline =
        oldLength > 0 &&
        newContent.length > 0 &&
        !newContent.endsWith('\n') &&
        !wasClamped;

      // Step 1: DELETE old content
      if (oldLength > 0 && clampedEnd > deleteStartIdx) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: deleteStartIdx, endIndex: clampedEnd },
          },
        });
      }

      // Special case: chunk is all empty strings. chunk.join('\n') is "",
      // so the main insert branch below skips. But each "" represents a
      // blank paragraph the agent wants to add — emit a raw '\n' per
      // element so the paragraph break actually lands in the doc.
      if (
        newContent.length === 0 &&
        hunk.buffer2.chunk.length > 0 &&
        hunk.buffer2.chunk.every((c: string) => c === '')
      ) {
        const insertAt = Math.min(deleteStartIdx, bodyEndIndex - 1);
        if (insertAt >= 1) {
          requests.push({
            insertText: {
              location: { index: insertAt },
              text: '\n'.repeat(hunk.buffer2.chunk.length),
            },
          });
        }
        continue;
      }

      // Step 2: INSERT new content.
      //
      // Pure-insert hunks (oldLength === 0) need paragraph-separator \n's
      // because markdownToDocsRequests strips leading/trailing \n from its
      // content. Where we add them depends on WHERE we're inserting:
      //
      //   - Append at end of section (oldOffset past oldLines): the insert
      //     point is bodyEndIndex-1, which is BEFORE the doc's terminating
      //     \n. Inserting text there would fuse with the preceding
      //     paragraph. We prepend "\n\n" (terminator for preceding para +
      //     empty separator para) — the existing final \n then serves as
      //     terminator for the new paragraph.
      //
      //   - Mid-section insert (oldOffset within oldLines): the insert
      //     point is the start of the FOLLOWING content paragraph. The
      //     content would fuse with that following paragraph and the
      //     paragraph-style update would then retarget the following
      //     paragraph. Insert a separator \n FIRST at the same index —
      //     the subsequent content inserts push our \n forward, and when
      //     Docs splits the following paragraph at our insert point, the
      //     split-left slot is what the content extends (and what our
      //     paragraph-style update targets), not the following paragraph.
      //
      // Replacement hunks (oldLength > 0) rely on needsTrailingNewline to
      // restore the single \n consumed by the delete. For the same reason
      // as mid-section inserts, the \n goes BEFORE the content so the
      // paragraph-style update lands on the new paragraph, not the next.
      if (newContent.length > 0) {
        const insertAt = Math.min(deleteStartIdx, bodyEndIndex - 1);
        const isPureInsert = oldLength === 0 && insertAt > 1;
        // "Append at end" applies ONLY when insertAt is at the doc's
        // terminating \n (bodyEndIndex-1). `oldOffset >= oldLines.length`
        // is not enough on its own: for a pure insert past a non-last
        // section's lines, insertAt points to the NEXT section's heading,
        // not the doc's end — prepending "\n\n" there would split the
        // following heading's paragraph and fuse the new content into it.
        // Fall through to the mid-section separator branch in that case.
        const isAppendAtEnd =
          isPureInsert &&
          oldOffset >= oldLines.length &&
          insertAt >= bodyEndIndex - 1;

        // When insertAt points to the startIndex of a structural
        // non-paragraph element (table, section break), text ops there
        // fail with "insertion index must be inside an existing
        // paragraph". Shift the separator one position earlier, into
        // the previous paragraph's trailing \n — inserting a \n there
        // creates an empty paragraph at the original insertAt which
        // the subsequent content then extends. Only the separator
        // position shifts; the content insert still targets the
        // original insertAt (which, post-separator, is the empty
        // paragraph).
        const separatorAt =
          !isAppendAtEnd &&
          insertAt > 1 &&
          isStructuralNonParagraphAt(document, insertAt)
            ? insertAt - 1
            : insertAt;

        let actualInsertAt = insertAt;
        if (isAppendAtEnd) {
          requests.push({
            insertText: { location: { index: insertAt }, text: '\n\n' },
          });
          actualInsertAt = insertAt + 2;
        } else if (isPureInsert || needsTrailingNewline) {
          // Mid-section separator: inserted BEFORE the content at the
          // same index, so later content inserts push it to
          // `actualInsertAt + text.length` once processed sequentially.
          // For pure inserts we need both a separator after the new
          // paragraph AND a blank-line separator before the following
          // content, so emit "\n\n" here.
          requests.push({
            insertText: {
              location: { index: separatorAt },
              text: isPureInsert ? '\n\n' : '\n',
            },
          });
        }

        const { text, requests: insertRequests } = markdownToDocsRequests(
          newContent,
          actualInsertAt,
          false,
          bodyEndIndex,
        );
        appendWithBulletClear(requests, insertRequests, document, actualInsertAt, text.length);

        if (text.length > 0) {
          requests.push(...createAttributionRequests(agentName, actualInsertAt, actualInsertAt + text.length));
        }
      }
    }
  }

  return { hasChanges: requests.length > 0, requests, conflictsResolved };
}

/**
 * Find the Google Doc index range for a section, using the index map.
 */
function findSectionDocRange(
  section: MdSection | null,
  allSections: MdSection[],
  indexMap: IndexMapEntry[],
  bodyEndIndex: number,
): { docStartIndex: number; docEndIndex: number } {
  if (!section || indexMap.length === 0) {
    return { docStartIndex: 1, docEndIndex: bodyEndIndex };
  }

  // Find the index map entry closest to this section's markdown start offset
  const sectionMdStart = computeMdOffset(section, allSections);

  let startEntry: IndexMapEntry | null = null;
  for (const entry of indexMap) {
    if (entry.mdOffset <= sectionMdStart) {
      startEntry = entry;
    } else {
      break;
    }
  }

  // Find the next section's start to determine end index
  const sectionIdx = allSections.indexOf(section);
  const nextSection = allSections[sectionIdx + 1];
  let endIndex = bodyEndIndex;

  if (nextSection) {
    const nextMdStart = computeMdOffset(nextSection, allSections);
    for (const entry of indexMap) {
      if (entry.mdOffset >= nextMdStart) {
        endIndex = entry.docIndex;
        break;
      }
    }
  }

  return {
    docStartIndex: startEntry?.docIndex ?? 1,
    docEndIndex: endIndex,
  };
}

/**
 * Compute the markdown character offset where a section starts in its
 * source document. parseSections consumes all lines up to (but not
 * including) the next heading line, so each section's content already
 * contains the trailing `\n` of its last line. Only one additional `\n`
 * separator remains between adjacent sections in the source.
 */
function computeMdOffset(section: MdSection, allSections: MdSection[]): number {
  let offset = 0;
  for (const s of allSections) {
    if (s === section) return offset;
    offset += s.content.length + 1;
  }
  return offset;
}

/**
 * Build an array mapping each line index in a section to its approximate
 * Google Doc index, using the indexMap entries.
 *
 * Each entry lineDocIndices[i] is the doc index where line i starts.
 *
 * Strategy: for each line, find the closest indexMap entry and use its
 * doc index directly if it's within a small tolerance. Otherwise
 * interpolate from the nearest entry. This avoids cumulative drift
 * from markdown formatting characters (e.g., "# " in headings) that
 * don't exist in the Google Doc.
 */
function buildLineDocIndices(
  lines: string[],
  sectionMdStart: number,
  indexMap: IndexMapEntry[],
  sectionDocEnd: number,
): number[] {
  const result: number[] = [];
  let mdOffset = sectionMdStart;
  const lastEntry = indexMap.length > 0 ? indexMap[indexMap.length - 1] : null;

  for (let i = 0; i < lines.length; i++) {
    let docIndex: number;
    // Past the last indexMap entry we are inside (or just past) the last
    // paragraph recorded for the doc. Within a paragraph markdown and doc
    // offsets advance 1:1, so extrapolate 1:1 from the last entry and clamp
    // to sectionDocEnd. Using the global local-ratio extrapolation here
    // undershoots (it re-applies heading/formatting drift that doesn't exist
    // past the last paragraph) and causes delete ranges to miss the tail
    // character of the replaced line.
    if (lastEntry && mdOffset > lastEntry.mdOffset) {
      docIndex = Math.min(
        lastEntry.docIndex + (mdOffset - lastEntry.mdOffset),
        sectionDocEnd,
      );
    } else {
      docIndex = interpolateDocIndex(mdOffset, indexMap, sectionDocEnd);
    }
    result.push(docIndex);
    mdOffset += lines[i].length + 1; // +1 for '\n'
  }

  return result;
}

/**
 * Map a markdown character offset to a Google Doc index using the index map.
 *
 * If the offset is near (within 5 chars) an index map entry, use its doc
 * index directly. Otherwise, linearly interpolate between the two
 * bracketing entries. This accounts for the fact that markdown formatting
 * chars (# , **, - [ ] , link syntax, etc.) don't exist in the doc, so a
 * 1:1 offset assumption accumulates drift over long documents.
 *
 * @param mdOffset - The markdown character offset to look up.
 * @param indexMap - Sorted array of {mdOffset, docIndex} entries.
 * @param fallback - Value to return when no interpolation is possible.
 */
export function interpolateDocIndex(
  mdOffset: number,
  indexMap: IndexMapEntry[],
  fallback: number,
): number {
  if (indexMap.length === 0) return fallback;

  // Find the closest entry
  let bestEntry: IndexMapEntry | null = null;
  let bestDist = Infinity;
  for (const entry of indexMap) {
    const dist = Math.abs(entry.mdOffset - mdOffset);
    if (dist < bestDist) {
      bestDist = dist;
      bestEntry = entry;
    }
  }

  // Near-exact match — use directly
  if (bestEntry && bestDist <= 5) {
    return bestEntry.docIndex;
  }

  // Find the two bracketing entries: preceding and following
  let preceding: IndexMapEntry | null = null;
  let following: IndexMapEntry | null = null;
  for (const entry of indexMap) {
    if (entry.mdOffset <= mdOffset) {
      preceding = entry;
    } else {
      following = entry;
      break;
    }
  }

  if (preceding && following) {
    // Interpolate between the two entries using the actual md→doc ratio
    const mdSpan = following.mdOffset - preceding.mdOffset;
    const docSpan = following.docIndex - preceding.docIndex;
    if (mdSpan > 0) {
      const t = (mdOffset - preceding.mdOffset) / mdSpan;
      return Math.round(preceding.docIndex + t * docSpan);
    }
    return preceding.docIndex;
  }

  if (preceding) {
    // Past the last entry — extrapolate, but clamp to fallback
    // Use the local ratio from the last two entries if available
    const prevIdx = indexMap.indexOf(preceding);
    if (prevIdx > 0) {
      const prev = indexMap[prevIdx - 1];
      const mdSpan = preceding.mdOffset - prev.mdOffset;
      const docSpan = preceding.docIndex - prev.docIndex;
      if (mdSpan > 0) {
        const ratio = docSpan / mdSpan;
        const extrapolated = preceding.docIndex + Math.round((mdOffset - preceding.mdOffset) * ratio);
        return Math.min(extrapolated, fallback);
      }
    }
    // Only one entry — clamp to fallback
    return Math.min(preceding.docIndex + (mdOffset - preceding.mdOffset), fallback);
  }

  if (following) {
    // Before the first entry — extrapolate backward
    return Math.max(1, following.docIndex - (following.mdOffset - mdOffset));
  }

  return fallback;
}

function getBodyEndIndex(document: docs_v1.Schema$Document): number {
  const body = document.body;
  if (!body?.content?.length) return 1;
  const last = body.content[body.content.length - 1];
  return last.endIndex ?? 1;
}

/**
 * True iff `index` is the startIndex of a non-paragraph structural
 * element (table, section break). Text insert/delete ops at such an
 * index are rejected by the Docs API ("insertion index must be inside
 * the bounds of an existing paragraph"). Callers that need to insert
 * at a paragraph boundary abutting a table — e.g. appending a bullet
 * right before a table — can use this to detect the case and shift
 * their insert one char earlier, into the preceding paragraph's \n.
 */
function isStructuralNonParagraphAt(
  document: docs_v1.Schema$Document,
  index: number,
): boolean {
  for (const elem of document.body?.content ?? []) {
    if (elem.startIndex === index && !elem.paragraph) {
      return true;
    }
  }
  return false;
}

/**
 * True iff the document contains any bullet-formatted paragraph.
 * When we insert content into an existing doc, the split that creates
 * the new paragraph can copy bullet formatting from the paragraph
 * being split — but only if some paragraph in the doc has a bullet in
 * the first place. Narrowing to per-insert "is this adjacent to a
 * bullet?" is fragile, because deletes within the same batch shift
 * what paragraph ends up at the insert position. A document-wide
 * check is a safe over-approximation: if there are no bullets at all,
 * we know for certain the clear is unnecessary, so we skip the extra
 * request. This keeps the minimal-edit request count small for plain
 * documents while still emitting the clear whenever bullets exist
 * anywhere nearby.
 */
function normalizeForNoOpCheck(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

function docHasAnyBullet(document: docs_v1.Schema$Document): boolean {
  for (const elem of document.body?.content ?? []) {
    if (elem.paragraph?.bullet) return true;
  }
  return false;
}

/**
 * Append the requests produced by markdownToDocsRequests to the batch,
 * interleaving a deleteParagraphBullets request between paragraph
 * styles and bullet creates when the insertion could inherit bullet
 * formatting from a surrounding paragraph. The clear runs AFTER the
 * paragraph-style updates land and BEFORE the bullet creates, so any
 * inherited bullet is stripped before the new content's own bullet (if
 * any) is re-applied.
 */
function appendWithBulletClear(
  out: docs_v1.Schema$Request[],
  insertRequests: docs_v1.Schema$Request[],
  document: docs_v1.Schema$Document,
  actualInsertAt: number,
  textLength: number,
): void {
  if (textLength === 0 || !docHasAnyBullet(document)) {
    out.push(...insertRequests);
    return;
  }
  const bullets = insertRequests.filter((r) => r.createParagraphBullets);
  const rest = insertRequests.filter((r) => !r.createParagraphBullets);
  out.push(...rest);
  out.push({
    deleteParagraphBullets: {
      range: {
        startIndex: actualInsertAt,
        endIndex: actualInsertAt + textLength,
      },
    },
  });
  out.push(...bullets);
}
