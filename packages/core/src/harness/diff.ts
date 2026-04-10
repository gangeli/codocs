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

/**
 * Parse a markdown string into sections split by headings.
 */
export function parseSections(markdown: string): MdSection[] {
  const lines = markdown.split('\n');
  const sections: MdSection[] = [];
  let currentHeading: string | null = null;
  let currentStartLine = 0;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADING_RE);

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
 * Match sections across three versions by heading text.
 * Returns aligned triples: [baseSection, oursSection, theirsSection].
 * Any may be null if the section doesn't exist in that version.
 */
function alignSections(
  baseSections: MdSection[],
  oursSections: MdSection[],
  theirsSections: MdSection[],
): Array<[MdSection | null, MdSection | null, MdSection | null]> {
  // Collect all unique headings in order of first appearance
  const seen = new Set<string | null>();
  const orderedHeadings: (string | null)[] = [];

  for (const sections of [baseSections, oursSections, theirsSections]) {
    for (const s of sections) {
      const key = s.heading;
      if (!seen.has(key)) {
        seen.add(key);
        orderedHeadings.push(key);
      }
    }
  }

  const findSection = (sections: MdSection[], heading: string | null) =>
    sections.find((s) => s.heading === heading) ?? null;

  return orderedHeadings.map((h) => [
    findSection(baseSections, h),
    findSection(oursSections, h),
    findSection(theirsSections, h),
  ]);
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

  // If nothing changed, return early
  if (mergeResult.mergedMarkdown.trim() === theirs.trim()) {
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

  for (const mergedS of mergedSections) {
    const theirsS = theirsSections.find((s) => s.heading === mergedS.heading);
    if (!theirsS || theirsS.content !== mergedS.content) {
      // This section changed — find its doc indices
      const docRange = findSectionDocRange(
        theirsS ?? null,
        theirsSections,
        indexMap,
        bodyEndIndex,
      );
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
      // New section — just insert at end
      if (change.mergedSection) {
        const insertAt = bodyEndIndex - 1;
        const { text, requests: insertRequests } = markdownToDocsRequests(
          change.mergedSection.content,
          insertAt,
          false,
          bodyEndIndex,
        );
        requests.push(...insertRequests);
        if (text.length > 0) {
          requests.push(...createAttributionRequests(agentName, insertAt, insertAt + text.length));
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

    // Build a line-to-doc-index map for the old section.
    // Each line in the section maps to a doc index via the indexMap.
    const sectionMdStart = computeMdOffset(change.theirsSection, theirsSections);
    const lineDocIndices = buildLineDocIndices(
      oldLines,
      sectionMdStart,
      indexMap,
      change.docEndIndex,
    );

    // Process hunks in reverse order to preserve indices
    for (let h = hunks.length - 1; h >= 0; h--) {
      const hunk = hunks[h];
      const oldOffset = hunk.buffer1.offset;
      const oldLength = hunk.buffer1.length;
      const newContent = hunk.buffer2.chunk.join('\n');

      // Find the doc index range for the lines being replaced.
      // If the offset is past the end of the old content (pure append),
      // use the section end index so the insert goes after existing content.
      const deleteStartIdx = oldOffset < lineDocIndices.length
        ? lineDocIndices[oldOffset]
        : change.docEndIndex;
      const deleteEndLine = oldOffset + oldLength;
      const deleteEndIdx = deleteEndLine < lineDocIndices.length
        ? lineDocIndices[deleteEndLine]
        : change.docEndIndex;

      // Clamp to body end
      const clampedEnd = deleteEndIdx >= bodyEndIndex ? bodyEndIndex - 1 : deleteEndIdx;

      // Delete the old lines
      if (oldLength > 0 && clampedEnd > deleteStartIdx) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: deleteStartIdx, endIndex: clampedEnd },
          },
        });
      }

      // Insert the new lines
      if (newContent.length > 0) {
        // Clamp insert position to before the body's trailing newline
        const insertAt = Math.min(deleteStartIdx, bodyEndIndex - 1);

        // When inserting without deleting (pure append), we need a \n
        // before the new content to start a new paragraph. Without it,
        // the text merges into the previous paragraph (e.g., heading).
        // Insert the \n as a raw request since the markdown parser strips
        // leading whitespace.
        if (oldLength === 0 && insertAt > 1) {
          requests.push({
            insertText: {
              location: { index: insertAt },
              text: '\n',
            },
          });
        }

        const { text, requests: insertRequests } = markdownToDocsRequests(
          newContent,
          oldLength === 0 && insertAt > 1 ? insertAt + 1 : insertAt,
          false,
          bodyEndIndex,
        );
        requests.push(...insertRequests);
        if (text.length > 0) {
          requests.push(...createAttributionRequests(agentName, insertAt, insertAt + text.length));
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
 * Compute the approximate markdown character offset of a section,
 * based on joining all prior sections with separators.
 */
function computeMdOffset(section: MdSection, allSections: MdSection[]): number {
  let offset = 0;
  for (const s of allSections) {
    if (s === section) return offset;
    offset += s.content.length + 2; // +2 for "\n\n" separator
  }
  return offset;
}

/**
 * Build an array mapping each line index in a section to its approximate
 * Google Doc index, using the indexMap entries.
 *
 * Each entry lineDocIndices[i] is the doc index where line i starts.
 * We interpolate between known indexMap entries based on character offsets.
 */
function buildLineDocIndices(
  lines: string[],
  sectionMdStart: number,
  indexMap: IndexMapEntry[],
  sectionDocEnd: number,
): number[] {
  const result: number[] = [];
  let mdOffset = sectionMdStart;

  for (let i = 0; i < lines.length; i++) {
    // Find the best matching indexMap entry for this md offset
    let docIndex = sectionDocEnd; // fallback
    let bestEntry: IndexMapEntry | null = null;

    for (const entry of indexMap) {
      if (entry.mdOffset <= mdOffset) {
        bestEntry = entry;
      } else {
        break;
      }
    }

    if (bestEntry) {
      // Interpolate: doc index = entry's doc index + (md offset - entry's md offset)
      docIndex = bestEntry.docIndex + (mdOffset - bestEntry.mdOffset);
    }

    result.push(docIndex);
    mdOffset += lines[i].length + 1; // +1 for '\n'
  }

  return result;
}

function getBodyEndIndex(document: docs_v1.Schema$Document): number {
  const body = document.body;
  if (!body?.content?.length) return 1;
  const last = body.content[body.content.length - 1];
  return last.endIndex ?? 1;
}
