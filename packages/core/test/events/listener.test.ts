import { describe, it, expect } from 'vitest';

// We can't import the private functions directly, so we test them
// through a thin re-export. For now, extract and test the pure logic inline.

// ── extractMentions ──────────────────────────────────────────────

function extractMentions(content: string): string[] {
  const matches = content.match(/[+@]([\w.+-]+@[\w.-]+\.\w+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

describe('extractMentions', () => {
  it('returns empty for text without mentions', () => {
    expect(extractMentions('Hello world')).toEqual([]);
  });

  it('extracts @-style mentions', () => {
    expect(extractMentions('Hey @alice@example.com check this')).toEqual([
      'alice@example.com',
    ]);
  });

  it('extracts +-style mentions', () => {
    expect(extractMentions('cc +bob@corp.co')).toEqual(['bob@corp.co']);
  });

  it('extracts multiple mentions', () => {
    const result = extractMentions(
      '@alice@example.com please review with +bob@corp.co',
    );
    expect(result).toEqual(['alice@example.com', 'bob@corp.co']);
  });

  it('handles mentions with dots and hyphens in local part', () => {
    expect(extractMentions('+first.last-name@sub.domain.org')).toEqual([
      'first.last-name@sub.domain.org',
    ]);
  });

  it('returns empty for @ without a valid email', () => {
    expect(extractMentions('email me @ sometime')).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(extractMentions('')).toEqual([]);
  });
});

// ── extractDocumentId ────────────────────────────────────────────

function extractDocumentId(
  attributes: Record<string, string>,
  payload: Record<string, any>,
): string {
  // ce-subject format: googleapis.com/drive/v3/files/DOC_ID
  const subject = attributes['ce-subject'] ?? '';
  const subjectMatch = subject.match(/\/files\/([a-zA-Z0-9_-]+)/);
  if (subjectMatch) return subjectMatch[1];

  // Fallback: payload.comment.fileId
  if (payload?.comment?.fileId) return payload.comment.fileId;

  // Last resort: try ce-source (older format)
  const source = attributes['ce-source'] ?? '';
  const sourceMatch = source.match(/\/documents\/(.+)$/);
  if (sourceMatch) return sourceMatch[1];

  return '';
}

describe('extractDocumentId', () => {
  it('extracts from ce-subject (primary path)', () => {
    const attrs = {
      'ce-subject':
        'googleapis.com/drive/v3/files/1DkgMuvq1aFDI3Hyo1gyJT1fmRfa7TE81jD4lFPMZXM4',
    };
    expect(extractDocumentId(attrs, {})).toBe(
      '1DkgMuvq1aFDI3Hyo1gyJT1fmRfa7TE81jD4lFPMZXM4',
    );
  });

  it('falls back to payload.comment.fileId', () => {
    expect(
      extractDocumentId({}, { comment: { fileId: 'abc123' } }),
    ).toBe('abc123');
  });

  it('falls back to ce-source documents path', () => {
    const attrs = {
      'ce-source': '//docs.googleapis.com/documents/xyz789',
    };
    expect(extractDocumentId(attrs, {})).toBe('xyz789');
  });

  it('prefers ce-subject over payload', () => {
    const attrs = {
      'ce-subject': 'googleapis.com/drive/v3/files/from-subject',
    };
    expect(
      extractDocumentId(attrs, { comment: { fileId: 'from-payload' } }),
    ).toBe('from-subject');
  });

  it('returns empty when nothing matches', () => {
    expect(extractDocumentId({}, {})).toBe('');
  });
});

// ── parseEventStub ───────────────────────────────────────────────

// Minimal mock of a Pub/Sub message for testing
function makeMockMessage(
  attributes: Record<string, string>,
  data: Record<string, any>,
) {
  return {
    attributes,
    data: Buffer.from(JSON.stringify(data)),
  };
}

function parseEventStub(message: {
  attributes: Record<string, string>;
  data: Buffer;
}): {
  eventType: string;
  documentId: string;
  commentId: string;
  eventTime: string;
} | null {
  const eventType =
    message.attributes?.['ce-type'] ??
    message.attributes?.['event_type'] ??
    '';
  const eventTime =
    message.attributes?.['ce-time'] ??
    message.attributes?.['event_time'] ??
    '';

  if (!eventType.includes('comment')) {
    return null;
  }

  let payload: Record<string, any> = {};
  try {
    const raw = message.data.toString('utf-8');
    if (raw) payload = JSON.parse(raw);
  } catch {
    // continue
  }

  const subject = message.attributes?.['ce-subject'] ?? '';
  const subjectMatch = subject.match(/\/files\/([a-zA-Z0-9_-]+)/);
  const documentId = subjectMatch?.[1] ?? payload?.comment?.fileId ?? '';
  const commentId = payload?.comment?.id ?? '';

  if (!documentId || !commentId) {
    return null;
  }

  return { eventType, documentId, commentId, eventTime };
}

describe('parseEventStub', () => {
  it('parses a valid comment event', () => {
    const msg = makeMockMessage(
      {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-time': '2026-04-09T01:37:04.009Z',
        'ce-subject':
          'googleapis.com/drive/v3/files/doc123',
      },
      { comment: { id: 'comment-abc', fileId: 'doc123' } },
    );
    const result = parseEventStub(msg);
    expect(result).toEqual({
      eventType: 'google.workspace.drive.comment.v3.created',
      documentId: 'doc123',
      commentId: 'comment-abc',
      eventTime: '2026-04-09T01:37:04.009Z',
    });
  });

  it('returns null for non-comment events', () => {
    const msg = makeMockMessage(
      { 'ce-type': 'google.workspace.drive.file.v3.updated' },
      {},
    );
    expect(parseEventStub(msg)).toBeNull();
  });

  it('returns null when missing comment ID', () => {
    const msg = makeMockMessage(
      {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc123',
      },
      { comment: { fileId: 'doc123' } }, // no id
    );
    expect(parseEventStub(msg)).toBeNull();
  });

  it('returns null when missing document ID', () => {
    const msg = makeMockMessage(
      { 'ce-type': 'google.workspace.drive.comment.v3.created' },
      { comment: { id: 'c1' } }, // no fileId, no ce-subject
    );
    expect(parseEventStub(msg)).toBeNull();
  });

  it('handles malformed JSON data gracefully', () => {
    const msg = {
      attributes: {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc123',
      },
      data: Buffer.from('not json'),
    };
    // No fileId in payload and no comment id → null
    expect(parseEventStub(msg)).toBeNull();
  });

  it('uses event_type attribute as fallback', () => {
    const msg = makeMockMessage(
      {
        event_type: 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc456',
      },
      { comment: { id: 'c2', fileId: 'doc456' } },
    );
    const result = parseEventStub(msg);
    expect(result).not.toBeNull();
    expect(result!.documentId).toBe('doc456');
  });
});
