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
 *                  Use `tabId` when the document was fetched with `includeTabsContent: true`.
 */
export function docsToMarkdown(
  document: docs_v1.Schema$Document,
  options: ParseOptions = {},
): string {
  const doc = options.tabId ? viewForTab(document, options.tabId) : document;
  return parseDocumentToMarkdown(doc, options);
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
  const doc = options.tabId ? viewForTab(document, options.tabId) : document;
  return parseDocumentToMarkdownWithMapping(doc, options);
}

/**
 * Get the body content for a specific tab from a document fetched
 * with `includeTabsContent: true`.
 *
 * Returns a document-shaped object with the tab's body, inlineObjects,
 * lists, and namedRanges so it can be passed directly to the parser.
 */
export function getTabBody(
  document: docs_v1.Schema$Document,
  tabId: string,
): docs_v1.Schema$Body | undefined {
  const tab = findTab(document.tabs ?? [], tabId);
  return tab?.documentTab?.body ?? undefined;
}

/**
 * Create a document-like view for a specific tab so the existing
 * parser (which reads `document.body`, `document.lists`, etc.) works unchanged.
 */
function viewForTab(
  document: docs_v1.Schema$Document,
  tabId: string,
): docs_v1.Schema$Document {
  const tab = findTab(document.tabs ?? [], tabId);
  if (!tab?.documentTab) {
    throw new Error(`Tab "${tabId}" not found in document`);
  }
  const dt = tab.documentTab;
  return {
    ...document,
    body: dt.body ?? undefined,
    inlineObjects: dt.inlineObjects ?? undefined,
    lists: dt.lists ?? undefined,
    namedRanges: dt.namedRanges ?? undefined,
    // Clear tabs to avoid confusion
    tabs: undefined,
  };
}

/**
 * Recursively search for a tab by ID (tabs can be nested).
 */
function findTab(
  tabs: docs_v1.Schema$Tab[],
  tabId: string,
): docs_v1.Schema$Tab | undefined {
  for (const tab of tabs) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    if (tab.childTabs?.length) {
      const found = findTab(tab.childTabs, tabId);
      if (found) return found;
    }
  }
  return undefined;
}
