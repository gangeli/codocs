/**
 * CodocsClient — the main public API for interacting with Google Docs.
 */

import type {
  AuthConfig,
  AgentIdentity,
  WriteOptions,
  ReadOptions,
  CommentInput,
  DocComment,
  AttributionSpan,
} from '../types.js';
import { AGENT_RANGE_PREFIX } from '../types.js';
import { createAuth } from '../auth/index.js';
import { DocsApi } from './docs-api.js';
import { DriveApi } from './drive-api.js';
import { markdownToDocsRequests, markdownToDocsRequestsAsync } from '../converter/md-to-docs.js';
import { docsToMarkdown } from '../converter/docs-to-md.js';
import {
  createAttributionRequests,
  extractAttributions,
  deleteNamedRangeRequest,
} from '../attribution/index.js';
import {
  addComment as addCommentImpl,
  listComments as listCommentsImpl,
  resolveComment as resolveCommentImpl,
} from '../comments/index.js';

export class CodocsClient {
  private docsApi: DocsApi;
  private driveApi: DriveApi;

  constructor(config: AuthConfig) {
    const auth = createAuth(config);
    this.docsApi = new DocsApi(auth);
    this.driveApi = new DriveApi(auth);
  }

  /**
   * Create a new blank Google Doc. Returns the document ID.
   */
  async createDoc(title: string): Promise<string> {
    return this.docsApi.createDocument(title);
  }

  /**
   * Fetch the full document object (for advanced use, e.g. diff engine).
   */
  async getDocument(docId: string): Promise<import('googleapis').docs_v1.Schema$Document> {
    return this.docsApi.getDocument(docId);
  }

  /**
   * Fetch the full document with all tabs included.
   */
  async getDocumentWithTabs(docId: string): Promise<import('googleapis').docs_v1.Schema$Document> {
    return this.docsApi.getDocumentWithTabs(docId);
  }

  /**
   * Send a batch of update requests to the document.
   */
  async batchUpdate(docId: string, requests: import('googleapis').docs_v1.Schema$Request[]): Promise<void> {
    await this.docsApi.batchUpdate(docId, requests);
  }

  // ── Tab operations ────────────────────────────────────────────────

  /**
   * Create a new tab in a document. Returns the tab ID.
   */
  async createTab(docId: string, title: string, index?: number): Promise<string> {
    return this.docsApi.addTab(docId, title, index);
  }

  /**
   * Delete a tab from a document.
   */
  async deleteTab(docId: string, tabId: string): Promise<void> {
    return this.docsApi.deleteTab(docId, tabId);
  }

  /**
   * Read a specific tab as markdown.
   * The document is fetched with `includeTabsContent: true`.
   */
  async getTabMarkdown(docId: string, tabId: string, opts: ReadOptions = {}): Promise<string> {
    const doc = await this.docsApi.getDocumentWithTabs(docId);
    return docsToMarkdown(doc, { ...opts, tabId });
  }

  /**
   * Write markdown content to a specific tab.
   */
  async writeTabMarkdown(
    docId: string,
    tabId: string,
    markdown: string,
    opts: WriteOptions = {},
  ): Promise<void> {
    const doc = await this.docsApi.getDocumentWithTabs(docId);
    const { getTabBody } = await import('../converter/docs-to-md.js');
    const tabBody = getTabBody(doc, tabId);
    const bodyEndIndex = tabBody?.content?.length
      ? (tabBody.content[tabBody.content.length - 1].endIndex ?? 1)
      : 1;

    const mode = opts.mode ?? 'replace';
    let insertionIndex: number;
    let clearFirst: boolean;

    if (opts.insertAt !== undefined) {
      insertionIndex = opts.insertAt;
      clearFirst = false;
    } else if (mode === 'append') {
      insertionIndex = Math.max(1, bodyEndIndex - 1);
      clearFirst = false;
    } else {
      insertionIndex = 1;
      clearFirst = bodyEndIndex > 2;
    }

    const hasMermaid = /```mermaid\b/.test(markdown);

    if (hasMermaid) {
      const { markdownToDocsRequestsAsync } = await import('../converter/md-to-docs.js');
      const result = await markdownToDocsRequestsAsync(
        markdown,
        insertionIndex,
        clearFirst,
        bodyEndIndex,
        { driveApi: this.driveApi, documentId: docId },
      );
      if (result.requests.length === 0) return;

      if (opts.agent && result.text.length > 0) {
        const attrRequests = createAttributionRequests(
          opts.agent.name,
          insertionIndex,
          insertionIndex + result.text.length,
          opts.agent.color,
        );
        result.requests.push(...attrRequests);
      }

      try {
        await this.docsApi.batchUpdateTab(docId, tabId, result.requests);
      } finally {
        for (const fileId of result.tempDriveFileIds) {
          try { await this.driveApi.deleteFile(fileId); } catch { /* best-effort */ }
        }
      }
      return;
    }

    const { markdownToDocsRequests } = await import('../converter/md-to-docs.js');
    const { text, requests } = markdownToDocsRequests(
      markdown,
      insertionIndex,
      clearFirst,
      bodyEndIndex,
    );
    if (requests.length === 0) return;

    if (opts.agent && text.length > 0) {
      const attrRequests = createAttributionRequests(
        opts.agent.name,
        insertionIndex,
        insertionIndex + text.length,
        opts.agent.color,
      );
      requests.push(...attrRequests);
    }

    await this.docsApi.batchUpdateTab(docId, tabId, requests);
  }

  /**
   * Create a new Google Doc inside a named Drive folder.
   * Creates the folder if it doesn't exist. Returns the document ID.
   */
  async createDocInFolder(
    title: string,
    folderName: string = 'Codocs',
  ): Promise<{ docId: string; folderId: string }> {
    const folderId = await this.driveApi.findOrCreateFolder(folderName);
    const docId = await this.docsApi.createDocument(title);
    await this.driveApi.moveToFolder(docId, folderId);
    return { docId, folderId };
  }

  /**
   * Write markdown content to a Google Doc.
   *
   * By default, replaces the entire document body. Use `opts.mode = 'append'`
   * to add content to the end, or `opts.insertAt` for precise placement.
   */
  async writeMarkdown(
    docId: string,
    markdown: string,
    opts: WriteOptions = {},
  ): Promise<void> {
    const mode = opts.mode ?? 'replace';

    // Get current document to know its end index
    const doc = await this.docsApi.getDocument(docId);
    const body = doc.body;
    const bodyEndIndex = getBodyEndIndex(body);

    let insertionIndex: number;
    let clearFirst: boolean;

    if (opts.insertAt !== undefined) {
      insertionIndex = opts.insertAt;
      clearFirst = false;
    } else if (mode === 'append') {
      // Insert before the final newline
      insertionIndex = Math.max(1, bodyEndIndex - 1);
      clearFirst = false;
    } else {
      // Replace mode
      insertionIndex = 1;
      clearFirst = bodyEndIndex > 2;
    }

    // Use async path if markdown contains mermaid blocks
    const hasMermaid = /```mermaid\b/.test(markdown);

    if (hasMermaid) {
      const result = await markdownToDocsRequestsAsync(
        markdown,
        insertionIndex,
        clearFirst,
        bodyEndIndex,
        { driveApi: this.driveApi, documentId: docId },
      );

      if (result.requests.length === 0) return;

      if (opts.agent && result.text.length > 0) {
        const attrRequests = createAttributionRequests(
          opts.agent.name,
          insertionIndex,
          insertionIndex + result.text.length,
          opts.agent.color,
        );
        result.requests.push(...attrRequests);
      }

      try {
        await this.docsApi.batchUpdate(docId, result.requests);
      } finally {
        // Always clean up temp Drive files
        for (const fileId of result.tempDriveFileIds) {
          try {
            await this.driveApi.deleteFile(fileId);
          } catch {
            // Best-effort cleanup
          }
        }
      }

      // Store mermaid mappings in DB for round-trip restoration.
      // The Docs API has no way to set image description/title, so we
      // rely on positional matching: mermaid sources stored in the DB
      // are matched to inline images in document order when reading back.
      if (opts.db && result.mermaidHashes.length > 0) {
        try {
          const { MermaidStore, saveDatabase } = await import('@codocs/db');
          const store = new MermaidStore(opts.db as any);
          for (const { source } of result.mermaidHashes) {
            store.save(docId, source);
          }
          saveDatabase(opts.db as any);
        } catch {
          // Non-critical — diagram will still render, just won't round-trip
        }
      }

      return;
    }

    // Sync path (no mermaid blocks)
    const { text, requests } = markdownToDocsRequests(
      markdown,
      insertionIndex,
      clearFirst,
      bodyEndIndex,
    );

    if (requests.length === 0) return;

    if (opts.agent && text.length > 0) {
      const attrRequests = createAttributionRequests(
        opts.agent.name,
        insertionIndex,
        insertionIndex + text.length,
        opts.agent.color,
      );
      requests.push(...attrRequests);
    }

    await this.docsApi.batchUpdate(docId, requests);
  }

  /**
   * Read a Google Doc as markdown.
   *
   * Optionally filter by agent or include attribution markers.
   */
  async readMarkdown(docId: string, opts: ReadOptions = {}): Promise<string> {
    const doc = await this.docsApi.getDocument(docId);

    // Load mermaid sources from DB for restoring diagrams from images
    let mermaidSources: string[] | undefined;
    if (opts.db) {
      try {
        const { MermaidStore } = await import('@codocs/db');
        const store = new MermaidStore(opts.db as any);
        const mappings = store.getAllForDocument(docId);
        if (mappings.size > 0) {
          mermaidSources = [...mappings.values()];
        }
      } catch {
        // Non-critical
      }
    }

    return docsToMarkdown(doc, {
      agentFilter: opts.agentFilter,
      includeAttribution: opts.includeAttribution,
      mermaidSources,
    });
  }

  /**
   * Add a comment to a Google Doc.
   *
   * If `comment.quotedText` is provided, the comment will be anchored
   * to that text in the document. Returns the comment ID.
   */
  async addComment(docId: string, comment: CommentInput): Promise<string> {
    return addCommentImpl(this.driveApi, docId, comment);
  }

  /**
   * Reply to an existing comment on a Google Doc.
   */
  async replyToComment(docId: string, commentId: string, content: string): Promise<string> {
    return this.driveApi.replyToComment(docId, commentId, content);
  }

  /**
   * Update an existing reply on a comment.
   */
  async updateReply(docId: string, commentId: string, replyId: string, content: string): Promise<void> {
    return this.driveApi.updateReply(docId, commentId, replyId, content);
  }

  /**
   * Delete a reply on a comment.
   */
  async deleteReply(docId: string, commentId: string, replyId: string): Promise<void> {
    return this.driveApi.deleteReply(docId, commentId, replyId);
  }

  /**
   * Share a doc with an email address. Idempotent.
   * Used to grant the service account commenter access.
   */
  async ensureShared(
    docId: string,
    email: string,
    role: 'commenter' | 'reader' | 'writer' = 'commenter',
  ): Promise<void> {
    return this.driveApi.ensureShared(docId, email, role);
  }

  /**
   * List all comments on a Google Doc.
   */
  async listComments(docId: string): Promise<DocComment[]> {
    return listCommentsImpl(this.driveApi, docId);
  }

  /**
   * Resolve a comment on a Google Doc.
   */
  async resolveComment(docId: string, commentId: string): Promise<void> {
    return resolveCommentImpl(this.driveApi, docId, commentId);
  }

  // ── Server lock (cross-machine singleton) ──────────────────────

  /**
   * Check if another codocs server is actively running for this document.
   * Returns the heartbeat info if a live server is detected, or null.
   */
  async getServerHeartbeat(docId: string): Promise<{ timestamp: string; host: string; sessionId: string } | null> {
    const props = await this.driveApi.getAppProperties(docId);
    const raw = props.codocs_heartbeat;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Write a server heartbeat to the document's appProperties.
   */
  async setServerHeartbeat(docId: string, info: { timestamp: string; host: string; sessionId: string }): Promise<void> {
    await this.driveApi.setAppProperties(docId, {
      codocs_heartbeat: JSON.stringify(info),
    });
  }

  /**
   * Clear the server heartbeat (on shutdown).
   */
  async clearServerHeartbeat(docId: string): Promise<void> {
    await this.driveApi.setAppProperties(docId, {
      codocs_heartbeat: null,
    });
  }

  /**
   * Get all agent attribution spans in a document.
   */
  async getAttributions(docId: string): Promise<AttributionSpan[]> {
    const doc = await this.docsApi.getDocument(docId);
    return extractAttributions(doc);
  }

  /**
   * Get the markdown content attributed to a specific agent.
   */
  async getAgentContent(docId: string, agentName: string): Promise<string> {
    return this.readMarkdown(docId, { agentFilter: agentName });
  }

  /**
   * Replace the content of a named section (identified by agent name).
   *
   * Uses two API round-trips for safety: first deletes the old content
   * and named range, then re-fetches and inserts new content with a
   * fresh named range.
   */
  async editSection(
    docId: string,
    sectionName: string,
    markdown: string,
    agent?: AgentIdentity,
  ): Promise<void> {
    const doc = await this.docsApi.getDocument(docId);
    const spans = extractAttributions(doc);
    const matching = spans.filter((s) => s.agentName === sectionName);

    if (matching.length === 0) {
      const available = [...new Set(spans.map((s) => s.agentName))];
      throw new Error(
        `Section "${sectionName}" not found. Available sections: ${available.join(', ') || '(none)'}`,
      );
    }

    // Collect all ranges and named range IDs to delete
    const deleteRequests: import('googleapis').docs_v1.Schema$Request[] = [];

    for (const span of matching) {
      deleteRequests.push(deleteNamedRangeRequest(span.namedRangeId));
    }

    // Delete content ranges in reverse order (highest index first)
    const allRanges = matching
      .flatMap((s) => s.ranges)
      .sort((a, b) => b.startIndex - a.startIndex);

    // Google Docs forbids deleting the trailing newline at the end of the body segment
    const bodyEnd = getBodyEndIndex(doc.body);

    for (const range of allRanges) {
      const endIndex = range.endIndex >= bodyEnd ? bodyEnd - 1 : range.endIndex;
      if (endIndex > range.startIndex) {
        deleteRequests.push({
          deleteContentRange: {
            range: { startIndex: range.startIndex, endIndex },
          },
        });
      }
    }

    // Batch 1: delete named ranges and content
    await this.docsApi.batchUpdate(docId, deleteRequests);

    // Batch 2: re-fetch and insert new content
    const insertionIndex = allRanges[allRanges.length - 1]?.startIndex ?? 1;
    const effectiveAgent = agent ?? { name: sectionName };

    await this.writeMarkdown(docId, markdown, {
      mode: 'append',
      insertAt: insertionIndex,
      agent: effectiveAgent,
    });
  }

  /**
   * Insert a new section after an existing section (or at the end of the doc).
   */
  async insertAfterSection(
    docId: string,
    afterSection: string | undefined,
    markdown: string,
    agent: AgentIdentity,
  ): Promise<void> {
    let insertionIndex: number;

    if (afterSection) {
      const doc = await this.docsApi.getDocument(docId);
      const spans = extractAttributions(doc);
      const matching = spans.filter((s) => s.agentName === afterSection);

      if (matching.length === 0) {
        const available = [...new Set(spans.map((s) => s.agentName))];
        throw new Error(
          `Section "${afterSection}" not found. Available sections: ${available.join(', ') || '(none)'}`,
        );
      }

      // Find the maximum end index across all ranges for this section
      insertionIndex = Math.max(
        ...matching.flatMap((s) => s.ranges.map((r) => r.endIndex)),
      );
    } else {
      // Insert at end of document
      const doc = await this.docsApi.getDocument(docId);
      const bodyEnd = getBodyEndIndex(doc.body);
      insertionIndex = Math.max(1, bodyEnd - 1);
    }

    await this.writeMarkdown(docId, markdown, {
      mode: 'append',
      insertAt: insertionIndex,
      agent,
    });
  }
}

function getBodyEndIndex(
  body: import('googleapis').docs_v1.Schema$Body | undefined,
): number {
  if (!body?.content?.length) return 1;
  const last = body.content[body.content.length - 1];
  return last.endIndex ?? 1;
}
