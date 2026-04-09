import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
    expect(reqs[0].createNamedRange).toBeDefined();
    expect(reqs[0].createNamedRange!.name).toBe('agent:planner');
    expect(reqs[0].createNamedRange!.range!.startIndex).toBe(1);
    expect(reqs[0].createNamedRange!.range!.endIndex).toBe(50);
  });

  it('adds color request when color is provided', () => {
    const reqs = createAttributionRequests('coder', 10, 30, {
      red: 0.2,
      green: 0.5,
      blue: 0.9,
    });
    expect(reqs).toHaveLength(2);
    expect(reqs[1].updateTextStyle).toBeDefined();
    expect(
      reqs[1].updateTextStyle!.textStyle!.foregroundColor!.color!.rgbColor!.red,
    ).toBe(0.2);
  });
});

describe('extractAttributions', () => {
  it('extracts attributions from a document with named ranges', () => {
    const doc = loadFixture('attributed-doc.json');
    const spans = extractAttributions(doc);

    expect(spans).toHaveLength(2);

    const planner = spans.find((s) => s.agentName === 'planner');
    expect(planner).toBeDefined();
    expect(planner!.text).toContain("Planner's section");
    expect(planner!.text).toContain('written by planner');
    expect(planner!.ranges[0].startIndex).toBe(1);
    expect(planner!.ranges[0].endIndex).toBe(50);

    const coder = spans.find((s) => s.agentName === 'coder');
    expect(coder).toBeDefined();
    expect(coder!.text).toContain("Coder's section");
    expect(coder!.text).toContain('written by coder');
  });

  it('returns empty array for document without named ranges', () => {
    const doc = loadFixture('simple-doc.json');
    const spans = extractAttributions(doc);
    expect(spans).toHaveLength(0);
  });
});

describe('deleteNamedRangeRequest', () => {
  it('creates a delete request', () => {
    const req = deleteNamedRangeRequest('nr-1');
    expect(req.deleteNamedRange).toBeDefined();
    expect(req.deleteNamedRange!.namedRangeId).toBe('nr-1');
  });
});
