/**
 * Convert a markdown string into Google Docs batchUpdate requests.
 */

import type { docs_v1 } from 'googleapis';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root } from 'mdast';
import { walkAst } from './ast-walker.js';

export interface MdToDocsResult {
  /** The plain text that will be inserted. */
  text: string;
  /** All batchUpdate requests, in the order they should be sent. */
  requests: docs_v1.Schema$Request[];
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
  // Parse markdown to mdast AST
  const tree = unified().use(remarkParse).parse(markdown) as Root;

  // Walk the AST to get plain text + style/bullet requests
  const { text, styleRequests, bulletRequests } = walkAst(tree, insertionIndex);

  const requests: docs_v1.Schema$Request[] = [];

  // 1. Optionally clear existing content
  if (clearFirst && endIndex && endIndex > 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 },
      },
    });
  }

  // 2. Insert the plain text
  if (text.length > 0) {
    requests.push({
      insertText: {
        location: { index: insertionIndex },
        text,
      },
    });
  }

  // 3. Apply text styles (reverse order to preserve indexes)
  const sortedStyles = [...styleRequests].sort((a, b) => {
    const aStart = getStartIndex(a);
    const bStart = getStartIndex(b);
    return bStart - aStart;
  });
  requests.push(...sortedStyles);

  // 4. Apply bullet formatting
  requests.push(...bulletRequests);

  return { text, requests };
}

function getStartIndex(req: docs_v1.Schema$Request): number {
  if (req.updateTextStyle) {
    return req.updateTextStyle.range?.startIndex ?? 0;
  }
  if (req.updateParagraphStyle) {
    return req.updateParagraphStyle.range?.startIndex ?? 0;
  }
  return 0;
}
