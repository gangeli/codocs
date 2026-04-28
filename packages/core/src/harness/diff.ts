/**
 * 3-way merge engine for syncing agent edits back to Google Docs.
 *
 * Uses section-level splitting (by headings) combined with node-diff3
 * for per-section 3-way merge. Untouched sections are taken verbatim
 * from "theirs" to preserve attribution and formatting.
 */

import { merge as diff3Merge, diffPatch } from 'node-diff3';
import type { docs_v1 } from 'googleapis';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import type { Root } from 'mdast';
import type { IndexMapEntry } from '../converter/element-parser.js';
import { markdownToDocsRequests } from '../converter/md-to-docs.js';
import { walkAst, type TextSegment } from '../converter/ast-walker.js';
import { createAttributionRequests } from '../attribution/named-ranges.js';
import { CODELANG_RANGE_PREFIX } from '../types.js';

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
  /**
   * Comment anchor texts (`quotedText` from comments) that the agent
   * tried to delete but were preserved by reverting their containing
   * section to the current doc state. Each entry is the anchor text
   * that survived. Empty when no anchors were at risk.
   */
  preservedAnchors: string[];
}

// Heading regex: line starting with 1-6 `#` followed by a space
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

const NULL_HEADING_KEY = '\0null';

/** Pair sections with straight positional `${heading}\0${occurrence}` keys. */
function sectionKeysPositional(
  sections: MdSection[],
): Array<{ key: string; section: MdSection }> {
  const counts = new Map<string, number>();
  return sections.map((s) => {
    const h = s.heading ?? NULL_HEADING_KEY;
    const n = counts.get(h) ?? 0;
    counts.set(h, n + 1);
    return { key: `${h}\0${n}`, section: s };
  });
}

/**
 * Pair sections with keys chosen RELATIVE TO a reference side (e.g. base,
 * or the current doc). Walks both sequences in order and greedily pairs
 * each `sections[i]` with the earliest remaining reference section that
 * matches, preferring content equality over a heading-only match. This
 * is a mini LCS that handles the common cases where positional-only
 * keying breaks:
 *
 *   - Duplicate heading, agent DELETED one: the surviving section gets
 *     paired with the right reference slot (by content if unedited, by
 *     "next reference with this heading" if also edited).
 *   - Sections that share a heading survive reordering (matched by
 *     content).
 *   - Brand-new sections allocate fresh occurrence-indices past the
 *     highest reference one for that heading.
 *
 * Reference sections that go unpaired keep their keys so callers can
 * still look them up by name (they represent sections only present in
 * the reference — i.e. deleted by the side we're keying).
 */
function sectionKeysRelativeTo(
  sections: MdSection[],
  reference: Array<{ key: string; section: MdSection }>,
): Array<{ key: string; section: MdSection }> {
  const refUsed = new Array(reference.length).fill(false);
  const refHeadings = reference.map(
    (e) => e.section.heading ?? NULL_HEADING_KEY,
  );
  const refCountByHeading = new Map<string, number>();
  for (const h of refHeadings) {
    refCountByHeading.set(h, (refCountByHeading.get(h) ?? 0) + 1);
  }

  const result: Array<{ key: string; section: MdSection }> = [];
  const freshCounters = new Map<string, number>();
  let refCursor = 0;

  for (const s of sections) {
    const h = s.heading ?? NULL_HEADING_KEY;

    // Pass 1: content-equality match, scanning from the cursor. Prefers
    // a same-heading reference section with IDENTICAL content. Skipping
    // a reference section here is OK — it means ours deleted it.
    let matchedIdx = -1;
    for (let bi = refCursor; bi < reference.length; bi++) {
      if (refUsed[bi]) continue;
      if (
        refHeadings[bi] === h &&
        reference[bi].section.content === s.content
      ) {
        matchedIdx = bi;
        break;
      }
    }

    // Pass 2: heading-only match (section was edited). Again from the
    // cursor forward — this is what gives T1 the right answer: after the
    // first `# Notes` is deleted and the survivor's body is ALSO
    // rewritten, content-match can't find it, but the cursor has already
    // advanced past the deleted slot so we pair with the NEXT `# Notes`.
    if (matchedIdx < 0) {
      for (let bi = refCursor; bi < reference.length; bi++) {
        if (refUsed[bi]) continue;
        if (refHeadings[bi] === h) {
          matchedIdx = bi;
          break;
        }
      }
    }

    if (matchedIdx >= 0) {
      refUsed[matchedIdx] = true;
      refCursor = matchedIdx + 1;
      result.push({ key: reference[matchedIdx].key, section: s });
    } else {
      // No reference match — section was added. Use a fresh
      // occurrence-index past the highest reference one for this heading.
      const refCount = refCountByHeading.get(h) ?? 0;
      const n = freshCounters.get(h) ?? refCount;
      freshCounters.set(h, n + 1);
      result.push({ key: `${h}\0${n}`, section: s });
    }
  }
  return result;
}

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
  const base = sectionKeysPositional(baseSections);
  const ours = sectionKeysRelativeTo(oursSections, base);
  const theirs = sectionKeysRelativeTo(theirsSections, base);

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
 * Safeguard: keep comment-anchor text alive across an agent edit.
 *
 * Google Docs comments are anchored to a text range. If a batchUpdate
 * deletes the bytes the anchor covers, the comment goes orphaned ("the
 * original content has been deleted"). The line-level diff already
 * preserves anchors that fall on UNCHANGED lines, but if the agent
 * rewrites or removes the very passage someone is commenting on, the
 * anchor disappears with it.
 *
 * For each anchor in `commentAnchors` that is present in `theirs` but
 * missing from the merged result, find the section that originally held
 * it and revert that section to the `theirs` content (or restore it
 * verbatim if the agent dropped the section entirely). The agent's
 * other edits stand. Returns the patched merged markdown plus the list
 * of anchors that were preserved.
 *
 * Anchors are matched by exact substring against section text; near-
 * misses (whitespace differences, partial overlap) are intentionally
 * not corrected for — we'd rather drop a marginal anchor than randomly
 * revert sections the agent meant to change.
 */
export function preserveCommentAnchors(
  mergedMarkdown: string,
  theirs: string,
  commentAnchors: string[],
): { mergedMarkdown: string; preservedAnchors: string[] } {
  const cleanAnchors = commentAnchors.filter((a) => a && a.length > 0);
  if (cleanAnchors.length === 0) {
    return { mergedMarkdown, preservedAnchors: [] };
  }

  const lostAnchors = cleanAnchors.filter(
    (a) => theirs.includes(a) && !mergedMarkdown.includes(a),
  );
  if (lostAnchors.length === 0) {
    return { mergedMarkdown, preservedAnchors: [] };
  }

  const theirsSections = parseSections(theirs);
  const mergedSections = parseSections(mergedMarkdown);

  const theirsKeyed = sectionKeysPositional(theirsSections);
  const mergedKeyed = sectionKeysRelativeTo(mergedSections, theirsKeyed);
  const theirsByKey = new Map<string, MdSection>();
  for (const e of theirsKeyed) theirsByKey.set(e.key, e.section);
  const mergedKeySet = new Set(mergedKeyed.map((e) => e.key));

  const preserved = new Set<string>();
  // Step 1: revert any merged section that would lose an anchor by
  // taking the agent's edit. Walks merged sections; each is paired
  // (by sectionKeysRelativeTo) with a theirs-side section, if any.
  const revisedSections: MdSection[] = mergedSections.slice();
  for (let i = 0; i < revisedSections.length; i++) {
    const merged = revisedSections[i];
    const theirsS = theirsByKey.get(mergedKeyed[i].key);
    if (!theirsS) continue;
    for (const anchor of lostAnchors) {
      if (theirsS.content.includes(anchor) && !merged.content.includes(anchor)) {
        revisedSections[i] = theirsS;
        preserved.add(anchor);
        break;
      }
    }
  }

  // Step 2: restore sections the agent deleted entirely if they held an
  // anchor. The restoration position is "right after the previous
  // theirs section that still appears in merged" — that keeps the
  // restored section anchored to its original neighbourhood.
  const findRevisedIndexByContent = (content: string): number =>
    revisedSections.findIndex((s) => s.content === content);

  type Restoration = { afterIdx: number; section: MdSection };
  const restorations: Restoration[] = [];
  for (let ti = 0; ti < theirsKeyed.length; ti++) {
    const { key, section } = theirsKeyed[ti];
    if (mergedKeySet.has(key)) continue;
    const anchorHere = lostAnchors.find((a) => section.content.includes(a));
    if (!anchorHere) continue;
    let afterIdx = -1;
    for (let pi = ti - 1; pi >= 0; pi--) {
      const idx = findRevisedIndexByContent(theirsKeyed[pi].section.content);
      if (idx >= 0) {
        afterIdx = idx;
        break;
      }
    }
    restorations.push({ afterIdx, section });
    preserved.add(anchorHere);
  }
  // Apply in descending order so earlier insertions don't shift later positions.
  restorations.sort((a, b) => b.afterIdx - a.afterIdx);
  for (const r of restorations) {
    revisedSections.splice(r.afterIdx + 1, 0, r.section);
  }

  if (preserved.size === 0) {
    return { mergedMarkdown, preservedAnchors: [] };
  }

  // Match the joining behaviour of mergeDocuments so the round-trip is
  // textually stable.
  const newMerged =
    revisedSections.map((s) => s.content).join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() +
    '\n';

  return { mergedMarkdown: newMerged, preservedAnchors: [...preserved] };
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
 * @param options - Extra knobs. `commentAnchors` lists the `quotedText`
 *   strings of comments anchored to the live doc; sections that would
 *   lose any of those anchors via this edit are reverted to the current
 *   doc state (see `preserveCommentAnchors`).
 */
export async function computeDocDiff(
  base: string,
  ours: string,
  theirs: string,
  document: docs_v1.Schema$Document,
  indexMap: IndexMapEntry[],
  agentName: string,
  resolveConflicts?: (conflictText: string) => Promise<string>,
  options?: { commentAnchors?: string[] },
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

  // Comment-anchor safeguard. Done after conflict resolution because the
  // agent's resolution itself can re-introduce or drop anchor text;
  // we only need to police the FINAL merged markdown.
  let preservedAnchors: string[] = [];
  if (options?.commentAnchors && options.commentAnchors.length > 0) {
    const safeguarded = preserveCommentAnchors(
      mergeResult.mergedMarkdown,
      theirs,
      options.commentAnchors,
    );
    if (safeguarded.preservedAnchors.length > 0) {
      mergeResult = {
        ...mergeResult,
        mergedMarkdown: safeguarded.mergedMarkdown,
      };
      preservedAnchors = safeguarded.preservedAnchors;
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
    return { hasChanges: false, requests: [], conflictsResolved, preservedAnchors };
  }

  // AST-level equivalence fallback: markdown variants that parse to the
  // same mdast (e.g. `_em_` vs `*em*`, `-` vs `*` list markers) hit this
  // path. Skipping these zero-impact diffs avoids a round-trip edit that
  // the reader would immediately re-canonicalize.
  if (
    canonicalizeMarkdown(mergeResult.mergedMarkdown) === canonicalizeMarkdown(theirs)
  ) {
    return { hasChanges: false, requests: [], conflictsResolved, preservedAnchors };
  }

  const bodyEndIndex = getBodyEndIndex(document);
  const requests: docs_v1.Schema$Request[] = [];

  // Pair theirs/merged sections by (heading, occurrence-index), with
  // content-equality fallback when the counts differ. Positional-only
  // keying collapses duplicate headings onto the first match and routes
  // edits to the wrong section; content-match keeps the survivor of a
  // duplicate-heading deletion paired with its true doc-side slot.
  const theirsKeyed = sectionKeysPositional(theirsSections);
  const mergedKeyed = sectionKeysRelativeTo(mergedSections, theirsKeyed);
  const theirsKeys = theirsKeyed.map((e) => e.key);
  const mergedKeys = mergedKeyed.map((e) => e.key);
  const theirsByKey = new Map<string, MdSection>();
  for (const e of theirsKeyed) theirsByKey.set(e.key, e.section);
  const mergedByKey = new Map<string, MdSection>();
  for (const e of mergedKeyed) mergedByKey.set(e.key, e.section);

  // Find sections that differ between theirs and merged
  const changedSections: Array<{
    theirsSection: MdSection | null;
    mergedSection: MdSection | null;
    docStartIndex: number;
    docEndIndex: number;
  }> = [];

  for (let mi = 0; mi < mergedSections.length; mi++) {
    const mergedS = mergedSections[mi];
    const theirsS = theirsByKey.get(mergedKeys[mi]) ?? null;
    if (!theirsS || theirsS.content !== mergedS.content) {
      let docRange;
      if (!theirsS) {
        // New section — its doc position is the start of the first
        // following merged section that also exists in `theirs`. If
        // no such neighbour exists (new section is last), append at body end.
        let docStartIndex = bodyEndIndex;
        for (let j = mi + 1; j < mergedSections.length; j++) {
          const nextTheirs = theirsByKey.get(mergedKeys[j]);
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
  for (let ti = 0; ti < theirsSections.length; ti++) {
    const theirsS = theirsSections[ti];
    if (!mergedByKey.has(theirsKeys[ti])) {
      const docRange = findSectionDocRange(
        theirsS,
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
        appendWithBulletClear(requests, insertRequests, document, actualInsertAt, text.length, insertAt);
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

    // Tables in the markdown don't correspond 1:1 to doc positions —
    // each markdown row is ONE line but each cell is a separate doc
    // paragraph, and the markdown "|---|---|" separator line has no
    // doc representation at all. Route hunks that fall inside a table
    // region to a structural handler that emits insertTableRow /
    // deleteTableRow / cell-scoped text edits; hunks outside tables
    // continue through the generic text-diff path below.
    const tableRegions = findTableRegionsInSection(
      oldLines,
      sectionMdStart,
      document,
      indexMap,
    );
    const blockquoteRegions = findBlockquoteRegionsInSection(
      oldLines,
      sectionMdStart,
      document,
      indexMap,
    );

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

      const tableRegion = findContainingTableRegion(
        oldOffset,
        oldLength,
        hunk.buffer2.chunk,
        tableRegions,
      );
      if (tableRegion) {
        emitTableHunkRequests(
          {
            oldOffset,
            oldLength,
            newChunk: hunk.buffer2.chunk,
          },
          tableRegion,
          oldLines,
          requests,
        );
        continue;
      }

      const blockquoteRegion = findContainingBlockquoteRegion(
        oldOffset,
        oldLength,
        hunk.buffer2.chunk,
        blockquoteRegions,
      );
      if (blockquoteRegion) {
        emitBlockquoteHunkRequests(
          {
            oldOffset,
            oldLength,
            newChunk: hunk.buffer2.chunk,
          },
          blockquoteRegion,
          requests,
        );
        continue;
      }

      if (
        tryEmitCodeFenceLangChange(
          { oldOffset, oldLength, newChunk: hunk.buffer2.chunk },
          oldLines,
          document,
          requests,
        )
      ) {
        continue;
      }


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

        // List-append fast path: when a pure-insert hunk contains only
        // bullet list items AND a bullet paragraph precedes the insert
        // (possibly with empty separator paragraphs in between), splice
        // the new items into that bullet paragraph's trailing \n. The
        // split creates new paragraphs that inherit the preceding
        // bullet's listId, so the appended items join the existing
        // list instead of starting a fresh one with their own bulletPreset.
        //
        // Going through the generic separator/markdownToDocsRequests path
        // doesn't work here: that flow's createParagraphBullets always
        // allocates a new listId, and any intermediate non-bullet
        // paragraph (like the blank line between a list and a table)
        // would absorb the split and the new items would inherit its
        // non-bullet state.
        const precedingBulletEnd = isPureInsert
          ? findPrecedingBulletEndIndex(document, insertAt)
          : null;
        if (precedingBulletEnd !== null && isAllBulletContent(newContent)) {
          const items = newContent
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map(stripBulletMarker);
          const combined = '\n' + items.join('\n');
          const insertPosition = precedingBulletEnd - 1;
          requests.push({
            insertText: {
              location: { index: insertPosition },
              text: combined,
            },
          });
          // Attribution covers the inserted text only (not the leading
          // \n that lives inside the preceding bullet paragraph).
          requests.push(
            ...createAttributionRequests(
              agentName,
              insertPosition + 1,
              insertPosition + combined.length,
            ),
          );
          continue;
        }
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

        // Compute content requests first so we know whether the
        // content is itself a bullet list — the separator size depends
        // on it.
        let actualInsertAt = insertAt;
        if (isAppendAtEnd) actualInsertAt = insertAt + 2;
        const { text, requests: insertRequests } = markdownToDocsRequests(
          newContent,
          actualInsertAt,
          false,
          bodyEndIndex,
        );

        const contentIsBullet = insertRequests.some((r) => r.createParagraphBullets);
        const adjacentIsBullet = isBulletParagraphAt(document, separatorAt);

        if (isAppendAtEnd) {
          requests.push({
            insertText: { location: { index: insertAt }, text: '\n\n' },
          });
        } else if (isPureInsert || needsTrailingNewline) {
          // Mid-section separator: inserted BEFORE the content at the
          // same index, so later content inserts push it to
          // `actualInsertAt + text.length` once processed sequentially.
          // Pure inserts normally need a blank-line separator (\n\n)
          // between the new paragraph and the following content.
          //
          // Exception: when we're appending a bullet item next to an
          // existing bulleted paragraph, the blank-line separator
          // breaks the list continuity (an intermediate empty
          // paragraph drops out of the list, so the new item lands
          // after it with its own listId). A single \n keeps the new
          // paragraph as the direct sibling of the neighbouring
          // bullet, inheriting the listId.
          const wantsBlankSeparator =
            isPureInsert && !(contentIsBullet && adjacentIsBullet);
          requests.push({
            insertText: {
              location: { index: separatorAt },
              text: wantsBlankSeparator ? '\n\n' : '\n',
            },
          });
        }

        appendWithBulletClear(requests, insertRequests, document, actualInsertAt, text.length, separatorAt);

        if (text.length > 0) {
          requests.push(...createAttributionRequests(agentName, actualInsertAt, actualInsertAt + text.length));
        }
      }
    }
  }

  return { hasChanges: requests.length > 0, requests, conflictsResolved, preservedAnchors };
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

// AST-based canonicalizer: parse with remark + GFM, inline reference
// links into their resolved URLs, then stringify with fixed options.
// Two markdown strings that parse to the same AST (e.g. `_em_` vs `*em*`,
// `-` vs `*` list markers, `[foo][r]\n\n[r]: url` vs `[foo](url)`)
// canonicalize to the same output. Used as a semantic-equivalence
// fallback in the no-op gate when the cheap trailing-whitespace check
// fails.
//
// `any` here sidesteps unified's precise processor generics — the chain
// `parse → GFM plugin → stringify` tightens the type to one we only need
// to round-trip strings through. The processSync input/output are always
// string ↔ string at runtime; the types just don't line up across the
// plugin boundaries without verbose generic parameters.

/** Walk the mdast tree: collect `definition` nodes and rewrite every
 *  `linkReference` / `imageReference` into its inline equivalent. This
 *  matches what most serializers emit anyway and makes the two forms
 *  canonicalize to the same output. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inlineReferencesPlugin(): (tree: any) => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defs = new Map<string, { url: string; title?: string }>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function collect(node: any) {
      if (node?.type === 'definition' && typeof node.identifier === 'string') {
        defs.set(node.identifier.toLowerCase(), {
          url: node.url ?? '',
          title: node.title ?? undefined,
        });
      }
      if (Array.isArray(node?.children)) {
        for (const c of node.children) collect(c);
      }
    }
    collect(tree);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function transform(node: any) {
      if (!Array.isArray(node?.children)) return;
      node.children = node.children
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((child: any) => {
          if (child.type === 'linkReference') {
            const def = defs.get((child.identifier ?? '').toLowerCase());
            if (def) {
              return {
                type: 'link',
                url: def.url,
                title: def.title,
                children: child.children ?? [],
              };
            }
          }
          if (child.type === 'imageReference') {
            const def = defs.get((child.identifier ?? '').toLowerCase());
            if (def) {
              return {
                type: 'image',
                url: def.url,
                title: def.title,
                alt: child.alt ?? '',
              };
            }
          }
          return child;
        })
        // Drop the definition nodes themselves — they're redundant once
        // every reference has been inlined.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((child: any) => child.type !== 'definition');
      for (const c of node.children) transform(c);
    }
    transform(tree);
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _canonicalizer: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCanonicalizer(): any {
  if (!_canonicalizer) {
    _canonicalizer = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(() => inlineReferencesPlugin())
      .use(remarkStringify, {
        bullet: '-',
        emphasis: '*',
        strong: '*',
        rule: '-',
        fence: '`',
        fences: true,
        listItemIndent: 'one',
      });
  }
  return _canonicalizer;
}

function canonicalizeMarkdown(md: string): string {
  try {
    // Unicode NFC normalization treats different code-point sequences
    // that encode the same grapheme (e.g. `é` as U+00E9 vs e + U+0301)
    // as equal, so a formatting-only edit between the two variants is
    // detected as a no-op instead of firing a real diff.
    return String(getCanonicalizer().processSync(md)).normalize('NFC');
  } catch {
    // If remark throws on exotic input, fall back to the raw string so
    // the caller's equality check still runs deterministically.
    return md.normalize('NFC');
  }
}

function docHasAnyBullet(document: docs_v1.Schema$Document): boolean {
  for (const elem of document.body?.content ?? []) {
    if (elem.paragraph?.bullet) return true;
  }
  return false;
}

/**
 * True iff `index` falls inside a bullet-formatted paragraph in the
 * original doc. Used to decide whether inserted content that will
 * inherit the split paragraph's bullet (via our separator-\n split)
 * should keep that inheritance.
 */
function isBulletParagraphAt(
  document: docs_v1.Schema$Document,
  index: number,
): boolean {
  for (const elem of document.body?.content ?? []) {
    if (!elem.paragraph?.bullet) continue;
    if (elem.startIndex == null || elem.endIndex == null) continue;
    if (index >= elem.startIndex && index <= elem.endIndex) return true;
  }
  return false;
}

/**
 * Return the endIndex of the closest bullet-formatted paragraph that
 * ends at or before `index`, as long as every element between that
 * bullet and `index` is either an empty paragraph or the paragraph
 * we're about to edit (i.e. there's no non-empty, non-bullet content
 * in the way). A valid candidate means appending a new bullet item
 * there by inserting a `\n` at the bullet's terminating \n will land
 * the new paragraph inside the same list.
 *
 * The walk stops at the first non-empty non-bullet paragraph or any
 * non-paragraph structural element (table, section break) before
 * `index` — inserting through those would create a new paragraph in
 * the wrong spot or at an invalid index.
 */
function findPrecedingBulletEndIndex(
  document: docs_v1.Schema$Document,
  index: number,
): number | null {
  let lastBulletEnd: number | null = null;
  for (const elem of document.body?.content ?? []) {
    if (elem.startIndex == null || elem.endIndex == null) continue;
    if (elem.startIndex >= index) break;
    if (elem.paragraph?.bullet) {
      lastBulletEnd = elem.endIndex;
      continue;
    }
    if (elem.paragraph) {
      const text = (elem.paragraph.elements ?? [])
        .map((x) => x.textRun?.content ?? '')
        .join('');
      if (text.trim() !== '') lastBulletEnd = null;
      continue;
    }
    // Table / section break — not skippable for list-append purposes.
    lastBulletEnd = null;
  }
  return lastBulletEnd;
}

/** True iff every non-empty line of `markdown` looks like a bullet
 *  list item (`-`, `*`, `+`, or `N.`). Used to decide whether a
 *  pure-insert hunk can take the list-append fast path. */
function isAllBulletContent(markdown: string): boolean {
  const lines = markdown.split('\n');
  let sawBullet = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') continue;
    if (/^(?:[-*+]|\d+\.)\s/.test(t)) {
      sawBullet = true;
      continue;
    }
    return false;
  }
  return sawBullet;
}

/** Strip the leading list marker (`-`, `*`, `+`, or `N.`) and its
 *  following whitespace from a markdown bullet line, returning just
 *  the cell text. */
function stripBulletMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
}

/**
 * Handle a one-line hunk that only changes a code-fence language tag
 * (e.g. ```` ```python```` → ```` ```typescript````). The fence itself
 * is a markdown rendering artefact — it's not a line in the doc — so
 * the generic text-diff path would misfire, landing a delete+insert on
 * the FIRST code-content paragraph instead. The language is stored as
 * a named range `codelang:<lang>` covering the fenced paragraphs; to
 * switch tags, delete the old range and create a new one at the same
 * doc indices.
 *
 * Returns true when the hunk was a lang-change (fully handled here).
 * Returns false for any other shape — including a `codelang:<oldLang>`
 * range that can't be located in the current doc, so the caller can
 * still fall through to the generic path.
 */
function tryEmitCodeFenceLangChange(
  hunk: { oldOffset: number; oldLength: number; newChunk: string[] },
  oldLines: string[],
  document: docs_v1.Schema$Document,
  requests: docs_v1.Schema$Request[],
): boolean {
  if (hunk.oldLength !== 1 || hunk.newChunk.length !== 1) return false;
  const oldLine = oldLines[hunk.oldOffset];
  const newLine = hunk.newChunk[0];
  // Fence opener: optional indent + 3+ backticks or tildes + optional
  // info string (lang tag). Only a lang-tag change counts here — if
  // the fence itself differs (```` ``` ```` vs ```` ~~~ ````) we'd
  // need to rewrite content too, so bail out.
  const FENCE = /^ {0,3}(`{3,}|~{3,})(\S*)\s*$/;
  const om = oldLine.match(FENCE);
  const nm = newLine.match(FENCE);
  if (!om || !nm) return false;
  if (om[1] !== nm[1]) return false; // fence char changed; not handled
  const oldLang = om[2];
  const newLang = nm[2];
  if (oldLang === newLang) return false;

  // Locate the existing codelang:<oldLang> range in the doc.
  const oldName = CODELANG_RANGE_PREFIX + oldLang;
  const nrData = document.namedRanges?.[oldName];
  const first = nrData?.namedRanges?.[0]?.ranges?.[0];
  if (!first || first.startIndex == null || first.endIndex == null) {
    // No existing range to rewrite — either the writer skipped emitting
    // it (empty lang on the original) or we can't find it. Let the
    // caller's generic path run; at worst that's the same as today's
    // behaviour, not a regression.
    return false;
  }
  requests.push({ deleteNamedRange: { name: oldName } });
  if (newLang.length > 0) {
    requests.push({
      createNamedRange: {
        name: CODELANG_RANGE_PREFIX + newLang,
        range: { startIndex: first.startIndex, endIndex: first.endIndex },
      },
    });
  }
  return true;
}

/**
 * Append the requests produced by markdownToDocsRequests to the batch,
 * interleaving a deleteParagraphBullets request between paragraph
 * styles and bullet creates when the insertion could inherit bullet
 * formatting from a surrounding paragraph. The clear runs AFTER the
 * paragraph-style updates land and BEFORE the bullet creates, so any
 * inherited bullet is stripped before the new content's own bullet (if
 * any) is re-applied.
 *
 * Special case: when the inserted content is itself a bullet list AND
 * the separator lands inside a bullet paragraph, we skip BOTH the
 * clear and our own create — and also the updateParagraphStyle that
 * walkParagraph emits for the list item's content. Our
 * createParagraphBullets would otherwise start a NEW list (the
 * bulletPreset API has no way to reference an existing listId), and
 * the updateParagraphStyle (even with fields: 'namedStyleType') also
 * drops the paragraph out of the list in practice. The separator
 * split leaves the new paragraph already in the neighbour's list —
 * exactly what the user wrote ("append bullet to the existing list"),
 * so letting that inheritance stand makes the appended item join the
 * run instead of starting a fresh one.
 */
function appendWithBulletClear(
  out: docs_v1.Schema$Request[],
  insertRequests: docs_v1.Schema$Request[],
  document: docs_v1.Schema$Document,
  actualInsertAt: number,
  textLength: number,
  separatorAt: number,
): void {
  if (textLength === 0 || !docHasAnyBullet(document)) {
    out.push(...insertRequests);
    return;
  }
  const contentIsBullet = insertRequests.some((r) => r.createParagraphBullets);
  const adjacentIsBullet = isBulletParagraphAt(document, separatorAt);
  if (contentIsBullet && adjacentIsBullet) {
    out.push(
      ...insertRequests.filter(
        (r) => !r.createParagraphBullets && !r.updateParagraphStyle,
      ),
    );
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

// ── Table-aware hunk handling ────────────────────────────────────
//
// Markdown tables don't round-trip to the Docs table structure through
// the line-diff path: one markdown row is *one* line but each cell is a
// separate doc paragraph, and the markdown `|---|` separator row has no
// doc representation at all. Naively inserting or deleting text at a
// table row's notional "doc index" either lands at the table's
// structural startIndex (rejected as "not inside a paragraph") or spans
// multiple cell paragraphs in a way the Docs API forbids.
//
// Instead, when a line-diff hunk falls inside a markdown table region
// we classify the hunk shape and emit structural Docs requests:
//   - Cell text edit (row count unchanged, cell content differs):
//     delete + insert inside the cell's paragraph range.
//   - Row addition (pure insert of `|…|` lines): `insertTableRow`
//     pointing at the adjacent existing row, then `insertText` for
//     each cell (reverse column order to keep indices stable).
//   - Row deletion (pure delete of `|…|` lines): `deleteTableRow`
//     for each row (reverse row order for the same reason).
//
// The markdown separator line (`| --- | --- |`) is treated as a
// non-doc line — hunks that only touch the separator are no-ops, and
// row indices in the doc are computed with the separator subtracted.
//
// Out of scope (falls through to the generic line-diff path; may fail
// depending on the specific shape): column additions/removals, edits
// that cross table boundaries, inline formatting inside cell edits
// (cell text is inserted verbatim; any markdown markers in it render
// as literal characters).

/** A markdown table detected inside a section, bound to its doc-side
 *  Schema$Table object for looking up cell paragraph indices. */
interface TableRegion {
  /** Inclusive: markdown line index of the header row. */
  startLine: number;
  /** Markdown line index of the `| --- |` separator (not a doc row). */
  separatorLine: number;
  /** Inclusive: markdown line index of the last data row. */
  endLine: number;
  /** Doc index of the table's structural element. */
  docStartIndex: number;
  /** Live table reference — used to look up per-cell paragraph ranges. */
  table: docs_v1.Schema$Table;
}

/** Lines that look like a table separator: `|`, dashes/colons, `|`. */
const TABLE_SEPARATOR_RE = /^\|[\s|:\-]+\|$/;

function isTableRowLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length >= 2;
}

function isTableSeparatorLine(line: string): boolean {
  return TABLE_SEPARATOR_RE.test(line.trim());
}

/** Parse a markdown table row's cells: strip the leading/trailing `|`
 *  and split on inner `|`, trimming each cell. Empty line returns []. */
function parseTableRowCells(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return [];
  const inner = t.slice(1, -1);
  return inner.split('|').map((c) => c.trim());
}

/**
 * Walk the section's lines and detect each markdown table. Each region
 * binds its markdown line range to the Schema$Table in the live doc
 * (looked up by the table's structural startIndex from the indexMap).
 * Regions without a matching doc-side table are silently dropped —
 * callers fall back to the generic line-diff path for them.
 */
function findTableRegionsInSection(
  sectionLines: string[],
  sectionMdStart: number,
  document: docs_v1.Schema$Document,
  indexMap: IndexMapEntry[],
): TableRegion[] {
  const regions: TableRegion[] = [];
  let mdOffset = sectionMdStart;
  let i = 0;
  while (i < sectionLines.length) {
    const header = sectionLines[i];
    const next = i + 1 < sectionLines.length ? sectionLines[i + 1] : '';
    if (isTableRowLine(header) && isTableSeparatorLine(next)) {
      let endLine = i + 1;
      while (endLine + 1 < sectionLines.length && isTableRowLine(sectionLines[endLine + 1])) {
        endLine++;
      }

      const headerMdOffset = mdOffset;
      const docStartIndex = lookupDocIndexAt(indexMap, headerMdOffset);
      const tableElem = docStartIndex != null ? findTableElementAt(document, docStartIndex) : null;
      if (docStartIndex != null && tableElem) {
        regions.push({
          startLine: i,
          separatorLine: i + 1,
          endLine,
          docStartIndex,
          table: tableElem,
        });
      }

      for (let k = i; k <= endLine; k++) {
        mdOffset += sectionLines[k].length + 1;
      }
      i = endLine + 1;
    } else {
      mdOffset += sectionLines[i].length + 1;
      i++;
    }
  }
  return regions;
}

function lookupDocIndexAt(indexMap: IndexMapEntry[], mdOffset: number): number | null {
  // indexMap entries land on structural-element mdOffsets; allow a
  // small tolerance because heading/bullet prefix stripping shifts
  // the offset by up to the prefix length.
  let best: IndexMapEntry | null = null;
  let bestDist = Infinity;
  for (const entry of indexMap) {
    const dist = Math.abs(entry.mdOffset - mdOffset);
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return best && bestDist <= 5 ? best.docIndex : null;
}

function findTableElementAt(
  document: docs_v1.Schema$Document,
  startIndex: number,
): docs_v1.Schema$Table | null {
  for (const elem of document.body?.content ?? []) {
    if (elem.startIndex === startIndex && elem.table) {
      return elem.table;
    }
  }
  return null;
}

/**
 * Map a markdown line index to the 0-based row index in the Docs
 * table. Header is row 0; the `| --- |` separator has no doc row
 * (returns null); any row after the separator is `mdLine -
 * separatorLine` (so separatorLine+1 is row 1, +2 is row 2, …).
 * Returns null for mdLine values outside the region.
 */
function mdLineToDocRow(region: TableRegion, mdLine: number): number | null {
  if (mdLine === region.startLine) return 0;
  if (mdLine === region.separatorLine) return null;
  if (mdLine > region.separatorLine && mdLine <= region.endLine) {
    return mdLine - region.separatorLine;
  }
  return null;
}

/** Find the row whose endIndex points to `mdLine - separatorLine = k`
 *  in the doc — the row in which `insertTableRow below` should anchor
 *  or `deleteTableRow` should target. Mirrors mdLineToDocRow with
 *  bounds checking against the live table. */
function cellParagraphRange(
  table: docs_v1.Schema$Table,
  row: number,
  col: number,
): { startIndex: number; endIndex: number } | null {
  const r = table.tableRows?.[row];
  if (!r) return null;
  const c = r.tableCells?.[col];
  if (!c) return null;
  const firstPara = c.content?.[0];
  if (!firstPara?.paragraph || firstPara.startIndex == null || firstPara.endIndex == null) {
    return null;
  }
  return { startIndex: firstPara.startIndex, endIndex: firstPara.endIndex };
}

/**
 * Classify a hunk's relationship to the section's table regions.
 * Returns the region containing the hunk if the entire hunk is inside
 * a table (including pure inserts that land at `endLine + 1`), or
 * null if the hunk should fall through to the generic line-diff path.
 *
 * A hunk counts as "inside" a table only if BOTH the old lines it
 * covers AND every new line it would emit are table rows or the
 * separator. That keeps hunks that mix table and non-table content on
 * the safe fallback path.
 */
function findContainingTableRegion(
  oldOffset: number,
  oldLength: number,
  newChunk: string[],
  regions: TableRegion[],
): TableRegion | null {
  for (const region of regions) {
    const oldStart = oldOffset;
    const oldEnd = oldOffset + oldLength; // exclusive
    let oldInside: boolean;
    if (oldLength === 0) {
      // Pure insert: inside if landing anywhere from the header row up
      // to one past the last row (appending after the table).
      oldInside = oldStart >= region.startLine && oldStart <= region.endLine + 1;
    } else {
      oldInside = oldStart >= region.startLine && oldEnd - 1 <= region.endLine;
    }
    if (!oldInside) continue;

    const allNewAreTableLike = newChunk.every(
      (l) => isTableRowLine(l) || isTableSeparatorLine(l),
    );
    if (!allNewAreTableLike) return null;
    return region;
  }
  return null;
}

/**
 * Emit structural Docs requests for a hunk that falls inside a table
 * region. The hunk's shape determines which kind of ops we emit:
 *
 *   - Pure insert (oldLength === 0): each new `|…|` chunk line becomes
 *     an insertTableRow + per-cell insertText. Rows are processed in
 *     reverse so earlier inserts don't shift later ones.
 *   - Pure delete (newChunk empty or all empty strings): each
 *     corresponding doc row is removed via deleteTableRow, reverse order.
 *   - Replacement: we pair each old doc row with a new row from the
 *     chunk (ignoring any separator lines on either side) and emit a
 *     cell text edit for every cell whose content changed. If the new
 *     content has more rows than the old, the extras are appended via
 *     insertTableRow; fewer new rows triggers deleteTableRow for the
 *     trailing old rows.
 */
function emitTableHunkRequests(
  hunk: { oldOffset: number; oldLength: number; newChunk: string[] },
  region: TableRegion,
  oldLines: string[],
  requests: docs_v1.Schema$Request[],
): void {
  const oldDocRows: Array<{ mdLine: number; docRow: number; cells: string[] }> = [];
  for (let i = 0; i < hunk.oldLength; i++) {
    const mdLine = hunk.oldOffset + i;
    const docRow = mdLineToDocRow(region, mdLine);
    if (docRow === null) continue; // skip separator
    oldDocRows.push({ mdLine, docRow, cells: parseTableRowCells(oldLines[mdLine]) });
  }

  const newDocRows: string[][] = [];
  for (const line of hunk.newChunk) {
    if (isTableSeparatorLine(line) || !isTableRowLine(line)) continue;
    newDocRows.push(parseTableRowCells(line));
  }

  // Shape: all old rows deleted, no replacement → row deletions.
  if (newDocRows.length === 0 && oldDocRows.length > 0) {
    for (let i = oldDocRows.length - 1; i >= 0; i--) {
      requests.push({
        deleteTableRow: {
          tableCellLocation: {
            tableStartLocation: { index: region.docStartIndex },
            rowIndex: oldDocRows[i].docRow,
            columnIndex: 0,
          },
        },
      });
    }
    return;
  }

  // Shape: pure insert (no old rows covered) → row additions after the
  // row preceding the insert point. Anchor is the last doc row before
  // hunk.oldOffset (clamped to 0 if the insert lands on the header).
  if (oldDocRows.length === 0 && newDocRows.length > 0) {
    const anchorMdLine = Math.min(hunk.oldOffset - 1, region.endLine);
    const anchorDocRow =
      anchorMdLine < region.startLine
        ? 0
        : mdLineToDocRow(region, anchorMdLine) ?? 0;
    // Insert in reverse so earlier rows aren't shifted by later ones.
    for (let r = newDocRows.length - 1; r >= 0; r--) {
      emitInsertTableRow(region, anchorDocRow, newDocRows[r], r, requests);
    }
    return;
  }

  // Shape: replacement — pair old and new rows by position. Cells that
  // changed become text edits scoped to their cell paragraph. Extra
  // new rows are appended; extra old rows are deleted.
  const pairCount = Math.min(oldDocRows.length, newDocRows.length);
  // Iterate pairs in reverse so delete+insert ops on later rows don't
  // shift the indices of earlier rows' cell paragraphs.
  for (let i = pairCount - 1; i >= 0; i--) {
    emitCellEdits(region, oldDocRows[i].docRow, oldDocRows[i].cells, newDocRows[i], requests);
  }
  if (newDocRows.length > oldDocRows.length) {
    const anchorDocRow = oldDocRows[oldDocRows.length - 1]?.docRow ?? 0;
    for (let r = newDocRows.length - 1; r >= oldDocRows.length; r--) {
      emitInsertTableRow(region, anchorDocRow, newDocRows[r], r - oldDocRows.length, requests);
    }
  } else if (oldDocRows.length > newDocRows.length) {
    for (let i = oldDocRows.length - 1; i >= newDocRows.length; i--) {
      requests.push({
        deleteTableRow: {
          tableCellLocation: {
            tableStartLocation: { index: region.docStartIndex },
            rowIndex: oldDocRows[i].docRow,
            columnIndex: 0,
          },
        },
      });
    }
  }
}

/**
 * Emit a cell text edit: for each column whose old cell differs from
 * the new cell, replace the cell paragraph's text. Process columns in
 * reverse so later-column edits don't shift earlier-column cell
 * paragraph indices.
 */
function emitCellEdits(
  region: TableRegion,
  docRow: number,
  oldCells: string[],
  newCells: string[],
  requests: docs_v1.Schema$Request[],
): void {
  const maxCol = Math.min(oldCells.length, newCells.length);
  for (let c = maxCol - 1; c >= 0; c--) {
    if (oldCells[c] === newCells[c]) continue;
    const range = cellParagraphRange(region.table, docRow, c);
    if (!range) continue;
    // Delete existing cell text (everything up to the cell paragraph's
    // trailing \n). The paragraph is [start, end); the \n is at end-1.
    if (range.endIndex - 1 > range.startIndex) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: range.startIndex, endIndex: range.endIndex - 1 },
        },
      });
    }
    if (newCells[c].length > 0) {
      // Parse the cell's markdown for inline styles (bold, italic,
      // code, link, …). Without this, the new text gets a literal
      // `**new** text` and Docs also re-inherits the DELETED text's
      // trailing style (a bold run from the original cell makes the
      // entire inserted text bold). We insert plain text, clear the
      // inherited inline styles on the inserted range, then re-apply
      // the agent's intended inline styles from the parsed markdown.
      const { text, styles } = parseCellInlineMarkdown(newCells[c]);
      requests.push({
        insertText: { location: { index: range.startIndex }, text },
      });
      if (text.length > 0) {
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: range.startIndex,
              endIndex: range.startIndex + text.length,
            },
            textStyle: {},
            fields:
              'bold,italic,strikethrough,underline,link,' +
              'weightedFontFamily,foregroundColor,backgroundColor',
          },
        });
      }
      for (const style of styles) {
        if (style.updateTextStyle?.range) {
          const r = style.updateTextStyle.range;
          r.startIndex = (r.startIndex ?? 0) + range.startIndex;
          r.endIndex = (r.endIndex ?? 0) + range.startIndex;
          requests.push(style);
        }
      }
    }
  }
}

/** Parse an inline-markdown cell string (e.g. `**new** text`) into
 *  plain text + inline-style requests with ranges relative to the
 *  text's start. Only text-level styles are returned; paragraph-level
 *  styles from the walker (NORMAL_TEXT, etc.) are dropped because the
 *  surrounding cell paragraph already has its own style. */
function parseCellInlineMarkdown(
  md: string,
): { text: string; styles: docs_v1.Schema$Request[] } {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(md) as Root;
  const { segments } = walkAst(tree);
  const textSeg = segments.find((s) => s.type === 'text') as
    | TextSegment
    | undefined;
  if (!textSeg) return { text: '', styles: [] };
  // walkAst adds a trailing \n via ensureNewline; strip for cell context.
  const text = textSeg.text.replace(/\n+$/, '');
  const styles = textSeg.styles.filter((s) => s.updateTextStyle);
  return { text, styles };
}

/**
 * Emit a single `insertTableRow` + per-cell `insertText` sequence to
 * add a new row after `anchorDocRow` in the live table. `newRowOffset`
 * is the row's position among the rows being inserted in this batch
 * (0-based, relative to the anchor). Used to compute the cell
 * paragraph positions of the new row from the anchor's endIndex.
 */
function emitInsertTableRow(
  region: TableRegion,
  anchorDocRow: number,
  cells: string[],
  newRowOffset: number,
  requests: docs_v1.Schema$Request[],
): void {
  const anchorRow = region.table.tableRows?.[anchorDocRow];
  if (!anchorRow || anchorRow.endIndex == null) return;
  const C = cells.length;

  requests.push({
    insertTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: region.docStartIndex },
        rowIndex: anchorDocRow,
        columnIndex: 0,
      },
      insertBelow: true,
    },
  });

  // Each newly inserted row occupies 1 (row) + 2*C (cells) indices in
  // the doc, and an empty cell paragraph is at newRowStart + 2 + 2c.
  // When we insert multiple rows in the same batch (reverse order),
  // the new row at offset `newRowOffset` from the anchor lands
  // `newRowOffset * (1 + 2*C)` past the anchor's endIndex.
  const rowSize = 1 + 2 * C;
  const newRowStart = anchorRow.endIndex + newRowOffset * rowSize;

  // Insert cell text in reverse column order so earlier cells' doc
  // indices aren't shifted by later cells' inserts.
  for (let c = C - 1; c >= 0; c--) {
    if (cells[c].length === 0) continue;
    const cellParagraphAt = newRowStart + 2 + 2 * c;
    requests.push({
      insertText: {
        location: { index: cellParagraphAt },
        text: cells[c],
      },
    });
  }
}

// ── Blockquote handling ─────────────────────────────────────
//
// Blockquotes round-trip through a 1×1 table with a thick left border
// (see writer/element-parser for the exact shape). Each markdown `> line`
// in readback corresponds to one paragraph inside the single cell. The
// generic line-diff path doesn't know about this: it tries to delete a
// range that spans the table's structural indices, which Docs rejects
// with "Invalid deletion range". Detect blockquote regions here and
// emit cell-paragraph-scoped text edits instead.

/** A run of consecutive `>`-prefixed lines mapped to a 1×1 blockquote
 *  table in the live doc. */
interface BlockquoteRegion {
  /** Inclusive: markdown line index of the first `>` line. */
  startLine: number;
  /** Inclusive: markdown line index of the last `>` line. */
  endLine: number;
  /** Doc index of the table's structural element. */
  docStartIndex: number;
  /** Live table reference — used to look up cell paragraph ranges. */
  table: docs_v1.Schema$Table;
}

function isBlockquoteLine(line: string): boolean {
  return /^>($|\s)/.test(line);
}

/** Structural fingerprint matching the writer's blockquote: 1×1 table
 *  with a 3pt left border and no other borders. */
function isBlockquoteTableShape(table: docs_v1.Schema$Table): boolean {
  const rows = table.tableRows ?? [];
  if (rows.length !== 1) return false;
  const cells = rows[0].tableCells ?? [];
  if (cells.length !== 1) return false;
  const s = cells[0].tableCellStyle;
  if (!s) return false;
  const w = (b?: docs_v1.Schema$TableCellBorder) => b?.width?.magnitude ?? 0;
  return (
    w(s.borderLeft) === 3 &&
    w(s.borderTop) === 0 &&
    w(s.borderRight) === 0 &&
    w(s.borderBottom) === 0
  );
}

function findBlockquoteRegionsInSection(
  sectionLines: string[],
  sectionMdStart: number,
  document: docs_v1.Schema$Document,
  indexMap: IndexMapEntry[],
): BlockquoteRegion[] {
  const regions: BlockquoteRegion[] = [];
  let mdOffset = sectionMdStart;
  let i = 0;
  while (i < sectionLines.length) {
    if (isBlockquoteLine(sectionLines[i])) {
      const startLine = i;
      const startMdOffset = mdOffset;
      let endLine = i;
      while (i < sectionLines.length && isBlockquoteLine(sectionLines[i])) {
        endLine = i;
        mdOffset += sectionLines[i].length + 1;
        i++;
      }
      const docStartIndex = lookupDocIndexAt(indexMap, startMdOffset);
      const tableElem =
        docStartIndex != null ? findTableElementAt(document, docStartIndex) : null;
      if (docStartIndex != null && tableElem && isBlockquoteTableShape(tableElem)) {
        regions.push({ startLine, endLine, docStartIndex, table: tableElem });
      }
    } else {
      mdOffset += sectionLines[i].length + 1;
      i++;
    }
  }
  return regions;
}

function findContainingBlockquoteRegion(
  oldOffset: number,
  oldLength: number,
  newChunk: string[],
  regions: BlockquoteRegion[],
): BlockquoteRegion | null {
  const newAllBq = newChunk.every((l) => isBlockquoteLine(l));
  if (!newAllBq) return null;
  for (const region of regions) {
    if (oldLength === 0) {
      // Pure insert inside (or immediately after) the region.
      if (oldOffset >= region.startLine && oldOffset <= region.endLine + 1) {
        return region;
      }
      continue;
    }
    const oldEnd = oldOffset + oldLength - 1;
    if (oldOffset >= region.startLine && oldEnd <= region.endLine) {
      return region;
    }
  }
  return null;
}

/** Strip one leading `> ` (or bare `>`) prefix from a blockquote line. */
function stripBlockquotePrefix(line: string): string {
  const m = line.match(/^>\s?(.*)$/);
  return m ? m[1] : line;
}

/** Emit cell-paragraph text edits for a hunk inside a blockquote
 *  region. Assumes 1:1 markdown-line ↔ cell-paragraph correspondence
 *  (true when each cell paragraph's markdown form has no internal
 *  newlines — which covers single-line quoted paragraphs). */
function emitBlockquoteHunkRequests(
  hunk: { oldOffset: number; oldLength: number; newChunk: string[] },
  region: BlockquoteRegion,
  requests: docs_v1.Schema$Request[],
): void {
  const cell = region.table.tableRows?.[0]?.tableCells?.[0];
  type CellPara = { startIndex: number; endIndex: number; bullet: boolean };
  const cellParagraphs: CellPara[] = [];
  for (const el of cell?.content ?? []) {
    if (!el.paragraph) continue;
    if (el.startIndex != null && el.endIndex != null) {
      cellParagraphs.push({
        startIndex: el.startIndex,
        endIndex: el.endIndex,
        bullet: !!el.paragraph.bullet,
      });
    }
  }

  // Each new chunk line: strip `> ` prefix; if the counterpart cell
  // paragraph is bulleted, also strip the `- ` marker so we don't
  // double-apply it (the paragraph's bullet style re-renders it on
  // readback).
  const prefixStripped = hunk.newChunk.map(stripBlockquotePrefix);
  const pairCount = Math.min(hunk.oldLength, prefixStripped.length);

  // Replacement pairs: edit existing cell paragraphs.
  for (let i = pairCount - 1; i >= 0; i--) {
    const paraIdx = hunk.oldOffset + i - region.startLine;
    const para = cellParagraphs[paraIdx];
    if (!para) continue;
    const text = para.bullet ? stripBulletMarker(prefixStripped[i]) : prefixStripped[i];
    if (para.endIndex - 1 > para.startIndex) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: para.startIndex, endIndex: para.endIndex - 1 },
        },
      });
    }
    if (text.length > 0) {
      requests.push({
        insertText: {
          location: { index: para.startIndex },
          text,
        },
      });
    }
  }

  // Pure-insert: add new paragraphs to the cell. The anchor paragraph
  // is the one IMMEDIATELY BEFORE the insert point (line
  // `hunk.oldOffset - 1` in markdown); for inserts at the region's
  // very start, anchorIdx is -1 and we prepend inside the cell's first
  // paragraph. Each new chunk line becomes its own paragraph by
  // including a trailing `\n` in the inserted text.
  if (hunk.oldLength === 0 && prefixStripped.length > 0) {
    const anchorMdLine = hunk.oldOffset - 1;
    const anchorIdx = anchorMdLine - region.startLine;
    const anchor = anchorIdx >= 0 ? cellParagraphs[anchorIdx] : null;
    // Strip bullet marker if the neighbouring paragraph is bulleted —
    // new paragraphs created from the split inherit its list formatting.
    const adjacentBullet =
      (anchor?.bullet ?? false) ||
      (anchorIdx < 0 && (cellParagraphs[0]?.bullet ?? false));
    const lines = prefixStripped.map((t) =>
      adjacentBullet ? stripBulletMarker(t) : t,
    );
    const payload = lines.join('\n') + '\n';
    // Choose an insertion index that lands INSIDE an existing cell
    // paragraph (Docs rejects inserts at a structural boundary):
    //   - Mid-cell (anchor not last): anchor.endIndex sits at the start
    //     of the next paragraph; insert there.
    //   - End-of-cell (anchor is last) or no anchor: insert at
    //     anchor.endIndex - 1 (the last paragraph's trailing \n),
    //     placing the new lines before it — the existing \n then
    //     terminates the last newly-inserted paragraph.
    let insertAt: number;
    if (anchor) {
      const isLast = anchorIdx === cellParagraphs.length - 1;
      insertAt = isLast ? anchor.endIndex - 1 : anchor.endIndex;
    } else if (cellParagraphs.length > 0) {
      insertAt = cellParagraphs[0].startIndex;
    } else {
      return; // empty cell — nothing to insert into
    }
    requests.push({
      insertText: {
        location: { index: insertAt },
        text: payload,
      },
    });
  }

  // Pure-delete: remove whole cell paragraphs. Each old line maps to
  // one cell paragraph; deleting [para.startIndex, para.endIndex) drops
  // its text plus trailing \n so the next paragraph shifts up.
  // Special-case the cell's LAST paragraph: Docs requires a cell to
  // retain at least one paragraph, so we can't delete its terminating
  // \n — only the text content.
  if (hunk.newChunk.length === 0 && hunk.oldLength > 0) {
    for (let i = hunk.oldLength - 1; i >= 0; i--) {
      const paraIdx = hunk.oldOffset + i - region.startLine;
      const para = cellParagraphs[paraIdx];
      if (!para) continue;
      const isLastCellPara = paraIdx === cellParagraphs.length - 1;
      const endIdx = isLastCellPara ? para.endIndex - 1 : para.endIndex;
      if (endIdx > para.startIndex) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: para.startIndex, endIndex: endIdx },
          },
        });
      }
    }
  }
}
