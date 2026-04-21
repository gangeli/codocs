import { google, type docs_v1 } from 'googleapis';

/**
 * Google Docs API enforces a ~60 write-ops/minute/user quota. When we hit
 * it during bursty runs (e2e test suites, large edits), retry with
 * exponential backoff instead of surfacing the 429 straight to the caller.
 */
async function withQuotaRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 6;
  let delayMs = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const isQuota =
        err?.code === 429 ||
        /Quota exceeded/i.test(msg) ||
        /RATE_LIMIT_EXCEEDED/i.test(msg);
      if (!isQuota || attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
  throw new Error(`unreachable in withQuotaRetry(${label})`);
}

export class DocsApi {
  private docs: docs_v1.Docs;

  constructor(auth: unknown) {
    this.docs = google.docs({ version: 'v1', auth: auth as any });
  }

  /** Create a new blank document in pageless format. Returns the document ID. */
  async createDocument(title: string): Promise<string> {
    const res = await withQuotaRetry(
      () => this.docs.documents.create({ requestBody: { title } }),
      'createDocument',
    );
    const docId = res.data.documentId!;

    // Switch to pageless format by setting a very large page height
    try {
      await withQuotaRetry(
        () =>
          this.docs.documents.batchUpdate({
            documentId: docId,
            requestBody: {
              requests: [{
                updateDocumentStyle: {
                  documentStyle: {
                    pageSize: {
                      width: { magnitude: 612, unit: 'PT' },
                      height: { magnitude: 100000, unit: 'PT' },
                    },
                  },
                  fields: 'pageSize',
                },
              }],
            },
          }),
        'createDocument.pageless',
      );
    } catch {
      // Non-critical — doc still works with default page size
    }

    return docId;
  }

  /** Fetch a full document (default tab only). */
  async getDocument(documentId: string): Promise<docs_v1.Schema$Document> {
    const res = await withQuotaRetry(
      () => this.docs.documents.get({ documentId }),
      'getDocument',
    );
    return res.data;
  }

  /** Fetch a full document with all tabs included. */
  async getDocumentWithTabs(documentId: string): Promise<docs_v1.Schema$Document> {
    const res = await withQuotaRetry(
      () =>
        this.docs.documents.get({
          documentId,
          includeTabsContent: true,
        }),
      'getDocumentWithTabs',
    );
    return res.data;
  }

  /** Send a batch of update requests. */
  async batchUpdate(
    documentId: string,
    requests: docs_v1.Schema$Request[],
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    const res = await withQuotaRetry(
      () =>
        this.docs.documents.batchUpdate({
          documentId,
          requestBody: { requests },
        }),
      'batchUpdate',
    );
    return res.data;
  }

  /**
   * Add a new tab to a document. Returns the new tab's ID.
   */
  async addTab(documentId: string, title: string, index?: number): Promise<string> {
    const tabProperties: docs_v1.Schema$TabProperties = { title };
    if (index !== undefined) tabProperties.index = index;

    const res = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{
          addDocumentTab: { tabProperties },
        }],
      },
    });

    // Extract tabId from the batchUpdate reply
    const reply = (res.data.replies ?? [])[0];
    return reply?.addDocumentTab?.tabProperties?.tabId ?? '';
  }

  /**
   * Delete a tab from a document.
   */
  async deleteTab(documentId: string, tabId: string): Promise<void> {
    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{
          deleteTab: { tabId },
        }],
      },
    });
  }

  /**
   * Send a batch of update requests targeting a specific tab.
   * Injects `tabId` into all Location and Range objects in the requests.
   */
  async batchUpdateTab(
    documentId: string,
    tabId: string,
    requests: docs_v1.Schema$Request[],
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    const tabRequests = injectTabId(requests, tabId);
    return this.batchUpdate(documentId, tabRequests);
  }
}

/**
 * Deep-clone requests and inject `tabId` into all Location and Range objects.
 */
export function injectTabId(
  requests: docs_v1.Schema$Request[],
  tabId: string,
): docs_v1.Schema$Request[] {
  const cloned = JSON.parse(JSON.stringify(requests)) as docs_v1.Schema$Request[];
  for (const req of cloned) {
    injectTabIdIntoObject(req, tabId);
  }
  return cloned;
}

/**
 * Recursively walk an object and set `tabId` on any object that has
 * a `startIndex`, `endIndex`, or `index` field (i.e., Location/Range-like objects).
 */
function injectTabIdIntoObject(obj: any, tabId: string): void {
  if (obj == null || typeof obj !== 'object') return;

  // Location-like: has `index` and optionally `segmentId`
  if ('index' in obj && typeof obj.index === 'number') {
    obj.tabId = tabId;
  }
  // Range-like: has `startIndex` and `endIndex`
  if ('startIndex' in obj && 'endIndex' in obj) {
    obj.tabId = tabId;
  }

  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      injectTabIdIntoObject(value, tabId);
    }
  }
}
