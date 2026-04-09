/**
 * Walk an mdast AST and produce:
 *  1. A flat plain-text string to insert into Google Docs
 *  2. A list of styling / structural requests to apply after insertion
 *
 * All indexes are relative to an `insertionOffset` so callers can
 * control where in the document the content lands.
 */

import type { docs_v1 } from 'googleapis';
import type { Root, Content, Heading, List, ListItem, Table, TableRow, TableCell, Code, InlineCode, Link, Image, Paragraph, Blockquote } from 'mdast';
import { headingDepthToNamedStyle, CODE_FONT_FAMILY, CODE_BLOCK_BG } from './style-map.js';

export interface WalkResult {
  /** The plain text to insert. */
  text: string;
  /** Styling requests to apply after insertion, relative to insertionOffset. */
  styleRequests: docs_v1.Schema$Request[];
  /** Paragraph bullet requests. */
  bulletRequests: docs_v1.Schema$Request[];
}

interface WalkContext {
  /** Current character offset (relative to insertion point). */
  offset: number;
  /** Accumulated plain text. */
  buf: string;
  /** Style requests collected during the walk. */
  styles: docs_v1.Schema$Request[];
  /** Bullet requests collected during the walk. */
  bullets: docs_v1.Schema$Request[];
  /** The document index where insertion starts. */
  insertionOffset: number;
  /** Active inline styles (stack). */
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link: string | null;
}

export function walkAst(root: Root, insertionOffset: number): WalkResult {
  const ctx: WalkContext = {
    offset: 0,
    buf: '',
    styles: [],
    bullets: [],
    insertionOffset,
    bold: false,
    italic: false,
    strikethrough: false,
    code: false,
    link: null,
  };

  walkChildren(root.children, ctx, 0, false);

  // Remove trailing newline if present (Docs always has one)
  if (ctx.buf.endsWith('\n')) {
    ctx.buf = ctx.buf.slice(0, -1);
    ctx.offset--;
  }

  return {
    text: ctx.buf,
    styleRequests: ctx.styles,
    bulletRequests: ctx.bullets,
  };
}

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
      walkChildren((node as Blockquote).children as Content[], ctx, listDepth, true);
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

function walkHeading(node: Heading, ctx: WalkContext) {
  const startOffset = ctx.offset;
  walkChildren(node.children as Content[], ctx, 0, false);
  ensureNewline(ctx);

  const abs = ctx.insertionOffset;
  ctx.styles.push({
    updateParagraphStyle: {
      range: {
        startIndex: abs + startOffset,
        endIndex: abs + ctx.offset,
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
  walkChildren(node.children as Content[], ctx, listDepth, inBlockquote);
  ensureNewline(ctx);
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
    const abs = ctx.insertionOffset;
    ctx.styles.push({
      updateTextStyle: {
        range: { startIndex: abs + start, endIndex: abs + end },
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
    const abs = ctx.insertionOffset;
    ctx.styles.push({
      updateTextStyle: {
        range: { startIndex: abs + start, endIndex: abs + end },
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

  const abs = ctx.insertionOffset;
  ctx.styles.push({
    updateTextStyle: {
      range: { startIndex: abs + start, endIndex: abs + end },
      textStyle: {
        weightedFontFamily: { fontFamily: CODE_FONT_FAMILY },
        backgroundColor: CODE_BLOCK_BG,
      },
      fields: 'weightedFontFamily,backgroundColor',
    },
  });
}

function emitCodeBlock(node: Code, ctx: WalkContext) {
  const start = ctx.offset;
  ctx.buf += node.value;
  ctx.offset += node.value.length;
  ensureNewline(ctx);
  const end = ctx.offset;

  const abs = ctx.insertionOffset;
  ctx.styles.push({
    updateTextStyle: {
      range: { startIndex: abs + start, endIndex: abs + end },
      textStyle: {
        weightedFontFamily: { fontFamily: CODE_FONT_FAMILY },
      },
      fields: 'weightedFontFamily',
    },
  });
  ctx.styles.push({
    updateParagraphStyle: {
      range: { startIndex: abs + start, endIndex: abs + end },
      paragraphStyle: {
        shading: { backgroundColor: CODE_BLOCK_BG },
      },
      fields: 'shading',
    },
  });
}

function emitImage(node: Image, ctx: WalkContext) {
  // Images are complex in the Docs API (require InlineObject).
  // For now, emit the alt text as a placeholder with a link.
  const alt = node.alt || 'image';
  const start = ctx.offset;
  ctx.buf += alt;
  ctx.offset += alt.length;
  ensureNewline(ctx);

  const abs = ctx.insertionOffset;
  ctx.styles.push({
    updateTextStyle: {
      range: { startIndex: abs + start, endIndex: abs + start + alt.length },
      textStyle: {
        link: { url: node.url },
      },
      fields: 'link',
    },
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
    const itemStart = ctx.offset;

    // Walk the list item's content
    walkListItem(item, ctx, listDepth + 1, inBlockquote);
    const itemEnd = ctx.offset;

    const abs = ctx.insertionOffset;
    ctx.bullets.push({
      createParagraphBullets: {
        range: { startIndex: abs + itemStart, endIndex: abs + itemEnd },
        bulletPreset: node.ordered
          ? 'NUMBERED_DECIMAL_NESTED'
          : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
}

function walkListItem(
  node: ListItem,
  ctx: WalkContext,
  listDepth: number,
  inBlockquote: boolean,
) {
  // A list item's children are typically paragraphs or nested lists
  for (const child of node.children as Content[]) {
    if (child.type === 'list') {
      walkList(child as List, ctx, listDepth, inBlockquote);
    } else {
      walkNode(child, ctx, listDepth, inBlockquote);
    }
  }
}

function walkTable(node: Table, ctx: WalkContext) {
  // Tables require InsertTableRequest then filling cells.
  // For the initial implementation, render as plain text grid.
  const rows = node.children as TableRow[];
  for (const row of rows) {
    const cells = row.children as TableCell[];
    const cellTexts = cells.map((cell) => {
      // Flatten cell content to text
      let text = '';
      for (const child of cell.children as Content[]) {
        if (child.type === 'text') text += child.value;
        else if ('children' in child) {
          for (const gc of (child as any).children) {
            if (gc.type === 'text') text += gc.value;
          }
        }
      }
      return text;
    });
    ctx.buf += cellTexts.join('\t') + '\n';
    ctx.offset += cellTexts.join('\t').length + 1;
  }
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
