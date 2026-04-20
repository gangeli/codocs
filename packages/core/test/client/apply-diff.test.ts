import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { CodocsClient } from '../../src/client/index.js';
import type { DiffResult } from '../../src/harness/diff.js';

/**
 * Fake DocsApi that simulates sequential body growth. Every insertText
 * request in a batch shifts the recorded end index forward by the inserted
 * text length, so subsequent getDocument calls see the grown body.
 *
 * We only model the one field applyDocDiff actually reads —
 * `body.content[-1].endIndex` — and the calls it makes
 * (`getDocument`, `batchUpdate`).
 */
class FakeDocsApi {
  private bodyEnd: number;
  readonly calls: Array<
    | { kind: 'get' }
    | { kind: 'batch'; requests: docs_v1.Schema$Request[]; bodyEndAtCall: number }
  > = [];

  constructor(initialBodyEnd: number) {
    this.bodyEnd = initialBodyEnd;
  }

  async getDocument(): Promise<docs_v1.Schema$Document> {
    this.calls.push({ kind: 'get' });
    return this.makeDoc();
  }

  async batchUpdate(
    _docId: string,
    requests: docs_v1.Schema$Request[],
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    this.calls.push({
      kind: 'batch',
      requests,
      bodyEndAtCall: this.bodyEnd,
    });
    this.applyInserts(requests);
    return {};
  }

  currentBodyEnd(): number {
    return this.bodyEnd;
  }

  batchCalls() {
    return this.calls.filter((c): c is Extract<typeof c, { kind: 'batch' }> => c.kind === 'batch');
  }

  getCalls() {
    return this.calls.filter((c) => c.kind === 'get');
  }

  private applyInserts(requests: docs_v1.Schema$Request[]) {
    // Validate indices like the real API would, then grow the body.
    for (const req of requests) {
      if (req.insertText) {
        const idx = req.insertText.location?.index ?? 0;
        if (idx > this.bodyEnd - 1) {
          throw new Error(
            `Invalid insertText: Index ${idx} must be less than the end index of the referenced segment, ${this.bodyEnd}.`,
          );
        }
        this.bodyEnd += (req.insertText.text ?? '').length;
      } else if (req.insertTable) {
        const idx = req.insertTable.location?.index ?? 0;
        if (idx > this.bodyEnd - 1) {
          throw new Error(
            `Invalid insertTable: Index ${idx} must be less than the end index of the referenced segment, ${this.bodyEnd}.`,
          );
        }
        const rows = req.insertTable.rows ?? 0;
        const cols = req.insertTable.columns ?? 0;
        // Table structural growth; not exact but sufficient for our test.
        this.bodyEnd += 2 + rows + 2 * rows * cols;
      } else if (req.deleteContentRange?.range) {
        const start = req.deleteContentRange.range.startIndex ?? 0;
        const end = req.deleteContentRange.range.endIndex ?? 0;
        this.bodyEnd -= Math.max(0, end - start);
      }
    }
  }

  private makeDoc(): docs_v1.Schema$Document {
    return {
      body: {
        content: [
          { startIndex: 0, endIndex: 1, sectionBreak: {} },
          {
            startIndex: 1,
            endIndex: this.bodyEnd,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: this.bodyEnd,
                  textRun: { content: 'x'.repeat(this.bodyEnd - 1) },
                },
              ],
            },
          },
        ],
      },
    };
  }
}

function makeClient(fakeApi: FakeDocsApi): CodocsClient {
  // authClient: {} short-circuits real OAuth in createAuth().
  const client = new CodocsClient({ authClient: {} as never });
  // DocsApi is private; swap it for the fake to intercept Docs calls.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).docsApi = fakeApi;
  return client;
}

describe('CodocsClient.applyDocDiff', () => {
  it('re-fetches the doc before each new-section insert', async () => {
    const fake = new FakeDocsApi(50);
    const client = makeClient(fake);

    const diff: DiffResult = {
      hasChanges: true,
      requests: [],
      conflictsResolved: 0,
      headingLinks: [],
      newSectionInserts: [
        { content: '# First\n\nAlpha.\n', agentName: 'agent' },
        { content: '# Second\n\nBeta.\n', agentName: 'agent' },
        { content: '# Third\n\nGamma.\n', agentName: 'agent' },
      ],
    };

    await client.applyDocDiff('doc-1', diff);

    // One getDocument per new section (no initial batch, no heading links).
    expect(fake.getCalls()).toHaveLength(3);

    // One batchUpdate per new section.
    const batches = fake.batchCalls();
    expect(batches).toHaveLength(3);
  });

  it('anchors each new section at the current bodyEnd-1, not the original', async () => {
    const fake = new FakeDocsApi(50);
    const client = makeClient(fake);

    const diff: DiffResult = {
      hasChanges: true,
      requests: [],
      conflictsResolved: 0,
      headingLinks: [],
      newSectionInserts: [
        { content: '# First\n\nAlpha.\n', agentName: 'agent' },
        { content: '# Second\n\nBeta.\n', agentName: 'agent' },
      ],
    };

    await client.applyDocDiff('doc-1', diff);

    const batches = fake.batchCalls();
    const firstInsert = batches[0].requests.find((r) => r.insertText)!;
    const secondInsert = batches[1].requests.find((r) => r.insertText)!;

    // First section anchors at bodyEnd-1 of the initial doc.
    expect(firstInsert.insertText!.location!.index).toBe(49);

    // After batch 1, the fake grew the body. The second anchor must reflect
    // the new end, NOT 49 (the original end - 1).
    expect(secondInsert.insertText!.location!.index).toBeGreaterThan(49);
    expect(secondInsert.insertText!.location!.index).toBe(batches[1].bodyEndAtCall - 1);
  });

  it('does not throw the past-end-of-segment error the old code hit', async () => {
    // Regression test for:
    //   "Index 30443 must be less than the end index of the referenced
    //    segment, 28715"
    // caused by stacking multiple new-section inserts into one batch.
    const fake = new FakeDocsApi(28715);
    const client = makeClient(fake);

    // Build several sections of sizable content — the first one alone
    // grows the body past the original bodyEnd, so if the second were
    // anchored at 28714 the fake (like the real API) would reject it
    // for pointing beyond the INITIAL segment end. Here the re-fetch
    // in applyDocDiff keeps anchors fresh.
    const paragraph = 'Paragraph body. '.repeat(120);
    const diff: DiffResult = {
      hasChanges: true,
      requests: [],
      conflictsResolved: 0,
      headingLinks: [],
      newSectionInserts: Array.from({ length: 4 }).map((_, i) => ({
        content: `# Section ${i}\n\n${paragraph}\n`,
        agentName: 'agent',
      })),
    };

    await expect(client.applyDocDiff('doc-1', diff)).resolves.not.toThrow();
    expect(fake.batchCalls()).toHaveLength(4);
  });

  it('applies the initial requests batch before any new-section inserts', async () => {
    const fake = new FakeDocsApi(100);
    const client = makeClient(fake);

    const initialRequest: docs_v1.Schema$Request = {
      deleteContentRange: { range: { startIndex: 10, endIndex: 20 } },
    };

    const diff: DiffResult = {
      hasChanges: true,
      requests: [initialRequest],
      conflictsResolved: 0,
      headingLinks: [],
      newSectionInserts: [{ content: '# New\n\nBody.\n', agentName: 'agent' }],
    };

    await client.applyDocDiff('doc-1', diff);

    const batches = fake.batchCalls();
    expect(batches.length).toBeGreaterThanOrEqual(2);
    // First batch is the initial modifications; no getDocument precedes it.
    expect(batches[0].requests[0]).toBe(initialRequest);
    const firstGetIndex = fake.calls.findIndex((c) => c.kind === 'get');
    const firstBatchIndex = fake.calls.findIndex((c) => c.kind === 'batch');
    expect(firstBatchIndex).toBeLessThan(firstGetIndex);
  });

  it('is a no-op when nothing changed', async () => {
    const fake = new FakeDocsApi(50);
    const client = makeClient(fake);

    const diff: DiffResult = {
      hasChanges: false,
      requests: [],
      conflictsResolved: 0,
      headingLinks: [],
      newSectionInserts: [],
    };

    await client.applyDocDiff('doc-1', diff);
    expect(fake.calls).toHaveLength(0);
  });

  it('resolves heading links after all section batches', async () => {
    const fake = new FakeDocsApi(50);
    const client = makeClient(fake);

    const diff: DiffResult = {
      hasChanges: true,
      requests: [],
      conflictsResolved: 0,
      headingLinks: [
        { startIndex: 10, endIndex: 14, target: { kind: 'slug', value: 'missing' } },
      ],
      newSectionInserts: [],
    };

    await client.applyDocDiff('doc-1', diff);

    // With only headingLinks and nothing else: resolveHeadingLinks reads
    // the doc once to look up heading IDs; unresolved links produce no
    // follow-up batchUpdate.
    expect(fake.getCalls()).toHaveLength(1);
    expect(fake.batchCalls()).toHaveLength(0);
  });
});
