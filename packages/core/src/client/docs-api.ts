import { google, type docs_v1 } from 'googleapis';

export class DocsApi {
  private docs: docs_v1.Docs;

  constructor(auth: unknown) {
    this.docs = google.docs({ version: 'v1', auth: auth as any });
  }

  /** Create a new blank document in pageless format. Returns the document ID. */
  async createDocument(title: string): Promise<string> {
    const res = await this.docs.documents.create({
      requestBody: { title },
    });
    const docId = res.data.documentId!;

    // Switch to pageless format by setting a very large page height
    try {
      await this.docs.documents.batchUpdate({
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
      });
    } catch {
      // Non-critical — doc still works with default page size
    }

    return docId;
  }

  /** Fetch a full document. */
  async getDocument(documentId: string): Promise<docs_v1.Schema$Document> {
    const res = await this.docs.documents.get({ documentId });
    return res.data;
  }

  /** Send a batch of update requests. */
  async batchUpdate(
    documentId: string,
    requests: docs_v1.Schema$Request[],
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    const res = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });
    return res.data;
  }
}
