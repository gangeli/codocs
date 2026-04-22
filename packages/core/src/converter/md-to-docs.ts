/**
 * Convert a markdown string into Google Docs batchUpdate requests.
 */

import type { docs_v1 } from 'googleapis';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { walkAst, type WalkSegment, type TextSegment, type TableSegment, type ImageSegment, type BlockquoteSegment } from './ast-walker.js';
import { styleTable, styleBlockquote } from './table-style.js';
import { renderMermaidToPng } from './mermaid-renderer.js';
import { hashMermaidSource } from './mermaid-renderer.js';
import { probeRemoteImage } from './image-fetch.js';
import type { DriveApi } from '../client/drive-api.js';

/** Max image width in PT — matches the US Letter text column (page minus 1" margins). */
const PAGE_WIDTH_PT = 468;

export interface MdToDocsResult {
  /** The plain text that will be inserted (for text segments only). */
  text: string;
  /** All batchUpdate requests, in the order they should be sent. */
  requests: docs_v1.Schema$Request[];
}

export interface MdToDocsAsyncResult extends MdToDocsResult {
  /** Drive file IDs of temp images that must be deleted after batchUpdate. */
  tempDriveFileIds: string[];
  /**
   * Mermaid-image bookkeeping for round-trip restoration. Each entry has the
   * Drive fileId used as the insertInlineImage uri — downstream code persists
   * {fileId -> source} so a readback can map an inline object (whose
   * sourceUri embeds the fileId) back to its mermaid source.
   */
  mermaidImages: Array<{ fileId: string; hash: string; source: string }>;
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

  for (const segment of segments) {
    if (segment.type === 'text') {
      docIndex = processTextSegment(segment, docIndex, requests, allStyles, allBullets);
      fullText += segment.text;
    } else if (segment.type === 'table') {
      docIndex = processTableSegment(segment, docIndex, requests, allStyles);
    } else if (segment.type === 'blockquote') {
      docIndex = processBlockquoteSegment(segment, docIndex, requests, allStyles);
      fullText += segment.text;
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

  // 4. Apply bullet formatting, highest index first. createParagraphBullets
  //    strips leading tabs from the paragraphs it styles, which shifts every
  //    index that follows — applying later-in-document requests first means
  //    earlier ranges are still at their original positions when processed.
  const bulletsReversed = [...allBullets].sort(
    (a, b) =>
      (b.createParagraphBullets?.range?.startIndex ?? 0) -
      (a.createParagraphBullets?.range?.startIndex ?? 0),
  );
  requests.push(...bulletsReversed);

  return { text: fullText, requests };
}

// ── Async variant (with image support) ────────────────────────

/**
 * Async variant of markdownToDocsRequests that handles mermaid diagrams
 * and remote markdown images.
 *
 * Mermaid code blocks are rendered to PNG, uploaded to Drive as temporary
 * files, and inserted via insertInlineImage. Remote images (`![alt](url)`)
 * are passed through directly — Google's backend fetches the URL at insert
 * time. The caller MUST delete the temp Drive files (returned in
 * `tempDriveFileIds`) after batchUpdate completes.
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
  const mermaidImages: Array<{ fileId: string; hash: string; source: string }> = [];

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

  // When changing the image/mermaid insertion path (rendering, upload, or
  // insertInlineImage shape), update the Mermaid/image fixtures in
  // scripts/e2e-visual-test.ts — this code runs against live Drive + Docs APIs.
  interface PreparedImage {
    uri: string;
    widthPt?: number;
    heightPt?: number;
  }
  const imageResults = new Map<number, PreparedImage>();

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.type !== 'image') continue;

    if (segment.kind === 'mermaid') {
      try {
        const { png, width, height } = await renderMermaidToPng(segment.mermaidSource);
        const hash = hashMermaidSource(segment.mermaidSource);
        const { fileId, downloadUrl } = await imageCtx.driveApi.uploadTempImage(
          png,
          `mermaid-${hash}.png`,
        );
        tempDriveFileIds.push(fileId);
        imageResults.set(i, {
          uri: downloadUrl,
          widthPt: PAGE_WIDTH_PT,
          heightPt: PAGE_WIDTH_PT * (height / width),
        });
        mermaidImages.push({ fileId, hash, source: segment.mermaidSource });
      } catch {
        // Rendering or upload failed — skip this image.
      }
    } else {
      // Remote image: pass URL through; measure it so we can cap at page
      // width, and also so we can drop unsupported formats before they
      // reach the Docs API (which would otherwise reject the whole batch).
      const info = await probeRemoteImage(segment.url);
      if (info && !info.supported) {
        // ICO/SVG/WebP/BMP/… — Docs API only accepts PNG/JPEG/GIF. Skip the
        // insert entirely; the surrounding content still goes through.
        continue;
      }
      const prepared: PreparedImage = { uri: segment.url };
      if (info) {
        const pxToPt = 0.75; // CSS standard: 96px = 72pt
        const naturalWidthPt = info.width * pxToPt;
        if (naturalWidthPt > PAGE_WIDTH_PT) {
          prepared.widthPt = PAGE_WIDTH_PT;
          prepared.heightPt = PAGE_WIDTH_PT * (info.height / info.width);
        } else {
          prepared.widthPt = naturalWidthPt;
          prepared.heightPt = info.height * pxToPt;
        }
      }
      // If probing failed (unreachable from here), we still attempt the
      // insert — Google's fetcher may have paths we don't, e.g. IP
      // allow-lists. If Google also can't fetch, batchUpdate will error
      // and the caller will see the failure.
      imageResults.set(i, prepared);
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.type === 'text') {
      docIndex = processTextSegment(segment, docIndex, requests, allStyles, allBullets);
      fullText += segment.text;
    } else if (segment.type === 'table') {
      docIndex = processTableSegment(segment, docIndex, requests, allStyles);
    } else if (segment.type === 'blockquote') {
      docIndex = processBlockquoteSegment(segment, docIndex, requests, allStyles);
      fullText += segment.text;
    } else if (segment.type === 'image') {
      const result = imageResults.get(i);
      if (!result) continue;

      const insertImg: docs_v1.Schema$InsertInlineImageRequest = {
        uri: result.uri,
        location: { index: docIndex },
      };
      if (result.widthPt && result.heightPt) {
        insertImg.objectSize = {
          width: { magnitude: result.widthPt, unit: 'PT' },
          height: { magnitude: result.heightPt, unit: 'PT' },
        };
      }
      requests.push({ insertInlineImage: insertImg });
      docIndex += 1;

      // Force a paragraph break after the image so following content starts
      // on its own line (insertInlineImage itself doesn't add one).
      requests.push({
        insertText: { location: { index: docIndex }, text: '\n' },
      });
      docIndex += 1;
    }
  }

  const paraStyles = allStyles.filter((r) => r.updateParagraphStyle);
  const textStyles = allStyles.filter((r) => r.updateTextStyle);
  const otherStyles = allStyles.filter((r) => !r.updateParagraphStyle && !r.updateTextStyle);

  const byStartDesc = (a: typeof allStyles[0], b: typeof allStyles[0]) =>
    getStartIndex(b) - getStartIndex(a);

  requests.push(...paraStyles.sort(byStartDesc));
  requests.push(...otherStyles.sort(byStartDesc));
  requests.push(...textStyles.sort(byStartDesc));

  // Bullets highest-index first — see sync path for the rationale
  // (createParagraphBullets strips leading tabs, which shifts later indices).
  const bulletsReversed = [...allBullets].sort(
    (a, b) =>
      (b.createParagraphBullets?.range?.startIndex ?? 0) -
      (a.createParagraphBullets?.range?.startIndex ?? 0),
  );
  requests.push(...bulletsReversed);

  return {
    text: fullText,
    requests,
    tempDriveFileIds,
    mermaidImages,
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

      // Apply inline styles (bold/italic/strikethrough/link) captured
      // inside this cell. Offsets are 0-based relative to cellText; shift
      // them to the cell's absolute doc index.
      const styles = segment.cellStyles[r]?.[c];
      if (styles) {
        for (const style of styles) {
          adjustRequestIndex(style, cellContentIndex);
          allStyles.push(style);
        }
      }
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

// ── Blockquote segment processing ──────────────────────────────

/**
 * Render a blockquote as a 1x1 table with all borders hidden except a
 * thick left bar (simulating a markdown-style blockquote rule).
 *
 * Table index layout for R=1, C=1 (see processTableSegment for derivation):
 *   tableStart+0: TABLE
 *   tableStart+1: TABLE_ROW
 *   tableStart+2: TABLE_CELL
 *   tableStart+3: \n (cell content paragraph)
 *   tableStart+4: \n (trailing)
 * Cell text inserts at tableStart+3.
 */
function processBlockquoteSegment(
  segment: BlockquoteSegment,
  docIndex: number,
  requests: docs_v1.Schema$Request[],
  allStyles: docs_v1.Schema$Request[],
): number {
  requests.push({
    insertTable: {
      rows: 1,
      columns: 1,
      location: { index: docIndex },
    },
  });

  const tableStart = docIndex + 1;
  const cellContentIndex = tableStart + 3;

  if (segment.text.length > 0) {
    requests.push({
      insertText: {
        location: { index: cellContentIndex },
        text: segment.text,
      },
    });

    for (const style of segment.styles) {
      adjustRequestIndex(style, cellContentIndex);
      allStyles.push(style);
    }
    // Bullet requests collected during the blockquote walk were kept
    // separate from styles so blockquote rendering stays opt-in. Emit
    // them now so lists inside the quote (e.g. `> - item`) round-trip
    // with their bullet formatting intact.
    for (const bullet of segment.bullets) {
      adjustRequestIndex(bullet, cellContentIndex);
      allStyles.push(bullet);
    }
  }

  allStyles.push(...styleBlockquote(tableStart));

  const tableStructureSize = 2 + 1 + 2 * 1 * 1; // = 5
  return docIndex + tableStructureSize + segment.text.length + 1;
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
  if (req.createNamedRange?.range) {
    const r = req.createNamedRange.range;
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
