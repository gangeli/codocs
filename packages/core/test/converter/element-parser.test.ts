import { describe, it, expect } from 'vitest';
import { docsToMarkdown } from '../../src/converter/docs-to-md.js';
import type { docs_v1 } from 'googleapis';

/** Build a minimal document with the given structural elements. */
function makeDoc(
  content: docs_v1.Schema$StructuralElement[],
  opts?: {
    namedRanges?: docs_v1.Schema$Document['namedRanges'];
    lists?: docs_v1.Schema$Document['lists'];
    inlineObjects?: docs_v1.Schema$Document['inlineObjects'];
  },
): docs_v1.Schema$Document {
  return {
    documentId: 'test',
    title: 'Test',
    body: { content },
    namedRanges: opts?.namedRanges ?? {},
    lists: opts?.lists ?? {},
    inlineObjects: opts?.inlineObjects ?? {},
  };
}

function paragraph(
  text: string,
  style?: Partial<docs_v1.Schema$ParagraphStyle>,
  textStyle?: Partial<docs_v1.Schema$TextStyle>,
  startIndex = 1,
): docs_v1.Schema$StructuralElement {
  const endIndex = startIndex + text.length + 1;
  return {
    startIndex,
    endIndex,
    paragraph: {
      elements: [
        {
          startIndex,
          endIndex,
          textRun: { content: text + '\n', textStyle: textStyle ?? {} },
        },
      ],
      paragraphStyle: style ?? { namedStyleType: 'NORMAL_TEXT' },
    },
  };
}

describe('element-parser edge cases', () => {
  it('handles bold + italic combined', () => {
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 10,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 10,
              textRun: {
                content: 'emphasis\n',
                textStyle: { bold: true, italic: true },
              },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    const md = docsToMarkdown(doc);
    expect(md).toContain('***emphasis***');
  });

  it('handles strikethrough text', () => {
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 10,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 10,
              textRun: {
                content: 'removed\n',
                textStyle: { strikethrough: true },
              },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    const md = docsToMarkdown(doc);
    expect(md).toContain('~~removed~~');
  });

  it('handles links', () => {
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 12,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 12,
              textRun: {
                content: 'click here\n',
                textStyle: { link: { url: 'https://example.com' } },
              },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    const md = docsToMarkdown(doc);
    expect(md).toContain('[click here](https://example.com)');
  });

  it('handles monospace font as inline code', () => {
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 8,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 8,
              textRun: {
                content: 'foo()\n',
                textStyle: {
                  weightedFontFamily: { fontFamily: 'Courier New' },
                },
              },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    const md = docsToMarkdown(doc);
    expect(md).toContain('`foo()`');
  });

  it('handles TITLE style as h1', () => {
    const doc = makeDoc([
      paragraph('My Title', { namedStyleType: 'TITLE' }),
    ]);
    const md = docsToMarkdown(doc);
    expect(md).toContain('# My Title');
  });

  it('handles SUBTITLE style as h2', () => {
    const doc = makeDoc([
      paragraph('Sub', { namedStyleType: 'SUBTITLE' }),
    ]);
    const md = docsToMarkdown(doc);
    expect(md).toContain('## Sub');
  });

  it('handles nested bullet lists', () => {
    const doc = makeDoc(
      [
        {
          startIndex: 1,
          endIndex: 8,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 8,
                textRun: { content: 'outer\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            bullet: { listId: 'list-1', nestingLevel: 0 },
          },
        },
        {
          startIndex: 8,
          endIndex: 15,
          paragraph: {
            elements: [
              {
                startIndex: 8,
                endIndex: 15,
                textRun: { content: 'inner\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            bullet: { listId: 'list-1', nestingLevel: 1 },
          },
        },
      ],
      {
        lists: {
          'list-1': {
            listProperties: {
              nestingLevels: [
                { glyphType: 'GLYPH_TYPE_UNSPECIFIED' },
                { glyphType: 'GLYPH_TYPE_UNSPECIFIED' },
              ],
            },
          },
        },
      },
    );
    const md = docsToMarkdown(doc);
    expect(md).toContain('- outer');
    expect(md).toContain('  - inner');
  });

  it('handles a table', () => {
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 50,
        table: {
          rows: 2,
          columns: 2,
          tableRows: [
            {
              tableCells: [
                {
                  content: [
                    {
                      paragraph: {
                        elements: [
                          { textRun: { content: 'A\n' } },
                        ],
                      },
                    },
                  ],
                },
                {
                  content: [
                    {
                      paragraph: {
                        elements: [
                          { textRun: { content: 'B\n' } },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
            {
              tableCells: [
                {
                  content: [
                    {
                      paragraph: {
                        elements: [
                          { textRun: { content: 'C\n' } },
                        ],
                      },
                    },
                  ],
                },
                {
                  content: [
                    {
                      paragraph: {
                        elements: [
                          { textRun: { content: 'D\n' } },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
    const md = docsToMarkdown(doc);
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| C | D |');
  });

  it('handles mixed content with section break filtered out', () => {
    const doc = makeDoc(
      [
        {
          startIndex: 0,
          endIndex: 1,
          sectionBreak: {},
        },
        paragraph('Hello', { namedStyleType: 'NORMAL_TEXT' }),
      ],
      {
        namedRanges: {
          'agent:test': {
            namedRanges: [
              {
                namedRangeId: 'nr-1',
                name: 'agent:test',
                ranges: [{ startIndex: 1, endIndex: 10 }],
              },
            ],
          },
        },
      },
    );
    // When filtering by agent, section breaks should not appear
    const md = docsToMarkdown(doc, { agentFilter: 'test' });
    expect(md).not.toContain('---');
    expect(md).toContain('Hello');
  });
});
