/**
 * Convert a markdown string into Google Docs batchUpdate requests.
 */

import type { docs_v1 } from 'googleapis';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { walkAst, type WalkSegment, type TextSegment, type TableSegment } from './ast-walker.js';
import { TABLE_HEADER_BG } from './style-map.js';

export interface MdToDocsResult {
  /** The plain text that will be inserted (for text segments only). */
  text: string;
  /** All batchUpdate requests, in the order they should be sent. */
  requests: docs_v1.Schema$Request[];
}

/**
 * Google Docs page body width in points (US Letter, 1-inch margins).
 * Used to distribute table column widths proportionally.
 */
const PAGE_WIDTH_PT = 468;

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
    } else {
      docIndex = processTableSegment(segment, docIndex, requests, allStyles);
    }
  }

  // 3. Apply text styles (reverse order to preserve indexes)
  const sortedStyles = [...allStyles].sort((a, b) => {
    const aStart = getStartIndex(a);
    const bStart = getStartIndex(b);
    return bStart - aStart;
  });
  requests.push(...sortedStyles);

  // 4. Apply bullet formatting
  requests.push(...allBullets);

  return { text: fullText, requests };
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

  const tableStart = docIndex;

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

  // Bold the header row text
  // After cell text is inserted, cell(0, c) text starts at:
  //   tableStart + 3 + 2*c (the base position)
  // and occupies rows[0][c].length characters
  for (let c = 0; c < C; c++) {
    const headerText = segment.rows[0][c];
    if (!headerText) continue;
    const cellContentIndex = tableStart + 3 + 2 * c;
    allStyles.push({
      updateTextStyle: {
        range: {
          startIndex: cellContentIndex,
          endIndex: cellContentIndex + headerText.length,
        },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  }

  // Light blue background on header row cells
  allStyles.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStart },
          rowIndex: 0,
          columnIndex: 0,
        },
        rowSpan: 1,
        columnSpan: C,
      },
      tableCellStyle: {
        backgroundColor: TABLE_HEADER_BG,
      },
      fields: 'backgroundColor',
    },
  });

  // Set column widths proportional to max content length
  const colWidths = computeColumnWidths(segment.rows, C);
  for (let c = 0; c < C; c++) {
    allStyles.push({
      updateTableColumnProperties: {
        tableStartLocation: { index: tableStart },
        columnIndices: [c],
        tableColumnProperties: {
          widthType: 'FIXED_WIDTH',
          width: {
            magnitude: colWidths[c],
            unit: 'PT',
          },
        },
        fields: 'widthType,width',
      },
    });
  }

  return docIndex + tableSize;
}

/**
 * Compute column widths in points, distributed proportionally
 * based on the longest cell content in each column.
 */
function computeColumnWidths(rows: string[][], numColumns: number): number[] {
  const maxLengths = new Array(numColumns).fill(0);
  for (const row of rows) {
    for (let c = 0; c < numColumns; c++) {
      maxLengths[c] = Math.max(maxLengths[c], (row[c] ?? '').length);
    }
  }

  // Ensure a minimum width so narrow columns aren't crushed
  const MIN_COL_CHARS = 5;
  for (let c = 0; c < numColumns; c++) {
    maxLengths[c] = Math.max(maxLengths[c], MIN_COL_CHARS);
  }

  const totalChars = maxLengths.reduce((a, b) => a + b, 0);
  return maxLengths.map((len) => Math.round((len / totalChars) * PAGE_WIDTH_PT));
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
