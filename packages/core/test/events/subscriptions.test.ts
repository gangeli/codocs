import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSubscriptionsList = vi.fn();
const mockSubscriptionsCreate = vi.fn();
const mockSubscriptionsDelete = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    workspaceevents: () => ({
      subscriptions: {
        list: mockSubscriptionsList,
        create: mockSubscriptionsCreate,
        delete: mockSubscriptionsDelete,
      },
    }),
  },
}));

import {
  extractSubscriptionFromResponse,
  ensureSubscription,
} from '../../src/events/subscriptions.js';

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

describe('ensureSubscription', () => {
  const auth = {} as unknown;
  const docId = 'doc-ensure-1';
  const pubsubTopic = 'projects/p/topics/t';
  const requiredEventTypes = [
    'google.workspace.drive.comment.v3.created',
    'google.workspace.drive.reply.v3.created',
  ];

  beforeEach(() => {
    mockSubscriptionsList.mockReset();
    mockSubscriptionsCreate.mockReset();
    mockSubscriptionsDelete.mockReset();
  });

  it('reuses an existing subscription with all event types', async () => {
    mockSubscriptionsList.mockResolvedValue({
      data: {
        subscriptions: [
          {
            name: 'subscriptions/valid-one',
            targetResource: `//drive.googleapis.com/files/${docId}`,
            eventTypes: requiredEventTypes,
            expireTime: new Date(Date.now() + 86400_000).toISOString(),
          },
        ],
      },
    });

    const result = await ensureSubscription(auth, docId, pubsubTopic);

    expect(result.name).toBe('subscriptions/valid-one');
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsDelete).not.toHaveBeenCalled();
  });

  it('deletes expired subscription and creates a new one', async () => {
    mockSubscriptionsList.mockResolvedValue({
      data: {
        subscriptions: [
          {
            name: 'subscriptions/expired',
            targetResource: `//drive.googleapis.com/files/${docId}`,
            eventTypes: requiredEventTypes,
            expireTime: new Date(Date.now() - 86400_000).toISOString(),
          },
        ],
      },
    });
    mockSubscriptionsDelete.mockResolvedValue({});
    mockSubscriptionsCreate.mockResolvedValue({
      data: {
        done: true,
        response: {
          name: 'subscriptions/fresh',
          targetResource: `//drive.googleapis.com/files/${docId}`,
          eventTypes: requiredEventTypes,
          expireTime: new Date(Date.now() + 7 * 86400_000).toISOString(),
        },
      },
    });

    const result = await ensureSubscription(auth, docId, pubsubTopic);

    expect(mockSubscriptionsDelete).toHaveBeenCalledWith({
      name: 'subscriptions/expired',
    });
    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(result.name).toBe('subscriptions/fresh');
  });

  it('deletes subscription with missing event types and recreates', async () => {
    mockSubscriptionsList.mockResolvedValue({
      data: {
        subscriptions: [
          {
            name: 'subscriptions/partial',
            targetResource: `//drive.googleapis.com/files/${docId}`,
            eventTypes: ['google.workspace.drive.comment.v3.created'],
            expireTime: new Date(Date.now() + 86400_000).toISOString(),
          },
        ],
      },
    });
    mockSubscriptionsDelete.mockResolvedValue({});
    mockSubscriptionsCreate.mockResolvedValue({
      data: {
        done: true,
        response: {
          name: 'subscriptions/full',
          targetResource: `//drive.googleapis.com/files/${docId}`,
          eventTypes: requiredEventTypes,
          expireTime: new Date(Date.now() + 7 * 86400_000).toISOString(),
        },
      },
    });

    const result = await ensureSubscription(auth, docId, pubsubTopic);

    expect(mockSubscriptionsDelete).toHaveBeenCalledWith({
      name: 'subscriptions/partial',
    });
    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(result.name).toBe('subscriptions/full');
  });

  it('creates a new subscription when none exists', async () => {
    mockSubscriptionsList.mockResolvedValue({
      data: { subscriptions: [] },
    });
    mockSubscriptionsCreate.mockResolvedValue({
      data: {
        done: true,
        response: {
          name: 'subscriptions/brand-new',
          targetResource: `//drive.googleapis.com/files/${docId}`,
          eventTypes: requiredEventTypes,
          expireTime: new Date(Date.now() + 7 * 86400_000).toISOString(),
        },
      },
    });

    const result = await ensureSubscription(auth, docId, pubsubTopic);

    expect(mockSubscriptionsDelete).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(result.name).toBe('subscriptions/brand-new');
  });
});
