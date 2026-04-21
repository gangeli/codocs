import { describe, it, expect } from 'vitest';
import {
  docsToMarkdown,
  docsToMarkdownWithMapping,
} from '../../src/converter/docs-to-md.js';
import type { IndexMapEntry } from '../../src/converter/element-parser.js';
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
  // Docs always appends '\n' to a paragraph's final textRun. The paragraph
  // (and its only textRun here) spans `startIndex .. startIndex + text.length + 1`
  // — one extra code unit for the trailing newline. endIndex is exclusive.
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

/**
 * Validate an IndexMapEntry[] emitted by docsToMarkdownWithMapping against
 * the underlying document and produced markdown. Checks invariants the
 * diff engine relies on — entries are sorted by mdOffset, ranges don't
 * overlap, every docIndex matches a structural element's startIndex, and
 * the overall count matches the number of emitted structural elements.
 *
 * Throws a descriptive Error on any mismatch.
 */
function validateIndexMap(
  md: string,
  doc: docs_v1.Schema$Document,
  indexMap: IndexMapEntry[],
): void {
  // Collect valid docIndex values (startIndex of each structural element)
  // and the body's upper bound (largest endIndex).
  const elementStarts = new Set<number>();
  let bodyEndIndex = 1;
  for (const el of doc.body?.content ?? []) {
    if (el.startIndex != null) elementStarts.add(el.startIndex);
    if (el.endIndex != null && el.endIndex > bodyEndIndex) {
      bodyEndIndex = el.endIndex;
    }
  }

  // Entries must be strictly increasing on both mdOffset and docIndex
  // (monotonic = diff engine can binary-search).
  for (let i = 0; i < indexMap.length; i++) {
    const e = indexMap[i];
    if (e.mdOffset < 0 || e.mdOffset > md.length) {
      throw new Error(
        `indexMap[${i}] mdOffset=${e.mdOffset} is outside markdown [0, ${md.length}]`,
      );
    }
    if (e.docIndex < 1 || e.docIndex >= bodyEndIndex) {
      throw new Error(
        `indexMap[${i}] docIndex=${e.docIndex} is outside body [1, ${bodyEndIndex})`,
      );
    }
    if (!elementStarts.has(e.docIndex)) {
      const starts = Array.from(elementStarts).sort((a, b) => a - b).join(', ');
      throw new Error(
        `indexMap[${i}] docIndex=${e.docIndex} does not match any structural element startIndex. ` +
          `Valid starts: [${starts}]`,
      );
    }
    if (i > 0) {
      const prev = indexMap[i - 1];
      if (e.mdOffset <= prev.mdOffset) {
        throw new Error(
          `indexMap not sorted: [${i - 1}].mdOffset=${prev.mdOffset} >= [${i}].mdOffset=${e.mdOffset}`,
        );
      }
      if (e.docIndex <= prev.docIndex) {
        throw new Error(
          `indexMap docIndex not monotonic: [${i - 1}].docIndex=${prev.docIndex} >= [${i}].docIndex=${e.docIndex}`,
        );
      }
    }
  }
}

/** Convenience: run both docsToMarkdown and docsToMarkdownWithMapping,
 *  assert they agree on the markdown string, validate the indexMap, and
 *  return both. */
function renderAndValidate(
  doc: docs_v1.Schema$Document,
  options?: Parameters<typeof docsToMarkdown>[1],
): { md: string; indexMap: IndexMapEntry[] } {
  const md = docsToMarkdown(doc, options);
  const mapped = docsToMarkdownWithMapping(doc, options);
  expect(mapped.markdown).toBe(md);
  validateIndexMap(md, doc, mapped.indexMap);
  return { md, indexMap: mapped.indexMap };
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
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('***emphasis***\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('handles strikethrough text', () => {
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 9,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 9,
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
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('~~removed~~\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
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
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('[click here](https://example.com)\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('renders a fully-monospace paragraph as a fenced code block', () => {
    // Inline code requires MIXED monospace + normal runs within a single
    // paragraph. When the entire paragraph is monospace, it's the
    // (possibly single-line) content of a fenced code block on round-trip.
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 7,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 7,
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
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('```\nfoo()\n```\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('emits inline code when monospace is mixed with plain text in one paragraph', () => {
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 31,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 9,
              textRun: { content: 'Use the ' },
            },
            {
              startIndex: 9,
              endIndex: 22,
              textRun: {
                content: 'console.log()',
                textStyle: {
                  weightedFontFamily: { fontFamily: 'Courier New' },
                },
              },
            },
            {
              startIndex: 22,
              endIndex: 31,
              textRun: { content: ' please.\n' },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('Use the `console.log()` please.\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('handles TITLE style as h1', () => {
    const doc = makeDoc([
      paragraph('My Title', { namedStyleType: 'TITLE' }),
    ]);
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('# My Title\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('handles SUBTITLE style as h2', () => {
    const doc = makeDoc([
      paragraph('Sub', { namedStyleType: 'SUBTITLE' }),
    ]);
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('## Sub\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('handles nested bullet lists', () => {
    const doc = makeDoc(
      [
        {
          startIndex: 1,
          endIndex: 7,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 7,
                textRun: { content: 'outer\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            bullet: { listId: 'list-1', nestingLevel: 0 },
          },
        },
        {
          startIndex: 7,
          endIndex: 13,
          paragraph: {
            elements: [
              {
                startIndex: 7,
                endIndex: 13,
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
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('- outer\n  - inner\n');
    expect(indexMap).toEqual([
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 8, docIndex: 7 },
    ]);
  });

  it('handles checkbox lists (unchecked)', () => {
    const doc = makeDoc(
      [
        {
          startIndex: 1,
          endIndex: 10,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 10,
                textRun: { content: 'buy milk\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            bullet: { listId: 'list-cb', nestingLevel: 0 },
          },
        },
      ],
      {
        lists: {
          'list-cb': {
            listProperties: {
              nestingLevels: [
                { glyphType: 'GLYPH_TYPE_UNSPECIFIED', glyphSymbol: '\u2610' },
              ],
            },
          },
        },
      },
    );
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('- [ ] buy milk\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('handles checkbox lists (checked via strikethrough)', () => {
    const doc = makeDoc(
      [
        {
          startIndex: 1,
          endIndex: 11,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 11,
                textRun: { content: 'done task\n', textStyle: { strikethrough: true } },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            bullet: { listId: 'list-cb', nestingLevel: 0 },
          },
        },
      ],
      {
        lists: {
          'list-cb': {
            listProperties: {
              nestingLevels: [
                { glyphType: 'GLYPH_TYPE_UNSPECIFIED', glyphSymbol: '\u2610' },
              ],
            },
          },
        },
      },
    );
    // Strikethrough is the signal that the checkbox is checked, but Docs
    // keeps the span's strikethrough formatting — so we still emit
    // `~~...~~` inside the `[x]` item. (Consumers that want the bare text
    // can strip the markdown; we preserve the round-trip shape here.)
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('- [x] ~~done task~~\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('handles checkbox lists via checkboxLevel property', () => {
    const nestingLevel: any = {
      glyphType: 'NONE',
      checkboxLevel: true,
    };
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
                textRun: { content: 'a task\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            bullet: { listId: 'list-cb2', nestingLevel: 0 },
          },
        },
      ],
      {
        lists: {
          'list-cb2': {
            listProperties: {
              nestingLevels: [nestingLevel],
            },
          },
        },
      },
    );
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('- [ ] a task\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
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
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('| A | B |\n| --- | --- |\n| C | D |\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  // ── Inline images ────────────────────────────────────────────

  it('emits ![title](sourceUri) for a plain inline image', () => {
    const doc = makeDoc(
      [
        {
          startIndex: 1,
          endIndex: 3,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 2,
                inlineObjectElement: { inlineObjectId: 'kix.img1' },
              },
              {
                startIndex: 2,
                endIndex: 3,
                textRun: { content: '\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
      {
        inlineObjects: {
          'kix.img1': {
            inlineObjectProperties: {
              embeddedObject: {
                title: 'logo',
                imageProperties: {
                  sourceUri: 'https://example.com/logo.png',
                  contentUri: 'https://lh3.googleusercontent.com/TRANSIENT',
                },
              },
            },
          },
        },
      },
    );

    const { md, indexMap } = renderAndValidate(doc);
    // Must use sourceUri (stable) — never contentUri (30-min tagged URL).
    expect(md).toBe('![logo](https://example.com/logo.png)\n');
    expect(md).not.toContain('googleusercontent');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('restores a mermaid code block when the image sourceUri matches a known fileId', () => {
    const doc = makeDoc(
      [
        {
          startIndex: 1,
          endIndex: 3,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 2,
                inlineObjectElement: { inlineObjectId: 'kix.mmd1' },
              },
              {
                startIndex: 2,
                endIndex: 3,
                textRun: { content: '\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
      {
        inlineObjects: {
          'kix.mmd1': {
            inlineObjectProperties: {
              embeddedObject: {
                title: 'mermaid-abc.png',
                imageProperties: {
                  sourceUri: 'https://drive.google.com/uc?id=FILE_X',
                },
              },
            },
          },
        },
      },
    );

    const options = {
      mermaidByFileId: new Map([['FILE_X', 'graph TD; A-->B']]),
    };
    const { md, indexMap } = renderAndValidate(doc, options);
    expect(md).toBe('```mermaid\ngraph TD; A-->B\n```\n');
    // Must NOT leak the intermediate Drive URL as an image.
    expect(md).not.toContain('drive.google.com');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('does not mis-map a non-mermaid image into the mermaid store', () => {
    // An image whose sourceUri is a random URL (not drive.google.com) must
    // never be restored as mermaid even when a non-empty mermaid map is
    // supplied — this is the fix that makes mixed mermaid+image docs work.
    const doc = makeDoc(
      [
        {
          startIndex: 1,
          endIndex: 3,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 2,
                inlineObjectElement: { inlineObjectId: 'kix.real' },
              },
              {
                startIndex: 2,
                endIndex: 3,
                textRun: { content: '\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
      {
        inlineObjects: {
          'kix.real': {
            inlineObjectProperties: {
              embeddedObject: {
                title: 'photo',
                imageProperties: {
                  sourceUri: 'https://cdn.example.com/photo.jpg',
                },
              },
            },
          },
        },
      },
    );

    const options = {
      mermaidByFileId: new Map([['FILE_X', 'graph TD; A-->B']]),
    };
    const { md, indexMap } = renderAndValidate(doc, options);
    expect(md).toBe('![photo](https://cdn.example.com/photo.jpg)\n');
    expect(md).not.toContain('```mermaid');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
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
    // When filtering by agent, section breaks should not appear — the full
    // markdown must be exactly "Hello\n" so a spurious table-separator or
    // stray horizontal-rule couldn't slip through unnoticed.
    const { md, indexMap } = renderAndValidate(doc, { agentFilter: 'test' });
    expect(md).toBe('Hello\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  // ── Added coverage ──────────────────────────────────────────

  it('tracks UTF-16 surrogate pairs for emoji in doc indices', () => {
    // Google Docs indices are UTF-16 code units, so 🎉 (U+1F389) occupies
    // two units. A paragraph 'hi 🎉!\n' is 7 code units, so endIndex = 1+7=8.
    const content = 'hi \uD83C\uDF89!\n'; // "hi 🎉!\n"
    expect(content.length).toBe(7);
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 8,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 8,
              textRun: { content, textStyle: {} },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('hi \uD83C\uDF89!\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('renders three runs in one paragraph as a single markdown line', () => {
    // "Hello " (plain) + "world" (bold) + "." (plain), all in the same
    // paragraph. One structural element → one index map entry, even
    // though there are three runs.
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 14,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 7,
              textRun: { content: 'Hello ', textStyle: {} },
            },
            {
              startIndex: 7,
              endIndex: 12,
              textRun: { content: 'world', textStyle: { bold: true } },
            },
            {
              startIndex: 12,
              endIndex: 14,
              textRun: { content: '.\n', textStyle: {} },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('Hello **world**.\n');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  it('renders an ordered list with running counters', () => {
    const items = ['alpha', 'beta', 'gamma'];
    let idx = 1;
    const content: docs_v1.Schema$StructuralElement[] = items.map((text) => {
      const docText = text + '\n';
      const startIndex = idx;
      const endIndex = idx + docText.length;
      idx = endIndex;
      return {
        startIndex,
        endIndex,
        paragraph: {
          elements: [
            {
              startIndex,
              endIndex,
              textRun: { content: docText, textStyle: {} },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          bullet: { listId: 'list-ord', nestingLevel: 0 },
        },
      };
    });
    const doc = makeDoc(content, {
      lists: {
        'list-ord': {
          listProperties: {
            nestingLevels: [{ glyphType: 'DECIMAL' }],
          },
        },
      },
    });
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('1. alpha\n2. beta\n3. gamma\n');
    expect(indexMap).toEqual([
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 9, docIndex: 7 },
      { mdOffset: 17, docIndex: 12 },
    ]);
  });

  it('collapses adjacent identical-style runs into a single emphasis span', () => {
    // Two adjacent bold runs within one paragraph must render as one
    // `**...**` span, not `**x****y**` (which would be invalid markdown
    // for readers that require word boundaries).
    const doc = makeDoc([
      {
        startIndex: 1,
        endIndex: 10,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 5,
              textRun: { content: 'foo ', textStyle: { bold: true } },
            },
            {
              startIndex: 5,
              endIndex: 10,
              textRun: { content: 'bar\n', textStyle: { bold: true } },
            },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe('**foo bar**\n');
    expect(md).not.toContain('****');
    expect(indexMap).toEqual([{ mdOffset: 0, docIndex: 1 }]);
  });

  // ── Comprehensive round-trip ───────────────────────────────

  it('builds a correct index map across a heading + paragraph + bullet list + table + image', () => {
    // Heading (startIndex 1), styled paragraph, two bullets, a table, and
    // an inline image in the final paragraph. The index map must have one
    // entry per structural element, entries sorted by mdOffset, docIndex
    // strictly increasing.
    const doc = makeDoc(
      [
        // # Title\n  (paragraph 1..9)
        paragraph('Title', { namedStyleType: 'HEADING_1' }),
        // Paragraph with bold + link (9..29). "Bold text see link."
        // split into runs so that the bold span ends on a non-space
        // boundary — a trailing space inside the bold run would emit
        // `**Bold **text` which is NOT a valid CommonMark bold span
        // (the closing `**` may not be preceded by whitespace). Shaping
        // the runs so the space lives in the following plain run keeps
        // the emitted markdown round-trippable.
        //   "Bold"     bold  (9..13,  4 chars)
        //   " text "   plain (13..19, 6 chars)
        //   "see "     plain (19..23, 4 chars)
        //   "link"     link  (23..27, 4 chars)
        //   ".\n"      plain (27..29, 2 chars)
        {
          startIndex: 9,
          endIndex: 29,
          paragraph: {
            elements: [
              {
                startIndex: 9,
                endIndex: 13,
                textRun: { content: 'Bold', textStyle: { bold: true } },
              },
              {
                startIndex: 13,
                endIndex: 19,
                textRun: { content: ' text ', textStyle: {} },
              },
              {
                startIndex: 19,
                endIndex: 23,
                textRun: { content: 'see ', textStyle: {} },
              },
              {
                startIndex: 23,
                endIndex: 27,
                textRun: {
                  content: 'link',
                  textStyle: { link: { url: 'https://x.test' } },
                },
              },
              {
                startIndex: 27,
                endIndex: 29,
                textRun: { content: '.\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
        // Bullet "one\n" (29..33)
        {
          startIndex: 29,
          endIndex: 33,
          paragraph: {
            elements: [
              {
                startIndex: 29,
                endIndex: 33,
                textRun: { content: 'one\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            bullet: { listId: 'list-x', nestingLevel: 0 },
          },
        },
        // Bullet "two\n" (33..37)
        {
          startIndex: 33,
          endIndex: 37,
          paragraph: {
            elements: [
              {
                startIndex: 33,
                endIndex: 37,
                textRun: { content: 'two\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            bullet: { listId: 'list-x', nestingLevel: 0 },
          },
        },
        // Table (37..60)
        {
          startIndex: 37,
          endIndex: 60,
          table: {
            rows: 1,
            columns: 2,
            tableRows: [
              {
                tableCells: [
                  {
                    content: [
                      {
                        paragraph: {
                          elements: [{ textRun: { content: 'c1\n' } }],
                        },
                      },
                    ],
                  },
                  {
                    content: [
                      {
                        paragraph: {
                          elements: [{ textRun: { content: 'c2\n' } }],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        // Image paragraph (60..62)
        {
          startIndex: 60,
          endIndex: 62,
          paragraph: {
            elements: [
              {
                startIndex: 60,
                endIndex: 61,
                inlineObjectElement: { inlineObjectId: 'kix.pic' },
              },
              {
                startIndex: 61,
                endIndex: 62,
                textRun: { content: '\n', textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
      {
        lists: {
          'list-x': {
            listProperties: {
              nestingLevels: [{ glyphType: 'GLYPH_TYPE_UNSPECIFIED' }],
            },
          },
        },
        inlineObjects: {
          'kix.pic': {
            inlineObjectProperties: {
              embeddedObject: {
                title: 'pic',
                imageProperties: { sourceUri: 'https://i.test/p.png' },
              },
            },
          },
        },
      },
    );
    const expected =
      '# Title\n\n' +
      '**Bold** text see [link](https://x.test).\n\n' +
      '- one\n- two\n\n' +
      '| c1 | c2 |\n| --- | --- |\n\n' +
      '![pic](https://i.test/p.png)\n';
    const { md, indexMap } = renderAndValidate(doc);
    expect(md).toBe(expected);
    // One entry per structural element emitted: 6 total (heading, para,
    // bullet, bullet, table, image paragraph).
    expect(indexMap).toHaveLength(6);
    expect(indexMap.map((e) => e.docIndex)).toEqual([1, 9, 29, 33, 37, 60]);
    // mdOffsets align with expected markdown segment starts.
    expect(indexMap[0].mdOffset).toBe(0); // "# Title"
    expect(md.substring(indexMap[1].mdOffset)).toMatch(/^\*\*Bold/);
    expect(md.substring(indexMap[2].mdOffset)).toMatch(/^- one/);
    expect(md.substring(indexMap[3].mdOffset)).toMatch(/^- two/);
    expect(md.substring(indexMap[4].mdOffset)).toMatch(/^\| c1/);
    expect(md.substring(indexMap[5].mdOffset)).toMatch(/^!\[pic\]/);
  });
});
