import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { docsToMarkdown } from '../../src/converter/docs-to-md.js';

function loadFixture(name: string) {
  const path = new URL(`../fixtures/${name}`, import.meta.url).pathname;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Build a minimal document containing a single paragraph of the given text
 * and named style. `text` must NOT include a trailing newline — the helper
 * appends it and computes indices.
 */
function makeSingleParagraphDoc(
  text: string,
  namedStyleType: string,
  paragraphStyleExtra: Record<string, unknown> = {},
  textStyle: Record<string, unknown> = {},
) {
  const content = text + '\n';
  const endIdx = 1 + content.length;
  return {
    documentId: 'test',
    title: 'Test',
    body: {
      content: [
        {
          startIndex: 0,
          endIndex: 1,
          sectionBreak: { sectionStyle: { sectionType: 'CONTINUOUS' } },
        },
        {
          startIndex: 1,
          endIndex: endIdx,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: endIdx,
                textRun: { content, textStyle },
              },
            ],
            paragraphStyle: { namedStyleType, ...paragraphStyleExtra },
          },
        },
      ],
    },
    namedRanges: {},
    lists: {},
    inlineObjects: {},
  };
}

describe('docsToMarkdown', () => {
  it('converts a simple document with heading, bold, and italic', () => {
    const doc = loadFixture('simple-doc.json');
    const md = docsToMarkdown(doc);

    // Lock in the exact markdown serialization, not just substrings.
    const expected =
      '# My Title\n\n' +
      'Hello **bold** world.\n\n' +
      'Some *italic* text.\n';
    expect(md).toBe(expected);
  });

  it('converts a document with bullet list', () => {
    const doc = loadFixture('list-doc.json');
    const md = docsToMarkdown(doc);

    const expected =
      '- Item one\n' +
      '- Item two\n' +
      '- Item three\n';
    expect(md).toBe(expected);
  });

  it('filters content by agent', () => {
    const doc = loadFixture('attributed-doc.json');

    const plannerMd = docsToMarkdown(doc, { agentFilter: 'planner' });
    expect(plannerMd).toContain("Planner's section");
    expect(plannerMd).toContain('written by planner');
    expect(plannerMd).not.toContain("Coder's section");

    const coderMd = docsToMarkdown(doc, { agentFilter: 'coder' });
    expect(coderMd).toContain("Coder's section");
    expect(coderMd).toContain('written by coder');
    expect(coderMd).not.toContain("Planner's section");
  });

  it('includes attribution markers when requested', () => {
    const doc = loadFixture('attributed-doc.json');
    const md = docsToMarkdown(doc, { includeAttribution: true });

    // Every marker must appear; but we also want to assert structural
    // correctness: each marker immediately precedes the paragraph it
    // attributes, and the content between markers belongs to the agent
    // claimed by the preceding marker.
    expect(md).toContain('<!-- agent:planner -->');
    expect(md).toContain('<!-- agent:coder -->');

    // Split on agent markers and walk adjacent (marker, body) pairs.
    // The marker regex captures the agent name; every captured agent must
    // own the text that follows until the next marker.
    const markerRe = /<!-- agent:([a-z]+) -->\n([^\n]*)/g;
    const pairs: Array<{ agent: string; body: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(md)) !== null) {
      pairs.push({ agent: m[1], body: m[2] });
    }

    // We expect 4 marker+body pairs (2 per agent in the fixture).
    expect(pairs).toHaveLength(4);

    // Each planner marker must precede planner-authored text; ditto coder.
    const plannerBodies = pairs.filter((p) => p.agent === 'planner').map((p) => p.body);
    const coderBodies = pairs.filter((p) => p.agent === 'coder').map((p) => p.body);

    expect(plannerBodies.join(' ')).toContain("Planner's section");
    expect(plannerBodies.join(' ')).toContain('written by planner');
    expect(coderBodies.join(' ')).toContain("Coder's section");
    expect(coderBodies.join(' ')).toContain('written by coder');

    // Cross-agent leakage check: no planner body should mention the coder
    // section text (and vice versa).
    for (const body of plannerBodies) {
      expect(body).not.toContain("Coder's section");
      expect(body).not.toContain('written by coder');
    }
    for (const body of coderBodies) {
      expect(body).not.toContain("Planner's section");
      expect(body).not.toContain('written by planner');
    }

    // The first planner marker must come before the first coder marker in
    // the serialized output (matches fixture ordering).
    const firstPlanner = md.indexOf('<!-- agent:planner -->');
    const firstCoder = md.indexOf('<!-- agent:coder -->');
    expect(firstPlanner).toBeGreaterThanOrEqual(0);
    expect(firstCoder).toBeGreaterThan(firstPlanner);
  });

  it('handles empty document', () => {
    const doc = {
      documentId: 'empty',
      title: 'Empty',
      body: { content: [] },
      namedRanges: {},
      lists: {},
      inlineObjects: {},
    };
    const md = docsToMarkdown(doc);
    expect(md).toBe('');
  });

  it('returns an empty string when the agent filter matches no content', () => {
    const doc = loadFixture('attributed-doc.json');
    const md = docsToMarkdown(doc, { agentFilter: 'unknown-agent' });
    // Filtering to zero paragraphs yields the empty string, not a
    // lone '\n'.
    expect(md).toBe('');
  });

  // ── Heading level coverage ──────────────────────────────────────

  it('emits ## for HEADING_2', () => {
    const md = docsToMarkdown(makeSingleParagraphDoc('Head 2', 'HEADING_2'));
    expect(md).toBe('## Head 2\n');
  });

  it('emits ### for HEADING_3', () => {
    const md = docsToMarkdown(makeSingleParagraphDoc('Head 3', 'HEADING_3'));
    expect(md).toBe('### Head 3\n');
  });

  it('emits #### for HEADING_4', () => {
    const md = docsToMarkdown(makeSingleParagraphDoc('Head 4', 'HEADING_4'));
    expect(md).toBe('#### Head 4\n');
  });

  it('emits ##### for HEADING_5', () => {
    const md = docsToMarkdown(makeSingleParagraphDoc('Head 5', 'HEADING_5'));
    expect(md).toBe('##### Head 5\n');
  });

  it('emits ###### for HEADING_6', () => {
    const md = docsToMarkdown(makeSingleParagraphDoc('Head 6', 'HEADING_6'));
    expect(md).toBe('###### Head 6\n');
  });

  // ── Ordered list ────────────────────────────────────────────────

  it('emits numbered list items for DECIMAL-glyph bullets', () => {
    const doc = {
      documentId: 'o',
      title: 'O',
      body: {
        content: [
          { startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {} } },
          {
            startIndex: 1,
            endIndex: 9,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: 9,
                  textRun: { content: 'first\n', textStyle: {} },
                },
              ],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
              bullet: { listId: 'l1', nestingLevel: 0 },
            },
          },
          {
            startIndex: 9,
            endIndex: 17,
            paragraph: {
              elements: [
                {
                  startIndex: 9,
                  endIndex: 17,
                  textRun: { content: 'second\n', textStyle: {} },
                },
              ],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
              bullet: { listId: 'l1', nestingLevel: 0 },
            },
          },
        ],
      },
      namedRanges: {},
      lists: {
        l1: {
          listProperties: {
            nestingLevels: [{ glyphType: 'DECIMAL' }],
          },
        },
      },
      inlineObjects: {},
    };

    const md = docsToMarkdown(doc);
    expect(md).toBe('1. first\n2. second\n');
  });

  // ── Code block ──────────────────────────────────────────────────

  it('wraps a monospace-font paragraph in a fenced code block', () => {
    const doc = makeSingleParagraphDoc(
      'const x = 1;',
      'NORMAL_TEXT',
      {},
      { weightedFontFamily: { fontFamily: 'Courier New' } },
    );
    const md = docsToMarkdown(doc);
    expect(md).toBe('```\nconst x = 1;\n```\n');
  });

  it('does not fence a paragraph with only shading (no monospace font)', () => {
    const doc = makeSingleParagraphDoc(
      'const x = 1;',
      'NORMAL_TEXT',
      {
        shading: {
          backgroundColor: {
            color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } },
          },
        },
      },
      {},
    );
    const md = docsToMarkdown(doc);
    expect(md).not.toContain('```');
    expect(md).toBe('const x = 1;\n');
  });

  // ── Emoji / CJK round-trip ─────────────────────────────────────

  it('preserves emoji and CJK characters without corruption', () => {
    const doc = makeSingleParagraphDoc('Hello 🎉 你好', 'NORMAL_TEXT');
    const md = docsToMarkdown(doc);
    expect(md).toBe('Hello 🎉 你好\n');
    // Explicit sanity checks: the codepoints survive intact.
    expect(md).toContain('🎉');
    expect(md).toContain('你好');
  });

  // ── Determinism ────────────────────────────────────────────────

  it('is deterministic: calling twice on the same input yields identical output', () => {
    const doc = loadFixture('simple-doc.json');
    const a = docsToMarkdown(doc);
    const b = docsToMarkdown(doc);
    expect(a).toBe(b);

    const attr = loadFixture('attributed-doc.json');
    const a2 = docsToMarkdown(attr, { includeAttribution: true });
    const b2 = docsToMarkdown(attr, { includeAttribution: true });
    expect(a2).toBe(b2);
  });
});
