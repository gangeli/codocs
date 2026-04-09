/**
 * Parse Google Docs StructuralElements into markdown string.
 *
 * Walks the document body and converts each element into its
 * markdown representation.
 */

import type { docs_v1 } from 'googleapis';
import { namedStyleToHeadingDepth, isMonospaceFont } from './style-map.js';

interface ParseContext {
  /** The full document (for resolving inline objects, lists, etc.) */
  document: docs_v1.Schema$Document;
  /** Named ranges in the document, for attribution. */
  namedRanges: Map<string, Array<{ startIndex: number; endIndex: number }>>;
  /** If set, only include content within these index ranges. */
  filterRanges: Array<{ startIndex: number; endIndex: number }> | null;
  /** Whether to emit attribution markers. */
  includeAttribution: boolean;
}

/** An entry mapping a markdown character offset to a Google Doc index. */
export interface IndexMapEntry {
  /** Character offset in the markdown output. */
  mdOffset: number;
  /** Corresponding Google Doc body index. */
  docIndex: number;
}

/** Result of parsing with index mapping. */
export interface MarkdownWithMapping {
  markdown: string;
  /** Sorted entries mapping markdown offsets to doc indices.
   *  One entry per structural element (paragraph, table, section break). */
  indexMap: IndexMapEntry[];
}

export function parseDocumentToMarkdown(
  document: docs_v1.Schema$Document,
  options: {
    agentFilter?: string;
    includeAttribution?: boolean;
  } = {},
): string {
  return parseDocumentToMarkdownImpl(document, options).markdown;
}

export function parseDocumentToMarkdownWithMapping(
  document: docs_v1.Schema$Document,
  options: {
    agentFilter?: string;
    includeAttribution?: boolean;
  } = {},
): MarkdownWithMapping {
  return parseDocumentToMarkdownImpl(document, options);
}

function parseDocumentToMarkdownImpl(
  document: docs_v1.Schema$Document,
  options: {
    agentFilter?: string;
    includeAttribution?: boolean;
  } = {},
): MarkdownWithMapping {
  const namedRanges = extractNamedRanges(document);

  let filterRanges: Array<{ startIndex: number; endIndex: number }> | null = null;
  if (options.agentFilter) {
    const key = `agent:${options.agentFilter}`;
    filterRanges = namedRanges.get(key) ?? [];
  }

  const ctx: ParseContext = {
    document,
    namedRanges,
    filterRanges,
    includeAttribution: options.includeAttribution ?? false,
  };

  const body = document.body;
  if (!body?.content) return { markdown: '', indexMap: [] };

  const parts: string[] = [];
  const indexMap: IndexMapEntry[] = [];
  let mdOffset = 0;

  for (const element of body.content) {
    const docStart = element.startIndex ?? 0;
    const docEnd = element.endIndex ?? 0;

    if (element.paragraph) {
      const md = parseParagraph(element.paragraph, element, ctx);
      if (md !== null) {
        if (parts.length > 0) mdOffset += 2; // for "\n\n" separator
        indexMap.push({ mdOffset, docIndex: docStart });
        parts.push(md);
        mdOffset += md.length;
      }
    } else if (element.table) {
      const md = parseTable(element.table, ctx);
      if (md !== null) {
        if (parts.length > 0) mdOffset += 2;
        indexMap.push({ mdOffset, docIndex: docStart });
        parts.push(md);
        mdOffset += md.length;
      }
    } else if (element.sectionBreak && !ctx.filterRanges) {
      if (parts.length > 0) mdOffset += 2;
      indexMap.push({ mdOffset, docIndex: docStart });
      parts.push('---');
      mdOffset += 3;
    }
  }

  let result = parts.join('\n\n');

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return { markdown: result + '\n', indexMap };
}

function parseParagraph(
  para: docs_v1.Schema$Paragraph,
  element: docs_v1.Schema$StructuralElement,
  ctx: ParseContext,
): string | null {
  const startIndex = element.startIndex ?? 0;
  const endIndex = element.endIndex ?? 0;

  // Check if this paragraph is within the filter range
  if (ctx.filterRanges && !isInRanges(startIndex, endIndex, ctx.filterRanges)) {
    return null;
  }

  const style = para.paragraphStyle?.namedStyleType;
  const headingDepth = namedStyleToHeadingDepth(style);
  const isBullet = !!para.bullet;

  // Build the text content of this paragraph
  let text = '';
  const elements = para.elements ?? [];

  for (const el of elements) {
    if (el.textRun) {
      text += formatTextRun(el.textRun);
    } else if (el.inlineObjectElement) {
      text += formatInlineObject(el.inlineObjectElement, ctx);
    }
  }

  // Remove trailing newline that Docs always adds to paragraphs
  text = text.replace(/\n$/, '');

  if (!text && !isBullet) return null;

  // Attribution markers
  let prefix = '';
  if (ctx.includeAttribution) {
    for (const [name, ranges] of ctx.namedRanges) {
      if (
        name.startsWith('agent:') &&
        isInRanges(startIndex, endIndex, ranges)
      ) {
        prefix = `<!-- ${name} -->\n`;
        break;
      }
    }
  }

  // Format based on type
  if (headingDepth > 0) {
    return prefix + '#'.repeat(headingDepth) + ' ' + text;
  }

  if (isBullet) {
    const bullet = para.bullet!;
    const nestingLevel = bullet.nestingLevel ?? 0;
    const indent = '  '.repeat(nestingLevel);

    // Determine if ordered or unordered from the list properties
    const listId = bullet.listId;
    const listProps = ctx.document.lists?.[listId!];
    const nestingProps =
      listProps?.listProperties?.nestingLevels?.[nestingLevel];
    const glyphType = nestingProps?.glyphType;

    // If glyph type is set (DECIMAL, ALPHA, etc.), it's ordered
    const isOrdered = glyphType && glyphType !== 'GLYPH_TYPE_UNSPECIFIED';
    const marker = isOrdered ? '1.' : '-';

    return prefix + indent + marker + ' ' + text;
  }

  return prefix + text;
}

function formatTextRun(textRun: docs_v1.Schema$TextRun): string {
  let text = textRun.content ?? '';
  const style = textRun.textStyle;

  if (!style || !text.trim()) return text;

  // Check for code (monospace font)
  if (isMonospaceFont(style.weightedFontFamily?.fontFamily)) {
    // If multi-line, treat as code block (handled at paragraph level)
    text = text.replace(/\n$/, '');
    return '`' + text + '`';
  }

  // Apply inline formatting — order matters: innermost first
  const trimmed = text.trim();
  const leadingSpace = text.slice(0, text.indexOf(trimmed));
  const trailingSpace = text.slice(text.indexOf(trimmed) + trimmed.length);

  let formatted = trimmed;

  if (style.strikethrough) {
    formatted = '~~' + formatted + '~~';
  }
  if (style.italic) {
    formatted = '*' + formatted + '*';
  }
  if (style.bold) {
    formatted = '**' + formatted + '**';
  }

  // Links
  if (style.link?.url) {
    formatted = '[' + formatted + '](' + style.link.url + ')';
  }

  return leadingSpace + formatted + trailingSpace;
}

function formatInlineObject(
  element: docs_v1.Schema$InlineObjectElement,
  ctx: ParseContext,
): string {
  const objectId = element.inlineObjectId;
  if (!objectId) return '';

  const inlineObject = ctx.document.inlineObjects?.[objectId];
  const embedded =
    inlineObject?.inlineObjectProperties?.embeddedObject;
  if (!embedded) return '';

  const url = embedded.imageProperties?.contentUri ?? '';
  const title = embedded.title ?? embedded.description ?? 'image';
  return `![${title}](${url})`;
}

function parseTable(
  table: docs_v1.Schema$Table,
  ctx: ParseContext,
): string | null {
  const rows = table.tableRows ?? [];
  if (rows.length === 0) return null;

  const mdRows: string[][] = [];

  for (const row of rows) {
    const cells = row.tableCells ?? [];
    const cellTexts: string[] = [];

    for (const cell of cells) {
      let cellText = '';
      for (const element of cell.content ?? []) {
        if (element.paragraph) {
          const elements = element.paragraph.elements ?? [];
          for (const el of elements) {
            if (el.textRun) {
              cellText += el.textRun.content ?? '';
            }
          }
        }
      }
      // Clean up cell text
      cellTexts.push(cellText.replace(/\n/g, ' ').trim());
    }
    mdRows.push(cellTexts);
  }

  if (mdRows.length === 0) return null;

  // Build markdown table
  const lines: string[] = [];
  // Header row
  lines.push('| ' + mdRows[0].join(' | ') + ' |');
  // Separator
  lines.push('| ' + mdRows[0].map(() => '---').join(' | ') + ' |');
  // Data rows
  for (let i = 1; i < mdRows.length; i++) {
    lines.push('| ' + mdRows[i].join(' | ') + ' |');
  }

  return lines.join('\n');
}

function extractNamedRanges(
  document: docs_v1.Schema$Document,
): Map<string, Array<{ startIndex: number; endIndex: number }>> {
  const result = new Map<
    string,
    Array<{ startIndex: number; endIndex: number }>
  >();

  const namedRanges = document.namedRanges;
  if (!namedRanges) return result;

  for (const [name, rangeData] of Object.entries(namedRanges)) {
    const ranges: Array<{ startIndex: number; endIndex: number }> = [];
    for (const namedRange of rangeData.namedRanges ?? []) {
      for (const range of namedRange.ranges ?? []) {
        ranges.push({
          startIndex: range.startIndex ?? 0,
          endIndex: range.endIndex ?? 0,
        });
      }
    }
    result.set(name, ranges);
  }

  return result;
}

function isInRanges(
  start: number,
  end: number,
  ranges: Array<{ startIndex: number; endIndex: number }>,
): boolean {
  return ranges.some(
    (r) => start < r.endIndex && end > r.startIndex,
  );
}
