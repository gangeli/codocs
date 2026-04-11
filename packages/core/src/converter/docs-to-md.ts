/**
 * Convert a Google Docs document to a markdown string.
 */

import type { docs_v1 } from 'googleapis';
import {
  parseDocumentToMarkdown,
  parseDocumentToMarkdownWithMapping,
  type MarkdownWithMapping,
  type ParseOptions,
} from './element-parser.js';

export type { MarkdownWithMapping } from './element-parser.js';

/**
 * Convert a Google Docs document JSON to markdown.
 *
 * @param document - The full document response from documents.get.
 * @param options - Optional filtering, attribution, and mermaid settings.
 */
export function docsToMarkdown(
  document: docs_v1.Schema$Document,
  options: ParseOptions = {},
): string {
  return parseDocumentToMarkdown(document, options);
}

/**
 * Convert a Google Docs document to markdown with an index mapping
 * from markdown character offsets to Google Doc body indices.
 *
 * Used by the diff engine to map markdown changes back to Doc API operations.
 */
export function docsToMarkdownWithMapping(
  document: docs_v1.Schema$Document,
  options: ParseOptions = {},
): MarkdownWithMapping {
  return parseDocumentToMarkdownWithMapping(document, options);
}
