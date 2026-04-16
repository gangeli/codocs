import { describe, it, expect } from 'vitest';
import { injectTabId } from '../../src/client/docs-api.js';

describe('injectTabId', () => {
  it('injects tabId into insertText location', () => {
    const requests = [{
      insertText: {
        text: 'Hello',
        location: { index: 1 },
      },
    }];

    const result = injectTabId(requests, 'tab-123');
    expect((result[0].insertText!.location as any).tabId).toBe('tab-123');
  });

  it('injects tabId into deleteContentRange', () => {
    const requests = [{
      deleteContentRange: {
        range: { startIndex: 1, endIndex: 10 },
      },
    }];

    const result = injectTabId(requests, 'tab-123');
    expect((result[0].deleteContentRange!.range as any).tabId).toBe('tab-123');
  });

  it('injects tabId into createParagraphBullets range', () => {
    const requests = [{
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 5 },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' as any,
      },
    }];

    const result = injectTabId(requests, 'tab-123');
    expect((result[0].createParagraphBullets!.range as any).tabId).toBe('tab-123');
  });

  it('does not modify the original requests', () => {
    const requests = [{
      insertText: {
        text: 'Hello',
        location: { index: 1 },
      },
    }];

    injectTabId(requests, 'tab-123');
    expect((requests[0].insertText!.location as any).tabId).toBeUndefined();
  });

  it('handles requests with no location/range', () => {
    const requests = [{
      updateDocumentStyle: {
        documentStyle: { pageSize: { width: { magnitude: 612, unit: 'PT' } } },
        fields: 'pageSize',
      },
    }];

    const result = injectTabId(requests, 'tab-123');
    expect(result).toHaveLength(1);
    // Should not crash
  });

  it('handles multiple requests', () => {
    const requests = [
      { insertText: { text: 'A', location: { index: 1 } } },
      { insertText: { text: 'B', location: { index: 5 } } },
      { deleteContentRange: { range: { startIndex: 10, endIndex: 20 } } },
    ];

    const result = injectTabId(requests, 'tab-xyz');
    expect((result[0].insertText!.location as any).tabId).toBe('tab-xyz');
    expect((result[1].insertText!.location as any).tabId).toBe('tab-xyz');
    expect((result[2].deleteContentRange!.range as any).tabId).toBe('tab-xyz');
  });
});
