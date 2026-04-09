import { describe, it, expect } from 'vitest';

// Test the pure extraction function logic from subscriptions.ts

function extractSubscriptionFromResponse(data: Record<string, any>): {
  name: string;
  targetResource: string;
  eventTypes: string[];
  expireTime: string;
} {
  const name = data.name ?? '';
  if (!name || name.startsWith('operations/')) {
    throw new Error(`Invalid subscription name: ${name}`);
  }
  return {
    name,
    targetResource: data.targetResource ?? '',
    eventTypes: (data.eventTypes ?? []) as string[],
    expireTime: data.expireTime ?? '',
  };
}

describe('extractSubscriptionFromResponse', () => {
  it('extracts a valid subscription response', () => {
    const result = extractSubscriptionFromResponse({
      name: 'subscriptions/drive-file-abc123',
      targetResource: '//drive.googleapis.com/files/doc1',
      eventTypes: ['google.workspace.drive.comment.v3.created'],
      expireTime: '2026-04-09T05:32:10.704176Z',
    });
    expect(result.name).toBe('subscriptions/drive-file-abc123');
    expect(result.targetResource).toBe('//drive.googleapis.com/files/doc1');
    expect(result.eventTypes).toEqual([
      'google.workspace.drive.comment.v3.created',
    ]);
    expect(result.expireTime).toBe('2026-04-09T05:32:10.704176Z');
  });

  it('throws for operation names (not yet resolved)', () => {
    expect(() =>
      extractSubscriptionFromResponse({ name: 'operations/abc123' }),
    ).toThrow('Invalid subscription name');
  });

  it('throws for missing name', () => {
    expect(() => extractSubscriptionFromResponse({})).toThrow(
      'Invalid subscription name',
    );
  });

  it('throws for empty name', () => {
    expect(() =>
      extractSubscriptionFromResponse({ name: '' }),
    ).toThrow('Invalid subscription name');
  });

  it('handles missing optional fields', () => {
    const result = extractSubscriptionFromResponse({
      name: 'subscriptions/test',
    });
    expect(result.targetResource).toBe('');
    expect(result.eventTypes).toEqual([]);
    expect(result.expireTime).toBe('');
  });
});
