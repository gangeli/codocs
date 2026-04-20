/**
 * Convert a markdown string into Google Docs batchUpdate requests.
 */

import type { docs_v1 } from 'googleapis';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { walkAst, type WalkSegment, type TextSegment, type TableSegment, type ImageSegment, type HeadingLinkRef, type HeadingInfo } from './ast-walker.js';
import { styleTable } from './table-style.js';
import { renderMermaidToPng } from './mermaid-renderer.js';
import { hashMermaidSource } from './mermaid-renderer.js';
import type { DriveApi } from '../client/drive-api.js';

/** A heading inserted at a known absolute doc index, for post-insert lookup. */
export interface AbsoluteHeadingInfo {
  startIndex: number;
  endIndex: number;
  slug: string;
  sectionNumber: string | null;
}

/** A heading-targeted link with absolute doc indices, awaiting headingId resolution. */
export interface AbsoluteHeadingLinkRef {
  startIndex: number;
  endIndex: number;
  target: HeadingLinkRef['target'];
}

export interface MdToDocsResult {
  /** The plain text that will be inserted (for text segments only). */
  text: string;
  /** All batchUpdate requests, in the order they should be sent. */
  requests: docs_v1.Schema$Request[];
  /** Headings inserted by this batch, at absolute doc indices. */
  headings: AbsoluteHeadingInfo[];
  /** Heading-target links that need a second-pass updateTextStyle with link.headingId. */
  headingLinks: AbsoluteHeadingLinkRef[];
}

export interface MdToDocsAsyncResult extends MdToDocsResult {
  /** Drive file IDs of temp images that must be deleted after batchUpdate. */
  tempDriveFileIds: string[];
  /** Mermaid source hashes for each image inserted, in insertion order. */
  mermaidHashes: Array<{ hash: string; source: string }>;
  /** Number of insertInlineImage requests in this batch (for extracting objectIds from response). */
  imageCount: number;
}

export interface ImageInsertionContext {
  driveApi: DriveApi;
  documentId: string;
}

/**
 * Convert markdown to a set of Google Docs batchUpdate requests.
 *
 * @param markdown - The markdown source string.
 * @param insertionIndex - The document index where text should be inserted (default: 1, start of body).
 * @param clearFirst - If true, prepend a DeleteContentRange request to clear the body.
 * @param endIndex - Required if clearFirst is true: the current end index of the document body.
 */
export function markdownToDocsRequests(
  markdown: string,
  insertionIndex = 1,
  clearFirst = false,
  endIndex?: number,
): MdToDocsResult {
  // Parse markdown to mdast AST (with GFM for table support)
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;

  // Walk the AST to get segments
  const { segments } = walkAst(tree);

  const requests: docs_v1.Schema$Request[] = [];
  let fullText = '';

  // 1. Optionally clear existing content
  if (clearFirst && endIndex && endIndex > 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 },
      },
    });
  }

  // 2. Process segments in order, building requests and tracking position
  let docIndex = insertionIndex;
  const allStyles: docs_v1.Schema$Request[] = [];
  const allBullets: docs_v1.Schema$Request[] = [];
  const headings: AbsoluteHeadingInfo[] = [];
  const headingLinks: AbsoluteHeadingLinkRef[] = [];

  for (const segment of segments) {
    if (segment.type === 'text') {
      docIndex = processTextSegment(segment, docIndex, requests, allStyles, allBullets, headings, headingLinks);
      fullText += segment.text;
    } else if (segment.type === 'table') {
      docIndex = processTableSegment(segment, docIndex, requests, allStyles);
    }
    // ImageSegments are silently skipped in the sync path
    // (they require async rendering + Drive upload)
  }

  // 3. Apply styles in correct order:
  //    a) Paragraph styles first (set namedStyleType base — this resets text formatting)
  //    b) Text styles second (override the base with bold, italic, etc.)
  //    c) Table styles (cell background, column widths, etc.)
  //    Within each group, apply in reverse index order to preserve positions.
  const paraStyles = allStyles.filter((r) => r.updateParagraphStyle);
  const textStyles = allStyles.filter((r) => r.updateTextStyle);
  const otherStyles = allStyles.filter((r) => !r.updateParagraphStyle && !r.updateTextStyle);

  const byStartDesc = (a: typeof allStyles[0], b: typeof allStyles[0]) =>
    getStartIndex(b) - getStartIndex(a);

  requests.push(...paraStyles.sort(byStartDesc));
  requests.push(...otherStyles.sort(byStartDesc));
  requests.push(...textStyles.sort(byStartDesc));

  // 4. Apply bullet formatting
  requests.push(...allBullets);

  return { text: fullText, requests, headings, headingLinks };
}

// ── Async variant (with image support) ────────────────────────

/**
 * Async variant of markdownToDocsRequests that handles mermaid diagrams.
 *
 * Mermaid code blocks are rendered to PNG, uploaded to Drive as temporary
 * files, and inserted via insertInlineImage. The caller MUST delete the
 * temp files (returned in tempDriveFileIds) after batchUpdate completes.
 */
export async function markdownToDocsRequestsAsync(
  markdown: string,
  insertionIndex: number,
  clearFirst: boolean,
  endIndex: number | undefined,
  imageCtx: ImageInsertionContext,
): Promise<MdToDocsAsyncResult> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const { segments } = walkAst(tree);

  const requests: docs_v1.Schema$Request[] = [];
  let fullText = '';
  const tempDriveFileIds: string[] = [];
  const mermaidHashes: Array<{ hash: string; source: string }> = [];

  if (clearFirst && endIndex && endIndex > 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 },
      },
    });
  }

  let docIndex = insertionIndex;
  const allStyles: docs_v1.Schema$Request[] = [];
  const allBullets: docs_v1.Schema$Request[] = [];
  const headings: AbsoluteHeadingInfo[] = [];
  const headingLinks: AbsoluteHeadingLinkRef[] = [];

  // Collect image segments to render and upload in parallel
  const imageSegments: Array<{ segment: ImageSegment; order: number }> = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].type === 'image') {
      imageSegments.push({ segment: segments[i] as ImageSegment, order: i });
    }
  }

  // Render all mermaid diagrams and upload to Drive
  const imageResults = new Map<number, { downloadUrl: string; fileId: string; widthPt: number; heightPt: number; hash: string }>();

  for (const { segment, order } of imageSegments) {
    try {
      const { png, width, height } = await renderMermaidToPng(segment.mermaidSource);
      const hash = hashMermaidSource(segment.mermaidSource);

      const { fileId, downloadUrl } = await imageCtx.driveApi.uploadTempImage(
        png,
        `mermaid-${hash}.png`,
      );
      tempDriveFileIds.push(fileId);

      // Scale to fit page width (468pt = US Letter with 1" margins)
      const maxWidthPt = 468;
      const aspectRatio = height / width;
      const widthPt = maxWidthPt;
      const heightPt = maxWidthPt * aspectRatio;

      imageResults.set(order, { downloadUrl, fileId, widthPt, heightPt, hash });
      mermaidHashes.push({ hash, source: segment.mermaidSource });
    } catch {
      // Rendering failed — skip this image (it will be omitted from the doc)
    }
  }

  // Process all segments in order
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.type === 'text') {
      docIndex = processTextSegment(segment, docIndex, requests, allStyles, allBullets, headings, headingLinks);
      fullText += segment.text;
    } else if (segment.type === 'table') {
      docIndex = processTableSegment(segment, docIndex, requests, allStyles);
    } else if (segment.type === 'image') {
      const result = imageResults.get(i);
      if (result) {
        // insertInlineImage inserts an InlineObjectElement consuming 1 index
        requests.push({
          insertInlineImage: {
            uri: result.downloadUrl,
            location: { index: docIndex },
            objectSize: {
              width: { magnitude: result.widthPt, unit: 'PT' },
              height: { magnitude: result.heightPt, unit: 'PT' },
            },
          },
        });
        // InlineObjectElement + trailing newline
        docIndex += 1;

        // Insert a newline after the image to separate from following content
        requests.push({
          insertText: {
            location: { index: docIndex },
            text: '\n',
          },
        });
        docIndex += 1;
      }
    }
  }

  // Apply styles (same order as sync version)
  const paraStyles = allStyles.filter((r) => r.updateParagraphStyle);
  const textStyles = allStyles.filter((r) => r.updateTextStyle);
  const otherStyles = allStyles.filter((r) => !r.updateParagraphStyle && !r.updateTextStyle);

  const byStartDesc = (a: typeof allStyles[0], b: typeof allStyles[0]) =>
    getStartIndex(b) - getStartIndex(a);

  requests.push(...paraStyles.sort(byStartDesc));
  requests.push(...otherStyles.sort(byStartDesc));
  requests.push(...textStyles.sort(byStartDesc));
  requests.push(...allBullets);

  return {
    text: fullText,
    requests,
    headings,
    headingLinks,
    tempDriveFileIds,
    mermaidHashes,
    imageCount: imageResults.size,
  };
}

// ── Text segment processing ────────────────────────────────────

function processTextSegment(
  segment: TextSegment,
  docIndex: number,
  requests: docs_v1.Schema$Request[],
  allStyles: docs_v1.Schema$Request[],
  allBullets: docs_v1.Schema$Request[],
  headings: AbsoluteHeadingInfo[],
  headingLinks: AbsoluteHeadingLinkRef[],
): number {
  if (segment.text.length === 0) return docIndex;

  requests.push({
    insertText: {
      location: { index: docIndex },
      text: segment.text,
    },
  });

  // Adjust style offsets from relative (0-based) to absolute document positions
  for (const style of segment.styles) {
    adjustRequestIndex(style, docIndex);
    allStyles.push(style);
  }

  for (const bullet of segment.bullets) {
    adjustRequestIndex(bullet, docIndex);
    allBullets.push(bullet);
  }

  for (const h of segment.headings) {
    headings.push({
      startIndex: h.startIndex + docIndex,
      endIndex: h.endIndex + docIndex,
      slug: h.slug,
      sectionNumber: h.sectionNumber,
    });
  }

  for (const link of segment.headingLinks) {
    headingLinks.push({
      startIndex: link.startIndex + docIndex,
      endIndex: link.endIndex + docIndex,
      target: link.target,
    });
  }

  return docIndex + segment.text.length;
}

// ── Table segment processing ───────────────────────────────────

/**
 * Index layout of a newly inserted Google Docs table at position `s`
 * with R rows and C columns:
 *
 *   s+0:  TABLE (structural)
 *   s+1:  TABLE_ROW (row 0)
 *   s+2:  TABLE_CELL (row 0, col 0)
 *   s+3:  \n (empty paragraph in cell)
 *   s+4:  TABLE_CELL (row 0, col 1)
 *   s+5:  \n
 *   ...
 *   After last cell of last row:
 *   s+N:  \n (trailing paragraph added by Docs)
 *
 * Cell(r, c) content \n is at:
 *   s + 3 + r * (2*C + 1) + 2*c
 *
 * Total table size (indices consumed):
 *   2 + R + 2*R*C
 *   (plus 1 for the trailing paragraph \n)
 */

function processTableSegment(
  segment: TableSegment,
  docIndex: number,
  requests: docs_v1.Schema$Request[],
  allStyles: docs_v1.Schema$Request[],
): number {
  const R = segment.rows.length;
  const C = segment.numColumns;
  if (R === 0 || C === 0) return docIndex;

  // Insert the empty table structure
  requests.push({
    insertTable: {
      rows: R,
      columns: C,
      location: { index: docIndex },
    },
  });

  // insertTable at docIndex inserts the table structure starting at
  // docIndex + 1 (the existing content at docIndex is pushed right).
  const tableStart = docIndex + 1;

  // Fill cells with content, working BACKWARDS to avoid index shifting.
  // Each cell's \n is at: tableStart + 3 + r*(2C+1) + 2c
  // We insert text BEFORE the \n (at the same index, pushing \n right).
  for (let r = R - 1; r >= 0; r--) {
    for (let c = C - 1; c >= 0; c--) {
      const cellText = segment.rows[r][c];
      if (!cellText) continue;

      const cellContentIndex = tableStart + 3 + r * (2 * C + 1) + 2 * c;
      requests.push({
        insertText: {
          location: { index: cellContentIndex },
          text: cellText,
        },
      });
    }
  }

  // Calculate final table size (after all cell text is inserted)
  // Base table structure: 2 + R + 2*R*C indices (including trailing \n)
  // Plus all inserted cell text
  const totalCellTextLength = segment.rows.reduce(
    (sum, row) => sum + row.reduce((s, cell) => s + cell.length, 0),
    0,
  );
  const tableStructureSize = 2 + R + 2 * R * C;
  const tableSize = tableStructureSize + totalCellTextLength;

  // Apply table styling (header, padding, column widths, alignment)
  allStyles.push(...styleTable(tableStart, segment.rows, C));

  // +1 because insertTable pushes existing content right by 1
  // (the table starts at docIndex+1, not docIndex)
  return docIndex + tableSize + 1;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Shift all range indices in a request by `delta`.
 * Used to convert relative (0-based) offsets to absolute document positions.
 */
function adjustRequestIndex(req: docs_v1.Schema$Request, delta: number) {
  if (req.updateTextStyle?.range) {
    const r = req.updateTextStyle.range;
    r.startIndex = (r.startIndex ?? 0) + delta;
    r.endIndex = (r.endIndex ?? 0) + delta;
  }
  if (req.updateParagraphStyle?.range) {
    const r = req.updateParagraphStyle.range;
    r.startIndex = (r.startIndex ?? 0) + delta;
    r.endIndex = (r.endIndex ?? 0) + delta;
  }
  if (req.createParagraphBullets?.range) {
    const r = req.createParagraphBullets.range;
    r.startIndex = (r.startIndex ?? 0) + delta;
    r.endIndex = (r.endIndex ?? 0) + delta;
  }
}

function getStartIndex(req: docs_v1.Schema$Request): number {
  if (req.updateTextStyle) {
    return req.updateTextStyle.range?.startIndex ?? 0;
  }
  if (req.updateParagraphStyle) {
    return req.updateParagraphStyle.range?.startIndex ?? 0;
  }
  if (req.updateTableCellStyle) {
    return req.updateTableCellStyle.tableRange?.tableCellLocation?.tableStartLocation?.index ?? 0;
  }
  if (req.updateTableColumnProperties) {
    return req.updateTableColumnProperties.tableStartLocation?.index ?? 0;
  }
  return 0;
}
