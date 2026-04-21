/**
 * Walk an mdast AST and produce:
 *  1. Segments of content (text or tables) to insert into Google Docs
 *  2. Styling / structural requests to apply after insertion
 *
 * Text segment indexes are relative (0-based within each segment) —
 * the caller adjusts them to absolute document positions.
 */

import type { docs_v1 } from 'googleapis';
import type { Root, Content, Heading, List, ListItem, Table, TableRow, TableCell, Code, InlineCode, Link, Image, Paragraph, Blockquote } from 'mdast';
import { headingDepthToNamedStyle, CODE_FONT_FAMILY, CODE_BLOCK_BG } from './style-map.js';

// ── Segment types ──────────────────────────────────────────────

export interface TextSegment {
  type: 'text';
  /** Plain text to insert. */
  text: string;
  /** Style requests with offsets relative to segment start (0-based). */
  styles: docs_v1.Schema$Request[];
  /** Bullet requests with offsets relative to segment start (0-based). */
  bullets: docs_v1.Schema$Request[];
}

export interface TableSegment {
  type: 'table';
  /** Cell content by row (array of rows, each row an array of cell strings). */
  rows: string[][];
  /** Number of columns. */
  numColumns: number;
}

export type ImageSegment =
  | {
      type: 'image';
      kind: 'mermaid';
      /** Original mermaid source code. */
      mermaidSource: string;
    }
  | {
      type: 'image';
      kind: 'remote';
      /** Source URL from the markdown image. */
      url: string;
      /** Alt text — lost on Docs insertion (API has no title field), kept for fallback. */
      alt: string;
    };

export interface BlockquoteSegment {
  type: 'blockquote';
  /** Inner text of the blockquote. */
  text: string;
  /** Style requests with offsets relative to text start (0-based). */
  styles: docs_v1.Schema$Request[];
}

export type WalkSegment = TextSegment | TableSegment | ImageSegment | BlockquoteSegment;

export interface WalkResult {
  /** Ordered segments of content. */
  segments: WalkSegment[];
}

// ── Internal context ───────────────────────────────────────────

interface WalkContext {
  /** Current character offset within the active text segment (0-based). */
  offset: number;
  /** Accumulated plain text for the current segment. */
  buf: string;
  /** Style requests for the current segment (relative offsets). */
  styles: docs_v1.Schema$Request[];
  /** Bullet requests for the current segment. */
  bullets: docs_v1.Schema$Request[];
  /** Accumulated segments. */
  segments: WalkSegment[];
  /** Active inline styles (stack). */
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link: string | null;
}

// ── Public entry point ─────────────────────────────────────────

export function walkAst(root: Root, _insertionOffset?: number): WalkResult {
  const ctx: WalkContext = {
    offset: 0,
    buf: '',
    styles: [],
    bullets: [],
    segments: [],
    bold: false,
    italic: false,
    strikethrough: false,
    code: false,
    link: null,
  };

  walkChildren(root.children, ctx, 0, false);

  // Flush remaining text segment
  flushTextSegment(ctx);

  // Remove trailing newline from last text segment (Docs always has one)
  const last = ctx.segments[ctx.segments.length - 1];
  if (last?.type === 'text' && last.text.endsWith('\n')) {
    last.text = last.text.slice(0, -1);
  }

  return { segments: ctx.segments };
}

// ── Segment management ─────────────────────────────────────────

function flushTextSegment(ctx: WalkContext) {
  if (ctx.buf.length > 0 || ctx.styles.length > 0 || ctx.bullets.length > 0) {
    ctx.segments.push({
      type: 'text',
      text: ctx.buf,
      styles: [...ctx.styles],
      bullets: consolidateBullets(ctx.bullets),
    });
  }
  ctx.buf = '';
  ctx.offset = 0;
  ctx.styles = [];
  ctx.bullets = [];
}

// When Docs receives multiple createParagraphBullets requests with the same
// preset on adjacent paragraphs, it coalesces them into a single list and
// ignores per-paragraph leading tabs in the later requests — flattening the
// whole list to level 0. Merging adjacent same-preset ranges into one
// request lets the API interpret each paragraph's tabs independently, which
// is what produces the nesting levels.
function consolidateBullets(bullets: docs_v1.Schema$Request[]): docs_v1.Schema$Request[] {
  const merged: docs_v1.Schema$Request[] = [];
  for (const req of bullets) {
    const cur = req.createParagraphBullets;
    const prev = merged[merged.length - 1]?.createParagraphBullets;
    if (
      prev &&
      cur &&
      prev.bulletPreset === cur.bulletPreset &&
      prev.range?.endIndex === cur.range?.startIndex
    ) {
      prev.range!.endIndex = cur.range!.endIndex;
    } else {
      merged.push({ createParagraphBullets: { ...cur, range: { ...cur!.range } } });
    }
  }
  return merged;
}

// ── AST walking ────────────────────────────────────────────────

function walkChildren(
  children: Content[],
  ctx: WalkContext,
  listDepth: number,
  inBlockquote: boolean,
) {
  for (let i = 0; i < children.length; i++) {
    walkNode(children[i], ctx, listDepth, inBlockquote);
  }
}

// When adding a new mdast node type (or changing what an existing case emits),
// add/update a fixture in scripts/e2e-visual-test.ts — Docs-API enum values and
// shape mismatches only surface against a real doc.
function walkNode(
  node: Content,
  ctx: WalkContext,
  listDepth: number,
  inBlockquote: boolean,
) {
  switch (node.type) {
    case 'heading':
      walkHeading(node as Heading, ctx);
      break;
    case 'paragraph':
      walkParagraph(node as Paragraph, ctx, listDepth, inBlockquote);
      break;
    case 'text':
      emitText(node.value, ctx);
      break;
    case 'strong':
      withStyle(ctx, 'bold', true, () =>
        walkChildren((node as any).children, ctx, listDepth, inBlockquote),
      );
      break;
    case 'emphasis':
      withStyle(ctx, 'italic', true, () =>
        walkChildren((node as any).children, ctx, listDepth, inBlockquote),
      );
      break;
    case 'delete':
      withStyle(ctx, 'strikethrough', true, () =>
        walkChildren((node as any).children, ctx, listDepth, inBlockquote),
      );
      break;
    case 'inlineCode':
      emitInlineCode((node as InlineCode).value, ctx);
      break;
    case 'code':
      emitCodeBlock(node as Code, ctx);
      break;
    case 'link':
      walkLink(node as Link, ctx, listDepth, inBlockquote);
      break;
    case 'image':
      emitImage(node as Image, ctx);
      break;
    case 'list':
      walkList(node as List, ctx, listDepth, inBlockquote);
      break;
    case 'listItem':
      walkListItem(node as ListItem, ctx, listDepth, inBlockquote);
      break;
    case 'blockquote':
      walkBlockquote(node as Blockquote, ctx, listDepth);
      break;
    case 'table':
      walkTable(node as Table, ctx);
      break;
    case 'thematicBreak':
      emitHorizontalRule(ctx);
      break;
    case 'html':
      // Pass HTML through as plain text
      emitText((node as any).value, ctx);
      ensureNewline(ctx);
      break;
    default:
      // For unknown nodes with children, recurse
      if ('children' in node) {
        walkChildren((node as any).children, ctx, listDepth, inBlockquote);
      }
      break;
  }
}

// ── Node handlers ──────────────────────────────────────────────

function walkHeading(node: Heading, ctx: WalkContext) {
  const startOffset = ctx.offset;
  walkChildren(node.children as Content[], ctx, 0, false);
  ensureNewline(ctx);

  ctx.styles.push({
    updateParagraphStyle: {
      range: {
        startIndex: startOffset,
        endIndex: ctx.offset,
      },
      paragraphStyle: {
        namedStyleType: headingDepthToNamedStyle(node.depth),
      },
      fields: 'namedStyleType',
    },
  });
}

function walkParagraph(
  node: Paragraph,
  ctx: WalkContext,
  listDepth: number,
  inBlockquote: boolean,
) {
  const startOffset = ctx.offset;
  walkChildren(node.children as Content[], ctx, listDepth, inBlockquote);
  ensureNewline(ctx);

  // Explicitly set NORMAL_TEXT so paragraphs don't inherit the style of
  // the insertion point (e.g., a heading style when inserting after a heading).
  if (ctx.offset > startOffset) {
    ctx.styles.push({
      updateParagraphStyle: {
        range: {
          startIndex: startOffset,
          endIndex: ctx.offset,
        },
        paragraphStyle: {
          namedStyleType: 'NORMAL_TEXT',
        },
        fields: 'namedStyleType',
      },
    });
  }
}

function walkLink(
  node: Link,
  ctx: WalkContext,
  listDepth: number,
  inBlockquote: boolean,
) {
  const start = ctx.offset;
  walkChildren(node.children as Content[], ctx, listDepth, inBlockquote);
  const end = ctx.offset;

  if (end > start) {
    ctx.styles.push({
      updateTextStyle: {
        range: { startIndex: start, endIndex: end },
        textStyle: {
          link: { url: node.url },
        },
        fields: 'link',
      },
    });
  }
}

function emitText(text: string, ctx: WalkContext) {
  const start = ctx.offset;
  ctx.buf += text;
  ctx.offset += text.length;
  const end = ctx.offset;

  // Apply any active inline styles
  const textStyle: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];

  if (ctx.bold) {
    textStyle.bold = true;
    fields.push('bold');
  }
  if (ctx.italic) {
    textStyle.italic = true;
    fields.push('italic');
  }
  if (ctx.strikethrough) {
    textStyle.strikethrough = true;
    fields.push('strikethrough');
  }

  if (fields.length > 0 && end > start) {
    ctx.styles.push({
      updateTextStyle: {
        range: { startIndex: start, endIndex: end },
        textStyle,
        fields: fields.join(','),
      },
    });
  }
}

function emitInlineCode(value: string, ctx: WalkContext) {
  const start = ctx.offset;
  ctx.buf += value;
  ctx.offset += value.length;
  const end = ctx.offset;

  ctx.styles.push({
    updateTextStyle: {
      range: { startIndex: start, endIndex: end },
      textStyle: {
        weightedFontFamily: { fontFamily: CODE_FONT_FAMILY },
        backgroundColor: CODE_BLOCK_BG,
      },
      fields: 'weightedFontFamily,backgroundColor',
    },
  });
}

function emitCodeBlock(node: Code, ctx: WalkContext) {
  // Mermaid code blocks become ImageSegments for later rendering
  if (node.lang === 'mermaid') {
    flushTextSegment(ctx);
    ctx.segments.push({ type: 'image', kind: 'mermaid', mermaidSource: node.value });
    return;
  }

  const start = ctx.offset;
  ctx.buf += node.value;
  ctx.offset += node.value.length;
  ensureNewline(ctx);
  const end = ctx.offset;

  ctx.styles.push({
    updateTextStyle: {
      range: { startIndex: start, endIndex: end },
      textStyle: {
        weightedFontFamily: { fontFamily: CODE_FONT_FAMILY },
      },
      fields: 'weightedFontFamily',
    },
  });
  ctx.styles.push({
    updateParagraphStyle: {
      range: { startIndex: start, endIndex: end },
      paragraphStyle: {
        shading: { backgroundColor: CODE_BLOCK_BG },
      },
      fields: 'shading',
    },
  });
}

function emitImage(node: Image, ctx: WalkContext) {
  flushTextSegment(ctx);
  ctx.segments.push({
    type: 'image',
    kind: 'remote',
    url: node.url,
    alt: node.alt || 'image',
  });
}

function walkList(
  node: List,
  ctx: WalkContext,
  listDepth: number,
  inBlockquote: boolean,
) {
  const children = node.children as Content[];
  for (let i = 0; i < children.length; i++) {
    const item = children[i] as ListItem;
    const isCheckbox = item.checked !== null && item.checked !== undefined;
    const isChecked = item.checked === true;
    const itemStart = ctx.offset;

    // createParagraphBullets derives the nesting level from leading tabs
    // in each paragraph — emit listDepth tabs so nested items nest.
    if (listDepth > 0) {
      const tabs = '\t'.repeat(listDepth);
      ctx.buf += tabs;
      ctx.offset += tabs.length;
    }

    const contentStart = ctx.offset;

    // Walk ONLY this item's own (non-list) children first. We defer nested
    // lists so this item's bullet range stays tight to its own paragraph —
    // overlapping ranges cause createParagraphBullets to strip the leading
    // tabs from nested items before their own bullet request runs, which
    // flattens the whole tree to level 0.
    const nestedLists: List[] = [];
    for (const child of item.children as Content[]) {
      if (child.type === 'list') {
        nestedLists.push(child as List);
      } else {
        walkNode(child, ctx, listDepth + 1, inBlockquote);
      }
    }

    const ownEnd = ctx.offset;

    // The Docs API has no way to set a native checkbox to "checked" — the
    // visual for a checked task is strikethrough text. We mirror the same
    // encoding here (and element-parser reads it back the same way).
    if (isChecked && ownEnd > contentStart) {
      ctx.styles.push({
        updateTextStyle: {
          range: { startIndex: contentStart, endIndex: ownEnd },
          textStyle: { strikethrough: true },
          fields: 'strikethrough',
        },
      });
    }

    ctx.bullets.push({
      createParagraphBullets: {
        range: { startIndex: itemStart, endIndex: ownEnd },
        bulletPreset: isCheckbox
          ? 'BULLET_CHECKBOX'
          : node.ordered
            ? 'NUMBERED_DECIMAL_NESTED'
            : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });

    // Now walk any nested lists. They push their own bullet requests for
    // their own ranges.
    for (const nested of nestedLists) {
      walkList(nested, ctx, listDepth + 1, inBlockquote);
    }
  }
}

function walkListItem(
  node: ListItem,
  ctx: WalkContext,
  listDepth: number,
  inBlockquote: boolean,
) {
  // Reached only when mdast gives us a stray listItem outside a list;
  // walkList handles the normal case and never calls through here.
  for (const child of node.children as Content[]) {
    if (child.type === 'list') {
      walkList(child as List, ctx, listDepth, inBlockquote);
    } else {
      walkNode(child, ctx, listDepth, inBlockquote);
    }
  }
}

function walkBlockquote(node: Blockquote, ctx: WalkContext, listDepth: number) {
  // Render blockquotes as a 1x1 borderless table with a thick left bar. We
  // walk the children into a fresh sub-context so the text/styles are
  // captured in isolation, then emit a BlockquoteSegment the downstream
  // processor can turn into a 1-cell table.
  flushTextSegment(ctx);

  const savedBuf = ctx.buf;
  const savedOffset = ctx.offset;
  const savedStyles = ctx.styles;
  const savedBullets = ctx.bullets;

  ctx.buf = '';
  ctx.offset = 0;
  ctx.styles = [];
  ctx.bullets = [];

  walkChildren(node.children as Content[], ctx, listDepth, true);

  let text = ctx.buf;
  if (text.endsWith('\n')) text = text.slice(0, -1);

  ctx.segments.push({ type: 'blockquote', text, styles: ctx.styles });

  ctx.buf = savedBuf;
  ctx.offset = savedOffset;
  ctx.styles = savedStyles;
  ctx.bullets = savedBullets;
}

function walkTable(node: Table, ctx: WalkContext) {
  // Flush any preceding text as its own segment
  flushTextSegment(ctx);

  // Extract cell content
  const rows = (node.children as TableRow[]).map((row) => {
    return (row.children as TableCell[]).map((cell) => {
      let text = '';
      for (const child of cell.children as Content[]) {
        if (child.type === 'text') text += child.value;
        else if (child.type === 'inlineCode') text += (child as InlineCode).value;
        else if ('children' in child) {
          for (const gc of (child as any).children) {
            if (gc.type === 'text') text += gc.value;
            else if (gc.type === 'inlineCode') text += gc.value;
          }
        }
      }
      return text;
    });
  });

  const numColumns = rows.length > 0 ? Math.max(...rows.map((r) => r.length)) : 0;

  // Pad rows to numColumns
  for (const row of rows) {
    while (row.length < numColumns) row.push('');
  }

  ctx.segments.push({ type: 'table', rows, numColumns });
}

function emitHorizontalRule(ctx: WalkContext) {
  const rule = '———\n';
  ctx.buf += rule;
  ctx.offset += rule.length;
}

function ensureNewline(ctx: WalkContext) {
  if (!ctx.buf.endsWith('\n')) {
    ctx.buf += '\n';
    ctx.offset++;
  }
}

function withStyle(
  ctx: WalkContext,
  prop: 'bold' | 'italic' | 'strikethrough' | 'code',
  value: boolean,
  fn: () => void,
) {
  const prev = ctx[prop];
  ctx[prop] = value;
  fn();
  ctx[prop] = prev;
}
