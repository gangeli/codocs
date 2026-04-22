import { describe, it, expect } from 'vitest';
import type { Message } from '@google-cloud/pubsub';
import {
  extractMentions,
  extractDocumentId,
  parseEventStub,
} from '../../src/events/listener.js';

function makeMessage(
  attributes: Record<string, string>,
  data: Buffer | Record<string, any>,
): Message {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  return {
    attributes,
    data: buffer,
  } as unknown as Message;
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

  it('returns duplicates when the same mention appears twice (no dedupe)', () => {
    expect(
      extractMentions('@alice@example.com then +alice@example.com again'),
    ).toEqual(['alice@example.com', 'alice@example.com']);
  });
});

describe('extractDocumentId', () => {
  it('extracts from ce-subject (primary path)', () => {
    const msg = makeMessage(
      {
        'ce-subject':
          'googleapis.com/drive/v3/files/1DkgMuvq1aFDI3Hyo1gyJT1fmRfa7TE81jD4lFPMZXM4',
      },
      {},
    );
    expect(extractDocumentId(msg, {})).toBe(
      '1DkgMuvq1aFDI3Hyo1gyJT1fmRfa7TE81jD4lFPMZXM4',
    );
  });

  it('falls back to payload.comment.fileId', () => {
    const msg = makeMessage({}, {});
    expect(extractDocumentId(msg, { comment: { fileId: 'abc123' } })).toBe(
      'abc123',
    );
  });

  it('falls back to ce-source documents path', () => {
    const msg = makeMessage(
      { 'ce-source': '//docs.googleapis.com/documents/xyz789' },
      {},
    );
    expect(extractDocumentId(msg, {})).toBe('xyz789');
  });

  it('prefers ce-subject over payload', () => {
    const msg = makeMessage(
      { 'ce-subject': 'googleapis.com/drive/v3/files/from-subject' },
      {},
    );
    expect(
      extractDocumentId(msg, { comment: { fileId: 'from-payload' } }),
    ).toBe('from-subject');
  });

  it('returns empty when nothing matches', () => {
    const msg = makeMessage({}, {});
    expect(extractDocumentId(msg, {})).toBe('');
  });
});

describe('parseEventStub', () => {
  it('parses a valid comment event', () => {
    const msg = makeMessage(
      {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-time': '2026-04-09T01:37:04.009Z',
        'ce-subject': 'googleapis.com/drive/v3/files/doc123',
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

  it('parses a reply event with commentId from payload.reply.commentId', () => {
    const msg = makeMessage(
      {
        'ce-type': 'google.workspace.drive.reply.v3.created',
        'ce-time': '2026-04-09T02:00:00.000Z',
        'ce-subject': 'googleapis.com/drive/v3/files/doc-reply',
      },
      { reply: { commentId: 'parent-comment-99' } },
    );
    const result = parseEventStub(msg);
    expect(result).toEqual({
      eventType: 'google.workspace.drive.reply.v3.created',
      documentId: 'doc-reply',
      commentId: 'parent-comment-99',
      eventTime: '2026-04-09T02:00:00.000Z',
    });
  });

  it('accepts comment events with missing commentId (returns empty string)', () => {
    const msg = makeMessage(
      {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc123',
      },
      { comment: { fileId: 'doc123' } },
    );
    const result = parseEventStub(msg);
    expect(result).not.toBeNull();
    expect(result!.documentId).toBe('doc123');
    expect(result!.commentId).toBe('');
  });

  it('returns null for non-comment, non-reply events', () => {
    const msg = makeMessage(
      { 'ce-type': 'google.workspace.drive.file.v3.updated' },
      {},
    );
    expect(parseEventStub(msg)).toBeNull();
  });

  it('returns null when missing document ID', () => {
    const msg = makeMessage(
      { 'ce-type': 'google.workspace.drive.comment.v3.created' },
      { comment: { id: 'c1' } },
    );
    expect(parseEventStub(msg)).toBeNull();
  });

  it('handles malformed JSON data gracefully', () => {
    const msg = makeMessage(
      {
        'ce-type': 'google.workspace.drive.comment.v3.created',
        'ce-subject': 'googleapis.com/drive/v3/files/doc123',
      },
      Buffer.from('not json'),
    );
    const result = parseEventStub(msg);
    expect(result).not.toBeNull();
    expect(result!.documentId).toBe('doc123');
    expect(result!.commentId).toBe('');
  });

  it('uses event_type attribute as fallback', () => {
    const msg = makeMessage(
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
