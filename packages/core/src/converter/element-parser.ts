/**
 * Parse Google Docs StructuralElements into markdown string.
 *
 * Walks the document body and converts each element into its
 * markdown representation.
 */

import type { docs_v1 } from 'googleapis';
import { namedStyleToHeadingDepth, isMonospaceFont } from './style-map.js';
import { CODELANG_RANGE_PREFIX } from '../types.js';

interface ParseContext {
  /** The full document (for resolving inline objects, lists, etc.) */
  document: docs_v1.Schema$Document;
  /** Named ranges in the document, for attribution. */
  namedRanges: Map<string, Array<{ startIndex: number; endIndex: number }>>;
  /** If set, only include content within these index ranges. */
  filterRanges: Array<{ startIndex: number; endIndex: number }> | null;
  /** Whether to emit attribution markers. */
  includeAttribution: boolean;
  /**
   * Map from Drive file ID → original mermaid source, used to restore
   * mermaid diagrams from the images that replaced them on write. Lookup
   * keys are fileIds extracted from each inline object's sourceUri.
   */
  mermaidByFileId: Map<string, string>;
  /**
   * Per-list-level running counter for ordered-list numbering. Key is
   * `${listId}|${nestingLevel}`; value is the next number to emit.
   * Seeded lazily from each list's `startNumber` property.
   */
  orderedCounters: Map<string, number>;
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

export interface ParseOptions {
  agentFilter?: string;
  includeAttribution?: boolean;
  /**
   * Map from Drive file ID → original mermaid source. On readback an inline
   * object whose sourceUri points at a known fileId is restored as a mermaid
   * code block instead of `![title](url)`.
   */
  mermaidByFileId?: Map<string, string>;
  /** When set, read from a specific tab (document must be fetched with includeTabsContent). */
  tabId?: string;
}

export function parseDocumentToMarkdown(
  document: docs_v1.Schema$Document,
  options: ParseOptions = {},
): string {
  return parseDocumentToMarkdownImpl(document, options).markdown;
}

export function parseDocumentToMarkdownWithMapping(
  document: docs_v1.Schema$Document,
  options: ParseOptions = {},
): MarkdownWithMapping {
  return parseDocumentToMarkdownImpl(document, options);
}

function parseDocumentToMarkdownImpl(
  document: docs_v1.Schema$Document,
  options: ParseOptions = {},
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
    mermaidByFileId: options.mermaidByFileId ?? new Map(),
    orderedCounters: new Map(),
  };

  const body = document.body;
  if (!body?.content) return { markdown: '', indexMap: [] };

  // Use a variable separator between paragraphs: single '\n' when two
  // consecutive paragraphs belong to the SAME list (so list items stay
  // adjacent), '\n\n' otherwise.
  let output = '';
  const indexMap: IndexMapEntry[] = [];
  let prevListId: string | null = null;

  for (let i = 0; i < body.content.length; i++) {
    const element = body.content[i];
    const docStart = element.startIndex ?? 0;

    let md: string | null = null;
    let curListId: string | null = null;

    // Consecutive monospace paragraphs form a fenced code block.
    if (isCodeBlockLine(element)) {
      const blockStart = element.startIndex ?? 0;
      const lines: string[] = [];
      let blockEnd = element.endIndex ?? blockStart;
      while (i < body.content.length && isCodeBlockLine(body.content[i])) {
        lines.push(extractRawText(body.content[i].paragraph!));
        blockEnd = body.content[i].endIndex ?? blockEnd;
        i++;
      }
      i--; // outer loop's i++ will re-advance past the last code line
      const lang = findCodeLang(ctx.namedRanges, blockStart, blockEnd);
      md = '```' + (lang ?? '') + '\n' + lines.join('\n') + '\n```';
    } else if (element.paragraph) {
      md = parseParagraph(element.paragraph, element, ctx);
      curListId = element.paragraph.bullet?.listId ?? null;
    } else if (element.table) {
      md = parseTable(element.table, ctx);
    } else if (element.sectionBreak && !ctx.filterRanges) {
      // Every new Google Doc body starts with a sectionBreak the API
      // won't let us delete. Drop the leading one so canonical inputs
      // round-trip losslessly. Later sectionBreaks (rare — the write
      // path never emits them) still render as `---`.
      if (i === 0) continue;
      md = '---';
    }

    if (md === null) continue;

    const sep =
      output === ''
        ? ''
        : prevListId !== null && prevListId === curListId
        ? '\n'
        : '\n\n';
    output += sep;
    indexMap.push({ mdOffset: output.length, docIndex: docStart });
    output += md;
    prevListId = curListId;
  }

  // Collapse any accidental runs of 3+ newlines, then normalise trailing/leading.
  let result = output.replace(/\n{3,}/g, '\n\n').trim();

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

  // Build the text content of this paragraph. Text runs are collected as
  // styled segments and emitted together so shared-style boundaries merge
  // (e.g. `**bold and *italic* bold**` stays as one bold span instead of
  // fragmenting into `**bold and** ***italic*** **bold**`).
  const elements = para.elements ?? [];
  const pieces: string[] = [];
  let runBuf: StyledSegment[] = [];
  const flushRuns = () => {
    if (runBuf.length === 0) return;
    // Docs always appends "\n" to the last textRun of a paragraph.
    // Strip it so it doesn't land inside our style markers
    // (e.g. `***emphasis\n***`).
    const last = runBuf[runBuf.length - 1];
    if (last.text.endsWith('\n')) {
      runBuf[runBuf.length - 1] = { ...last, text: last.text.slice(0, -1) };
    }
    pieces.push(emitStyledSegments(runBuf));
    runBuf = [];
  };
  for (const el of elements) {
    if (el.textRun) {
      runBuf.push(toStyledSegment(el.textRun));
    } else if (el.inlineObjectElement) {
      flushRuns();
      pieces.push(formatInlineObject(el.inlineObjectElement, ctx));
    }
  }
  flushRuns();
  let text = pieces.join('');

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

    // Detect checkbox lists (undocumented checkboxLevel property, or
    // glyphSymbol containing a checkbox character like ☐/☑/✓/✔)
    const isCheckbox =
      (nestingProps as any)?.checkboxLevel === true ||
      /[\u2610\u2611\u2713\u2714]/.test(nestingProps?.glyphSymbol ?? '');

    if (isCheckbox) {
      // Determine checked state: Google Docs applies strikethrough to checked items
      const isChecked = elements.some(
        (el) => el.textRun?.textStyle?.strikethrough === true,
      );
      const checkbox = isChecked ? '- [x]' : '- [ ]';
      return prefix + indent + checkbox + ' ' + text;
    }

    // If glyph type is set (DECIMAL, ALPHA, etc.), it's ordered
    const isOrdered = glyphType && glyphType !== 'GLYPH_TYPE_UNSPECIFIED';
    let marker: string;
    if (isOrdered) {
      // Emit the actual running number for this (list, nesting-level).
      // Seeded from the list's startNumber (default 1) and incremented
      // per item encountered in document order.
      const counterKey = `${listId ?? ''}|${nestingLevel}`;
      const startNumber = nestingProps?.startNumber ?? 1;
      const next = ctx.orderedCounters.get(counterKey) ?? startNumber;
      ctx.orderedCounters.set(counterKey, next + 1);
      marker = `${next}.`;
    } else {
      marker = '-';
    }

    return prefix + indent + marker + ' ' + text;
  }

  // Horizontal rule: the write path emits `---` as three em-dashes as a
  // standalone paragraph (Docs has no native HR). Recognise that shape
  // on read so the round-trip preserves the original `---`.
  if (text === '———') {
    return prefix + '---';
  }

  return prefix + text;
}

interface StyledSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link?: string;
}

function toStyledSegment(textRun: docs_v1.Schema$TextRun): StyledSegment {
  const text = textRun.content ?? '';
  const style = textRun.textStyle ?? {};
  return {
    text,
    bold: !!style.bold,
    italic: !!style.italic,
    strikethrough: !!style.strikethrough,
    code: isMonospaceFont(style.weightedFontFamily?.fontFamily),
    link: style.link?.url ?? undefined,
  };
}

/**
 * Emit a paragraph's text runs as markdown, opening and closing inline
 * markers only when the corresponding style actually changes. Adjacent
 * runs that share bold/italic/etc. get a single wrapping pair, so e.g.
 *   run1("bold ", bold) + run2("italic", bold+italic) + run3(" bold", bold)
 * renders as `**bold *italic* bold**`, not `**bold** ***italic*** **bold**`.
 */
function emitStyledSegments(segments: StyledSegment[]): string {
  let output = '';
  let openBold = false;
  let openItalic = false;
  let openStrike = false;
  let openCode = false;
  let openLink: string | undefined;

  for (const seg of segments) {
    if (seg.text === '') continue;

    // Close styles that aren't active in this segment (reverse of open order
    // so nested markers are well-formed).
    if (openCode && !seg.code) {
      output += '`';
      openCode = false;
    }
    if (openItalic && !seg.italic) {
      output += '*';
      openItalic = false;
    }
    if (openBold && !seg.bold) {
      output += '**';
      openBold = false;
    }
    if (openStrike && !seg.strikethrough) {
      output += '~~';
      openStrike = false;
    }
    if (openLink !== undefined && seg.link !== openLink) {
      output += `](${openLink})`;
      openLink = undefined;
    }

    // Open styles that are new this segment.
    if (openLink === undefined && seg.link !== undefined) {
      output += '[';
      openLink = seg.link;
    }
    if (!openStrike && seg.strikethrough) {
      output += '~~';
      openStrike = true;
    }
    if (!openBold && seg.bold) {
      output += '**';
      openBold = true;
    }
    if (!openItalic && seg.italic) {
      output += '*';
      openItalic = true;
    }
    if (!openCode && seg.code) {
      output += '`';
      openCode = true;
    }

    output += seg.text;
  }

  // Close anything still open at the paragraph end.
  if (openCode) output += '`';
  if (openItalic) output += '*';
  if (openBold) output += '**';
  if (openStrike) output += '~~';
  if (openLink !== undefined) output += `](${openLink})`;

  return output;
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

  // sourceUri is the URI originally passed to insertInlineImage — stable and
  // safe to hand back to the user. contentUri is a 30-minute, account-tagged
  // CDN URL and must not be persisted.
  const sourceUri = embedded.imageProperties?.sourceUri ?? '';

  // If this inline object was the rendered form of a mermaid block, its
  // sourceUri embeds the Drive file ID we uploaded. Extract that ID and, if
  // it's a known mermaid mapping, reconstruct the original ``` block.
  const driveFileId = extractDriveFileId(sourceUri);
  if (driveFileId) {
    const source = ctx.mermaidByFileId.get(driveFileId);
    if (source !== undefined) {
      return '```mermaid\n' + source + '\n```';
    }
  }

  const title = embedded.title ?? embedded.description ?? 'image';
  return `![${title}](${sourceUri})`;
}

/**
 * Extract the Drive file ID from a URL of the shape we hand to
 * insertInlineImage for mermaid uploads (`https://drive.google.com/uc?id=FID`).
 * Returns null for any other URL shape.
 */
function extractDriveFileId(url: string): string | null {
  if (!url) return null;
  const match = url.match(/^https?:\/\/drive\.google\.com\/uc\?(?:[^&]*&)*id=([^&#]+)/);
  return match ? match[1] : null;
}

/**
 * A paragraph qualifies as a fenced-code-block line iff it has no heading
 * style, no bullet, and every textRun with content uses a monospace font.
 * Consecutive such paragraphs get joined into a single ``` ``` block.
 */
function isCodeBlockLine(element: docs_v1.Schema$StructuralElement): boolean {
  const para = element.paragraph;
  if (!para) return false;
  if (para.bullet) return false;
  if (namedStyleToHeadingDepth(para.paragraphStyle?.namedStyleType) > 0) return false;
  const runs = para.elements ?? [];
  let hasAnyText = false;
  for (const el of runs) {
    if (el.textRun?.content) {
      hasAnyText = true;
      const font = el.textRun.textStyle?.weightedFontFamily?.fontFamily;
      if (!isMonospaceFont(font)) return false;
    }
  }
  return hasAnyText;
}

/**
 * Find the `codelang:<lang>` named range covering the given structural-element
 * range (a detected code block) and return `<lang>`, or null if no such range
 * exists. The write path stores the fence language this way because Docs has
 * no native code-block concept to carry it.
 */
function findCodeLang(
  namedRanges: Map<string, Array<{ startIndex: number; endIndex: number }>>,
  blockStart: number,
  blockEnd: number,
): string | null {
  for (const [name, ranges] of namedRanges) {
    if (!name.startsWith(CODELANG_RANGE_PREFIX)) continue;
    for (const r of ranges) {
      if (r.startIndex >= blockStart && r.endIndex <= blockEnd) {
        return name.slice(CODELANG_RANGE_PREFIX.length);
      }
    }
  }
  return null;
}

/** Concatenate the raw text of a paragraph's text runs, stripping the
 *  trailing paragraph newline Docs always appends. */
function extractRawText(para: docs_v1.Schema$Paragraph): string {
  let t = '';
  for (const el of para.elements ?? []) {
    if (el.textRun?.content) t += el.textRun.content;
  }
  return t.replace(/\n$/, '');
}

/**
 * The write path renders a blockquote as a 1×1 table with all borders
 * hidden except a thick gray left bar. Detect that exact shape here so
 * the round-trip preserves the `>` prefix.
 */
function isBlockquoteTable(table: docs_v1.Schema$Table): boolean {
  const rows = table.tableRows ?? [];
  if (rows.length !== 1) return false;
  const cells = rows[0].tableCells ?? [];
  if (cells.length !== 1) return false;
  const s = cells[0].tableCellStyle;
  if (!s) return false;
  const w = (b: docs_v1.Schema$TableCellBorder | undefined) =>
    b?.width?.magnitude ?? 0;
  // Matches the writer: BLOCKQUOTE_RULE_WIDTH_PT = 3, other borders = 0.
  return w(s.borderLeft) === 3 && w(s.borderTop) === 0 && w(s.borderRight) === 0 && w(s.borderBottom) === 0;
}

function parseBlockquoteTable(
  table: docs_v1.Schema$Table,
  ctx: ParseContext,
): string {
  const cell = table.tableRows![0].tableCells![0];
  const lines: string[] = [];
  for (const el of cell.content ?? []) {
    if (!el.paragraph) continue;
    const md = parseParagraph(el.paragraph, el, ctx);
    if (md === null) {
      lines.push('>');
      continue;
    }
    for (const line of md.split('\n')) {
      lines.push(line === '' ? '>' : `> ${line}`);
    }
  }
  return lines.join('\n');
}

function parseTable(
  table: docs_v1.Schema$Table,
  ctx: ParseContext,
): string | null {
  if (isBlockquoteTable(table)) {
    return parseBlockquoteTable(table, ctx);
  }
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

  // Build markdown table. Empty cells render as "| |" (single space between
  // pipes), not "|  |" — otherwise the round-trip adds a space per empty cell.
  const formatCell = (c: string) => (c === '' ? ' ' : ` ${c} `);
  const formatRow = (cells: string[]) => '|' + cells.map(formatCell).join('|') + '|';

  const lines: string[] = [];
  lines.push(formatRow(mdRows[0]));
  lines.push(formatRow(mdRows[0].map(() => '---')));
  for (let i = 1; i < mdRows.length; i++) {
    lines.push(formatRow(mdRows[i]));
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
