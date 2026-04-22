/**
 * Table styling for Google Docs.
 *
 * Generates batchUpdate requests to style a table after it's been
 * created and filled with content. The default style is "booktabs":
 * three horizontal rules (thick top, thin under header, thick bottom)
 * with no vertical lines and no header fill. Header text is bold black.
 */

import type { docs_v1 } from 'googleapis';

// ── Design tokens ──────────────────────────────────────────────

/** Invisible border used to suppress unwanted cell edges. */
const INVISIBLE_BORDER: docs_v1.Schema$TableCellBorder = {
  color: { color: {} },
  width: { magnitude: 0, unit: 'PT' },
  dashStyle: 'SOLID',
};

/** Top and bottom rule — 2pt solid black. */
const THICK_RULE: docs_v1.Schema$TableCellBorder = {
  color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
  width: { magnitude: 2, unit: 'PT' },
  dashStyle: 'SOLID',
};

/** Rule under the header row — 1pt solid black. */
const THIN_RULE: docs_v1.Schema$TableCellBorder = {
  color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
  width: { magnitude: 1, unit: 'PT' },
  dashStyle: 'SOLID',
};

/** Cell padding in points. */
const CELL_PADDING_PT = 6;

/** Minimum column width in points. Prevents narrow columns from being crushed. */
const MIN_COL_WIDTH_PT = 60;

/** Page body width in points (US Letter, 1-inch margins). */
const PAGE_WIDTH_PT = 468;

/** Max characters before a column is considered "short" and gets centered. */
const SHORT_VALUE_THRESHOLD = 10;

// ── Public API ─────────────────────────────────────────────────

/**
 * Generate styling requests for a table.
 *
 * @param tableStart - The doc index where the table structure starts
 *                     (one past the insertTable location).
 * @param rows - The table data: rows[r][c] is the cell text.
 * @param numColumns - Number of columns.
 */
export function styleTable(
  tableStart: number,
  rows: string[][],
  numColumns: number,
): docs_v1.Schema$Request[] {
  const R = rows.length;
  const C = numColumns;
  if (R === 0 || C === 0) return [];

  const requests: docs_v1.Schema$Request[] = [];

  // ── Header row: bold text, no fill ─────────────────────────

  for (let c = 0; c < C; c++) {
    const headerText = rows[0][c];
    if (!headerText) continue;
    const idx = cellIndex(tableStart, 0, c, C, rows);
    requests.push({
      updateTextStyle: {
        range: {
          startIndex: idx,
          endIndex: idx + headerText.length,
        },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  }

  // ── Booktabs borders ───────────────────────────────────────
  // No vertical borders anywhere. No inner horizontal borders.
  // Thick rules at top and bottom of table; thin rule under header.

  // Suppress every vertical border.
  requests.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStart },
          rowIndex: 0,
          columnIndex: 0,
        },
        rowSpan: R,
        columnSpan: C,
      },
      tableCellStyle: {
        borderLeft: INVISIBLE_BORDER,
        borderRight: INVISIBLE_BORDER,
      },
      fields: 'borderLeft,borderRight',
    },
  });

  // Suppress inner horizontal borders (everything except the three rules
  // we set explicitly below).
  if (R > 1) {
    requests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: { index: tableStart },
            rowIndex: 1,
            columnIndex: 0,
          },
          rowSpan: R - 1,
          columnSpan: C,
        },
        tableCellStyle: { borderTop: INVISIBLE_BORDER },
        fields: 'borderTop',
      },
    });
    requests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: { index: tableStart },
            rowIndex: 0,
            columnIndex: 0,
          },
          rowSpan: R - 1,
          columnSpan: C,
        },
        tableCellStyle: { borderBottom: INVISIBLE_BORDER },
        fields: 'borderBottom',
      },
    });
  }

  // Top rule (thick, above header).
  requests.push({
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
      tableCellStyle: { borderTop: THICK_RULE },
      fields: 'borderTop',
    },
  });

  // Rule under the header (thin).
  requests.push({
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
      tableCellStyle: { borderBottom: THIN_RULE },
      fields: 'borderBottom',
    },
  });

  // Bottom rule (thick). For a 1-row table this intentionally overwrites the
  // thin header-rule with a thick one, giving a top+bottom rule pair.
  requests.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStart },
          rowIndex: R - 1,
          columnIndex: 0,
        },
        rowSpan: 1,
        columnSpan: C,
      },
      tableCellStyle: { borderBottom: THICK_RULE },
      fields: 'borderBottom',
    },
  });

  // ── Cell padding on ALL cells ──────────────────────────────

  requests.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStart },
          rowIndex: 0,
          columnIndex: 0,
        },
        rowSpan: R,
        columnSpan: C,
      },
      tableCellStyle: {
        paddingTop: { magnitude: CELL_PADDING_PT, unit: 'PT' },
        paddingBottom: { magnitude: CELL_PADDING_PT, unit: 'PT' },
        paddingLeft: { magnitude: CELL_PADDING_PT, unit: 'PT' },
        paddingRight: { magnitude: CELL_PADDING_PT, unit: 'PT' },
      },
      fields: 'paddingTop,paddingBottom,paddingLeft,paddingRight',
    },
  });

  // ── Column widths ──────────────────────────────────────────

  const colWidths = computeColumnWidths(rows, C);
  for (let c = 0; c < C; c++) {
    requests.push({
      updateTableColumnProperties: {
        tableStartLocation: { index: tableStart },
        columnIndices: [c],
        tableColumnProperties: {
          widthType: 'FIXED_WIDTH',
          width: { magnitude: colWidths[c], unit: 'PT' },
        },
        fields: 'widthType,width',
      },
    });
  }

  // Note: Google Docs API does not support table-level alignment
  // (no "center table" property). Narrow tables will be left-aligned
  // but sized to their content rather than stretching to full page width.

  // ── Center-align short-value columns ───────────────────────

  for (let c = 0; c < C; c++) {
    const isShort = rows.every(
      (row) => (row[c] ?? '').length <= SHORT_VALUE_THRESHOLD,
    );
    if (!isShort) continue;

    // Center all cells in this column (header + data)
    for (let r = 0; r < R; r++) {
      const cellContentIndex = cellIndex(tableStart, r, c, C, rows);
      const cellText = rows[r][c] ?? '';
      if (!cellText) continue;
      requests.push({
        updateParagraphStyle: {
          range: {
            startIndex: cellContentIndex,
            endIndex: cellContentIndex + cellText.length + 1, // +1 for \n
          },
          paragraphStyle: { alignment: 'CENTER' },
          fields: 'alignment',
        },
      });
    }
  }

  return requests;
}

// ── Blockquote styling ─────────────────────────────────────────

/** Thick gray left rule for blockquotes (matches markdown convention). */
const BLOCKQUOTE_RULE_COLOR: docs_v1.Schema$OptionalColor = {
  color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } },
};
const BLOCKQUOTE_RULE_WIDTH_PT = 3;

/**
 * Style a 1x1 blockquote table: hide the top/right/bottom borders, show a
 * thick gray bar on the left, and pad the cell.
 */
export function styleBlockquote(tableStart: number): docs_v1.Schema$Request[] {
  const leftBorder: docs_v1.Schema$TableCellBorder = {
    color: BLOCKQUOTE_RULE_COLOR,
    width: { magnitude: BLOCKQUOTE_RULE_WIDTH_PT, unit: 'PT' },
    dashStyle: 'SOLID',
  };

  return [
    {
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: { index: tableStart },
            rowIndex: 0,
            columnIndex: 0,
          },
          rowSpan: 1,
          columnSpan: 1,
        },
        tableCellStyle: {
          borderTop: INVISIBLE_BORDER,
          borderRight: INVISIBLE_BORDER,
          borderBottom: INVISIBLE_BORDER,
          borderLeft: leftBorder,
          paddingTop: { magnitude: CELL_PADDING_PT, unit: 'PT' },
          paddingBottom: { magnitude: CELL_PADDING_PT, unit: 'PT' },
          paddingLeft: { magnitude: CELL_PADDING_PT * 2, unit: 'PT' },
          paddingRight: { magnitude: CELL_PADDING_PT, unit: 'PT' },
        },
        fields:
          'borderTop,borderRight,borderBottom,borderLeft,paddingTop,paddingBottom,paddingLeft,paddingRight',
      },
    },
  ];
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Compute column widths in points, distributed proportionally based
 * on content length, with a minimum floor per column.
 *
 * Uses max(header length, average data cell length) for each column
 * to avoid over-weighting a single long value.
 */
/** Approximate points per character (for a typical proportional font). */
const PTS_PER_CHAR = 7;

function computeColumnWidths(rows: string[][], numColumns: number): number[] {
  const weights = new Array(numColumns).fill(0);

  for (let c = 0; c < numColumns; c++) {
    const headerLen = (rows[0]?.[c] ?? '').length;

    // Max length of data cells (rows 1+)
    let maxDataLen = 0;
    for (let r = 1; r < rows.length; r++) {
      maxDataLen = Math.max(maxDataLen, (rows[r][c] ?? '').length);
    }

    // Use the larger of header vs max data length, convert to points
    const charWidth = Math.max(headerLen, maxDataLen, 3);
    weights[c] = Math.max(MIN_COL_WIDTH_PT, charWidth * PTS_PER_CHAR + CELL_PADDING_PT * 2);
  }

  // Cap total width at page width
  const totalWidth = weights.reduce((a, b) => a + b, 0);
  if (totalWidth > PAGE_WIDTH_PT) {
    const scale = PAGE_WIDTH_PT / totalWidth;
    return weights.map((w) => Math.max(MIN_COL_WIDTH_PT, Math.round(w * scale)));
  }

  return weights;
}

/**
 * Calculate the doc index of a cell's content paragraph, accounting
 * for all prior cell text insertions (cells are filled in reverse order,
 * so earlier cells are at their base positions).
 */
function cellIndex(
  tableStart: number,
  row: number,
  col: number,
  numColumns: number,
  rows: string[][],
): number {
  // Base position (empty table): tableStart + 3 + r*(2C+1) + 2c
  let idx = tableStart + 3 + row * (2 * numColumns + 1) + 2 * col;

  // Add text length of all cells that were inserted before this one
  // (cells are filled in reverse order: last cell first)
  // For styling purposes, we need the position AFTER all cells are filled.
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < numColumns; c++) {
      if (r < row || (r === row && c < col)) {
        idx += (rows[r][c] ?? '').length;
      }
    }
  }

  return idx;
}
