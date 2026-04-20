import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { buildHeadingIdMap, resolveHeadingLinkRequests } from '../../src/converter/heading-links.js';
import { slugifyHeading, extractSectionNumber, findSectionReferences } from '../../src/converter/heading-slug.js';

function heading(text: string, headingId: string): docs_v1.Schema$StructuralElement {
  return {
    startIndex: 1,
    endIndex: text.length + 2,
    paragraph: {
      paragraphStyle: { namedStyleType: 'HEADING_2', headingId },
      elements: [{ textRun: { content: text + '\n' } }],
    },
  };
}

describe('slugifyHeading', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world');
  });

  it('drops punctuation and collapses spaces', () => {
    expect(slugifyHeading('3. Features & user journeys')).toBe('3-features--user-journeys');
  });

  it('handles unicode letters', () => {
    expect(slugifyHeading('Café résumé')).toBe('café-résumé');
  });
});

describe('extractSectionNumber', () => {
  it('extracts a leading integer', () => {
    expect(extractSectionNumber('3. Features')).toBe('3');
  });

  it('extracts a dotted number', () => {
    expect(extractSectionNumber('3.5 Chat tab')).toBe('3.5');
  });

  it('returns null when no number prefix', () => {
    expect(extractSectionNumber('Overview')).toBeNull();
  });
});

describe('findSectionReferences', () => {
  it('finds §N and §N.M in text', () => {
    const refs = findSectionReferences('See §3 and §4.2 also §10.');
    expect(refs.map((r) => r.section)).toEqual(['3', '4.2', '10']);
  });

  it('does not match §foo', () => {
    expect(findSectionReferences('§abc')).toEqual([]);
  });
});

describe('buildHeadingIdMap', () => {
  it('maps slugs and section numbers to heading IDs', () => {
    const body: docs_v1.Schema$Body = {
      content: [
        heading('Overview', 'h.aaa'),
        heading('3. Features & user journeys', 'h.bbb'),
      ],
    };
    const { bySlug, bySection } = buildHeadingIdMap(body);
    expect(bySlug.get('overview')).toBe('h.aaa');
    expect(bySlug.get('3-features--user-journeys')).toBe('h.bbb');
    expect(bySection.get('3')).toBe('h.bbb');
    expect(bySection.has('overview')).toBe(false);
  });

  it('ignores paragraphs without heading style or ID', () => {
    const body: docs_v1.Schema$Body = {
      content: [
        {
          paragraph: {
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            elements: [{ textRun: { content: 'Body\n' } }],
          },
        },
        {
          paragraph: {
            paragraphStyle: { namedStyleType: 'HEADING_1' }, // no headingId
            elements: [{ textRun: { content: 'Title\n' } }],
          },
        },
      ],
    };
    const { bySlug } = buildHeadingIdMap(body);
    expect(bySlug.size).toBe(0);
  });
});

describe('resolveHeadingLinkRequests', () => {
  const idMap = {
    bySlug: new Map([['overview', 'h.aaa']]),
    bySection: new Map([['3', 'h.bbb']]),
  };

  it('emits link.headingId for slug targets that resolve', () => {
    const reqs = resolveHeadingLinkRequests(
      [{ startIndex: 10, endIndex: 20, target: { kind: 'slug', value: 'overview' } }],
      idMap,
    );
    expect(reqs).toHaveLength(1);
    expect(reqs[0].updateTextStyle?.textStyle?.link?.headingId).toBe('h.aaa');
    expect(reqs[0].updateTextStyle?.range).toEqual({ startIndex: 10, endIndex: 20 });
    expect(reqs[0].updateTextStyle?.fields).toBe('link');
  });

  it('emits link.headingId for section targets', () => {
    const reqs = resolveHeadingLinkRequests(
      [{ startIndex: 30, endIndex: 32, target: { kind: 'section', value: '3' } }],
      idMap,
    );
    expect(reqs).toHaveLength(1);
    expect(reqs[0].updateTextStyle?.textStyle?.link?.headingId).toBe('h.bbb');
  });

  it('silently skips unresolvable targets', () => {
    const reqs = resolveHeadingLinkRequests(
      [{ startIndex: 5, endIndex: 7, target: { kind: 'slug', value: 'missing' } }],
      idMap,
    );
    expect(reqs).toHaveLength(0);
  });
});
