import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { docs_v1 } from 'googleapis';
import {
  createAttributionRequests,
  extractAttributions,
  deleteNamedRangeRequest,
} from '../../src/attribution/named-ranges.js';

function loadFixture(name: string) {
  const path = new URL(`../fixtures/${name}`, import.meta.url).pathname;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('createAttributionRequests', () => {
  it('creates a named range request', () => {
    const reqs = createAttributionRequests('planner', 1, 50);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toEqual({
      createNamedRange: {
        name: 'agent:planner',
        range: { startIndex: 1, endIndex: 50 },
      },
    });
  });

  it('adds color request when color is provided with full shape', () => {
    const reqs = createAttributionRequests('coder', 10, 30, {
      red: 0.2,
      green: 0.5,
      blue: 0.9,
    });
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toEqual({
      createNamedRange: {
        name: 'agent:coder',
        range: { startIndex: 10, endIndex: 30 },
      },
    });
    expect(reqs[1]).toEqual({
      updateTextStyle: {
        range: { startIndex: 10, endIndex: 30 },
        textStyle: {
          foregroundColor: {
            color: {
              rgbColor: { red: 0.2, green: 0.5, blue: 0.9 },
            },
          },
        },
        fields: 'foregroundColor',
      },
    });
    expect(reqs[1].updateTextStyle!.fields).toBe('foregroundColor');
  });

  it('handles zero-width range (startIndex === endIndex)', () => {
    const reqs = createAttributionRequests('planner', 10, 10, {
      red: 1,
      green: 0,
      blue: 0,
    });
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toEqual({
      createNamedRange: {
        name: 'agent:planner',
        range: { startIndex: 10, endIndex: 10 },
      },
    });
    expect(reqs[1]).toEqual({
      updateTextStyle: {
        range: { startIndex: 10, endIndex: 10 },
        textStyle: {
          foregroundColor: {
            color: {
              rgbColor: { red: 1, green: 0, blue: 0 },
            },
          },
        },
        fields: 'foregroundColor',
      },
    });
  });
});

describe('extractAttributions', () => {
  it('extracts attributions from a document with named ranges with exact text', () => {
    const doc = loadFixture('attributed-doc.json');
    const spans = extractAttributions(doc);

    expect(spans).toHaveLength(2);

    const planner = spans.find((s) => s.agentName === 'planner');
    expect(planner).toBeDefined();
    expect(planner!.text).toBe("Planner's section\nThis was written by planner.\n");
    expect(planner!.namedRangeId).toBe('nr-1');
    expect(planner!.ranges).toEqual([{ startIndex: 1, endIndex: 50 }]);

    const coder = spans.find((s) => s.agentName === 'coder');
    expect(coder).toBeDefined();
    expect(coder!.text).toBe("Coder's section\nThis was written by coder.\n");
    expect(coder!.namedRangeId).toBe('nr-2');
    expect(coder!.ranges).toEqual([{ startIndex: 50, endIndex: 98 }]);
  });

  it('returns empty array for document without named ranges', () => {
    const doc = loadFixture('simple-doc.json');
    const spans = extractAttributions(doc);
    expect(spans).toHaveLength(0);
  });

  it('zero-width range yields empty text (overlap uses strict <)', () => {
    const doc: docs_v1.Schema$Document = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 20,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: 20,
                  textRun: { content: 'Some content here\n' },
                },
              ],
            },
          },
        ],
      },
      namedRanges: {
        'agent:planner': {
          namedRanges: [
            {
              namedRangeId: 'nr-zero',
              name: 'agent:planner',
              ranges: [{ startIndex: 10, endIndex: 10 }],
            },
          ],
        },
      },
    };
    const spans = extractAttributions(doc);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('');
    expect(spans[0].ranges).toEqual([{ startIndex: 10, endIndex: 10 }]);
  });

  it('handles a namedRange with multiple ranges (plural)', () => {
    const doc: docs_v1.Schema$Document = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 11,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: 11,
                  textRun: { content: 'Hello ABC\n' },
                },
              ],
            },
          },
          {
            startIndex: 11,
            endIndex: 21,
            paragraph: {
              elements: [
                {
                  startIndex: 11,
                  endIndex: 21,
                  textRun: { content: 'World XYZ\n' },
                },
              ],
            },
          },
        ],
      },
      namedRanges: {
        'agent:planner': {
          namedRanges: [
            {
              namedRangeId: 'nr-multi',
              name: 'agent:planner',
              ranges: [
                { startIndex: 1, endIndex: 6 },
                { startIndex: 11, endIndex: 16 },
              ],
            },
          ],
        },
      },
    };
    const spans = extractAttributions(doc);
    expect(spans).toHaveLength(1);
    expect(spans[0].ranges).toEqual([
      { startIndex: 1, endIndex: 6 },
      { startIndex: 11, endIndex: 16 },
    ]);
    expect(spans[0].text).toBe('HelloWorld');
  });

  it('extracts overlapping ranges from two agents', () => {
    const text60 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567';
    const doc: docs_v1.Schema$Document = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 61,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: 61,
                  textRun: {
                    content: text60,
                  },
                },
              ],
            },
          },
        ],
      },
      namedRanges: {
        'agent:planner': {
          namedRanges: [
            {
              namedRangeId: 'nr-planner',
              name: 'agent:planner',
              ranges: [{ startIndex: 1, endIndex: 50 }],
            },
          ],
        },
        'agent:coder': {
          namedRanges: [
            {
              namedRangeId: 'nr-coder',
              name: 'agent:coder',
              ranges: [{ startIndex: 40, endIndex: 60 }],
            },
          ],
        },
      },
    };
    const spans = extractAttributions(doc);
    expect(spans).toHaveLength(2);
    const planner = spans.find((s) => s.agentName === 'planner')!;
    const coder = spans.find((s) => s.agentName === 'coder')!;

    // planner overlap: doc 1..50 → slice [0..49]
    expect(planner.text).toBe(text60.slice(0, 49));
    // coder overlap: doc 40..60 → slice [39..59]
    expect(coder.text).toBe(text60.slice(39, 59));
    // Verify overlap: planner contains positions 40..49, coder contains 40..49
    expect(planner.text.slice(39, 49)).toBe(coder.text.slice(0, 10));
  });

  it('excludes named ranges not starting with agent:', () => {
    const doc: docs_v1.Schema$Document = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 11,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: 11,
                  textRun: { content: 'some code\n' },
                },
              ],
            },
          },
        ],
      },
      namedRanges: {
        'codelang:js': {
          namedRanges: [
            {
              namedRangeId: 'nr-lang',
              name: 'codelang:js',
              ranges: [{ startIndex: 1, endIndex: 11 }],
            },
          ],
        },
        'agent:planner': {
          namedRanges: [
            {
              namedRangeId: 'nr-planner',
              name: 'agent:planner',
              ranges: [{ startIndex: 1, endIndex: 11 }],
            },
          ],
        },
      },
    };
    const spans = extractAttributions(doc);
    expect(spans).toHaveLength(1);
    expect(spans[0].agentName).toBe('planner');
  });

  it('coerces missing startIndex/endIndex to 0 without crashing', () => {
    const doc: docs_v1.Schema$Document = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 11,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: 11,
                  textRun: { content: 'some text\n' },
                },
              ],
            },
          },
        ],
      },
      namedRanges: {
        'agent:planner': {
          namedRanges: [
            {
              namedRangeId: 'nr-undef',
              name: 'agent:planner',
              ranges: [{}],
            },
          ],
        },
      },
    };
    const spans = extractAttributions(doc);
    expect(spans).toHaveLength(1);
    expect(spans[0].ranges).toEqual([{ startIndex: 0, endIndex: 0 }]);
    expect(spans[0].text).toBe('');
  });
});

describe('deleteNamedRangeRequest', () => {
  it('creates a delete request', () => {
    const req = deleteNamedRangeRequest('nr-1');
    expect(req).toEqual({ deleteNamedRange: { namedRangeId: 'nr-1' } });
  });
});
