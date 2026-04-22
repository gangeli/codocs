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
    expect(JSON.stringify(result).includes('tabId')).toBe(false);
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

  it('injects tabId into nested range inside updateTextStyle', () => {
    const requests = [{
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 10 },
        textStyle: { bold: true },
        fields: 'bold',
      },
    }];

    const result = injectTabId(requests, 'tab-123');
    expect((result[0].updateTextStyle!.range as any).tabId).toBe('tab-123');
  });

  it('does NOT inject tabId when index is not a number', () => {
    const requests = [{
      insertText: {
        text: 'Hello',
        location: { index: 'not-a-number' as any },
      },
    }];

    const result = injectTabId(requests, 'tab-123');
    expect((result[0].insertText!.location as any).tabId).toBeUndefined();
  });

  it('deep-clone invariant: original requests untouched (structuredClone snapshot)', () => {
    const requests = [
      { insertText: { text: 'A', location: { index: 1 } } },
      { deleteContentRange: { range: { startIndex: 10, endIndex: 20 } } },
      {
        updateTextStyle: {
          range: { startIndex: 5, endIndex: 8 },
          textStyle: { bold: true },
          fields: 'bold',
        },
      },
    ];
    const snapshot = structuredClone(requests);

    injectTabId(requests, 'tab-xyz');

    expect(requests).toEqual(snapshot);
  });

  it('does NOT inject tabId when object has startIndex but no endIndex', () => {
    const requests = [{
      foo: { startIndex: 5 },
    } as any];

    const result = injectTabId(requests, 'tab-123') as any[];
    expect(result[0].foo.tabId).toBeUndefined();
  });

  it('injects tabId into multiple range-bearing fields within one request', () => {
    const requests = [{
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 10 },
        paragraphStyle: { namedStyleType: 'HEADING_1' },
        fields: 'namedStyleType',
      },
    } as any, {
      deleteContentRange: {
        range: { startIndex: 20, endIndex: 30 },
      },
    }];

    const result = injectTabId(requests, 'tab-multi') as any[];
    expect(result[0].updateParagraphStyle.range.tabId).toBe('tab-multi');
    expect(result[1].deleteContentRange.range.tabId).toBe('tab-multi');
  });
});
