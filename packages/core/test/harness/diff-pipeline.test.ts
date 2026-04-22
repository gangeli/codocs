/**
 * Pipeline tests for the agent-edit path:
 *
 *   fake doc → docsToMarkdownWithMapping → agent edit → computeDocDiff
 *   → apply requests to simulated doc buffer → verify final text
 *
 * NOT a true end-to-end test: we never hit the real Google Docs API.
 * The doc is a hand-built `Schema$Document` and request application is
 * done by the local `applyRequests` simulator, which ONLY understands
 * `insertText` + `deleteContentRange`. Style, bullet, table, image,
 * and named-range requests are ignored by the simulator, so bugs in
 * those request shapes will not surface here — use the per-feature
 * converter tests for that coverage.
 *
 * These tests catch bugs where the text-manipulation requests produced
 * by `computeDocDiff` don't correctly map edited markdown back onto
 * the doc, producing garbled output (e.g., old text + new text
 * interleaved, split surrogate pairs, off-by-one deletes, etc.).
 */

import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { docsToMarkdownWithMapping } from '../../src/converter/docs-to-md.js';
import { computeDocDiff } from '../../src/harness/diff.js';

// ── Fake-doc helpers ───────────────────────────────────────────

interface Para {
  /** Text content, WITHOUT the trailing \n (we add it). */
  text: string;
  /** Optional heading level (1..6). */
  heading?: number;
}

interface TableSpec {
  /** Rows of cell text. Row 0 is the header; subsequent rows are
   *  data rows. Each row must have the same number of cells. */
  rows: string[][];
}

/**
 * Build a minimal Schema$Document with the given paragraphs. Each
 * paragraph has a single textRun containing its text + trailing "\n".
 * No section break is emitted (docsToMarkdown would render that as
 * "---" which pollutes the markdown and makes the test's `ours` harder
 * to reason about).
 */
function makeDoc(paras: Para[]): { document: docs_v1.Schema$Document; bodyText: string } {
  return makeDocWithParts(paras.map((p) => ({ kind: 'para' as const, para: p })));
}

/**
 * Build a Schema$Document from a sequence of parts (paragraphs and
 * tables) whose indices, startIndex/endIndex fields, and body text
 * buffer are laid out the way the live Docs API would produce them.
 * Tables track per-cell paragraph ranges so callers can assert on
 * request shapes that target specific cells by row/col.
 */
function makeDocWithParts(
  parts: Array<
    | { kind: 'para'; para: Para }
    | { kind: 'table'; table: TableSpec }
  >,
): { document: docs_v1.Schema$Document; bodyText: string } {
  const body: docs_v1.Schema$StructuralElement[] = [];
  let pos = 1;
  let bodyText = '';
  for (const part of parts) {
    if (part.kind === 'para') {
      const p = part.para;
      const content = p.text + '\n';
      const len = content.length;
      const namedStyle = p.heading ? `HEADING_${p.heading}` : 'NORMAL_TEXT';
      body.push({
        startIndex: pos,
        endIndex: pos + len,
        paragraph: {
          elements: [
            { startIndex: pos, endIndex: pos + len, textRun: { content, textStyle: {} } },
          ],
          paragraphStyle: { namedStyleType: namedStyle },
        },
      });
      pos += len;
      bodyText += content;
    } else {
      const { element, endIndex, text } = buildTableElement(part.table, pos);
      body.push(element);
      pos = endIndex;
      bodyText += text;
    }
  }
  return {
    document: {
      documentId: 'fake',
      title: 'fake',
      body: { content: body },
      namedRanges: {},
      lists: {},
      inlineObjects: {},
    },
    bodyText,
  };
}

/**
 * Build a Schema$StructuralElement wrapping a Schema$Table with the
 * given rows and cell texts, starting at `tableStart`. Each cell has
 * one paragraph whose content is `cellText + "\n"`. Cell structural
 * elements take 1 index; row structural elements take 1 index; the
 * table structural element takes 1 index. Matches the index layout
 * documented in md-to-docs.ts / processTableSegment.
 */
function buildTableElement(
  table: TableSpec,
  tableStart: number,
): {
  element: docs_v1.Schema$StructuralElement;
  endIndex: number;
  text: string;
} {
  const tableRows: docs_v1.Schema$TableRow[] = [];
  let idx = tableStart + 1; // row 0 structural
  let text = '';
  for (let r = 0; r < table.rows.length; r++) {
    const rowStart = idx;
    const tableCells: docs_v1.Schema$TableCell[] = [];
    let cellsIdx = idx + 1; // first cell structural
    for (let c = 0; c < table.rows[r].length; c++) {
      const cellStart = cellsIdx;
      const paraStart = cellStart + 1;
      const paraContent = table.rows[r][c] + '\n';
      const paraEnd = paraStart + paraContent.length;
      const cellEnd = paraEnd;
      tableCells.push({
        startIndex: cellStart,
        endIndex: cellEnd,
        content: [{
          startIndex: paraStart,
          endIndex: paraEnd,
          paragraph: {
            elements: [{
              startIndex: paraStart,
              endIndex: paraEnd,
              textRun: { content: paraContent, textStyle: {} },
            }],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        }],
      });
      text += paraContent;
      cellsIdx = cellEnd;
    }
    const rowEnd = cellsIdx;
    tableRows.push({ startIndex: rowStart, endIndex: rowEnd, tableCells });
    idx = rowEnd;
  }
  return {
    element: {
      startIndex: tableStart,
      endIndex: idx,
      table: {
        rows: table.rows.length,
        columns: table.rows[0]?.length ?? 0,
        tableRows,
      },
    },
    endIndex: idx,
    text,
  };
}

/**
 * Apply a sequence of Google Docs batchUpdate requests to a text buffer
 * that models the doc body (indices 1..bodyEndIndex-1).
 *
 * Supports: insertText, deleteContentRange. Ignores style/attribution
 * requests (they don't change text content).
 */
function applyRequests(bodyText: string, requests: docs_v1.Schema$Request[]): string {
  // Treat index 0 as the section-break slot; character positions start at 1.
  // We model the buffer as chars[0] = doc-index 1.
  let buf = bodyText;
  for (const req of requests) {
    if (req.insertText) {
      const at = req.insertText.location!.index! - 1;
      const text = req.insertText.text ?? '';
      buf = buf.slice(0, at) + text + buf.slice(at);
    } else if (req.deleteContentRange) {
      const start = req.deleteContentRange.range!.startIndex! - 1;
      const end = req.deleteContentRange.range!.endIndex! - 1;
      buf = buf.slice(0, start) + buf.slice(end);
    }
    // updateTextStyle / updateParagraphStyle / createNamedRange: ignored
  }
  return buf;
}

/** Compute the expected body text from a markdown string by stripping
 *  markdown syntax that the docs→md converter would add (# headings). */
function mdToExpectedBody(md: string): string {
  return md
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, ''))
    .join('\n');
}

/**
 * Run the full pipeline: extract (base, indexMap) from the doc, take
 * `ours` as the agent's edited markdown, merge, apply requests,
 * return the resulting body text.
 */
async function runPipeline(
  document: docs_v1.Schema$Document,
  bodyText: string,
  ours: string,
): Promise<{ result: string; requests: docs_v1.Schema$Request[] }> {
  const { markdown: base, indexMap } = docsToMarkdownWithMapping(document);
  const theirs = base;
  const diff = await computeDocDiff(base, ours, theirs, document, indexMap, 'test-agent');
  const result = applyRequests(bodyText, diff.requests);
  return { result, requests: diff.requests };
}

// ── Tests ──────────────────────────────────────────────────────

describe('pipeline: agent edit → applied doc (emoji/surrogate pairs)', () => {
  it('replaces a line containing an emoji without leaving surrogates', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'A \u{1F916} is \u{1F914} reply is posted' },
    ]);

    // Agent wants: drop " :bot: is" and keep the thinking emoji.
    // Original body ends with \n.
    const ours = 'A \u{1F914} reply is posted\n';

    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe(mdToExpectedBody(ours));
    // Crucially, no leftover 🤖 from the base.
    expect(result).not.toContain('\u{1F916}');
    // No lone high/low surrogate.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
  });

  it('reproduces the screenshot bug shape (replace emoji prefix in middle of text)', async () => {
    // From the bug report: doc text was roughly
    //   "A :bot: is :thinking: reply is posted..."
    // with :bot: rendered as 🤖 and :thinking: rendered as 🤔. The agent
    // was asked to change the prefix to just :thinking:. The result
    // showed garbled text like "A 🤔 tA 🤖 is 🤔 reply is posted..."
    const { document, bodyText } = makeDoc([
      { text: 'A \u{1F916} is \u{1F914} reply is posted immediately so the user sees that the comment was picked up' },
    ]);

    const ours = 'A \u{1F914} reply is posted immediately so the user sees that the comment was picked up\n';

    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe(mdToExpectedBody(ours));
    // The bug: result contains BOTH 🤖 and the new content intermixed.
    expect(result.match(/\u{1F916}/gu) ?? []).toHaveLength(0);
    // Exactly one thinking emoji in the result.
    expect(result.match(/\u{1F914}/gu) ?? []).toHaveLength(1);
    // No stray "tA" from partial deletion.
    expect(result).not.toMatch(/tA\s*\u{1F916}/u);
  });

  it('edits only one paragraph in a multi-paragraph section (no unchanged-text deletion)', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Features', heading: 1 },
      { text: 'The \u{1F916} reply is posted immediately.' },
      { text: '' }, // blank line between paragraphs
      { text: 'When session forking is supported, the comment is processed concurrently.' },
      { text: '' },
      { text: 'The \u{1F916} reply is deleted and replaced with the agent\u2019s text reply.' },
    ]);

    // Agent changes ONLY the last paragraph: 🤖 → 🤔 prefix.
    const { markdown: base } = docsToMarkdownWithMapping(document);
    const ours = base.replace(
      'The \u{1F916} reply is deleted',
      'The \u{1F914} reply is deleted',
    );
    expect(ours).not.toBe(base); // sanity: edit was applied

    const { result, requests } = await runPipeline(document, bodyText, ours);

    // Full expected body: heading and first two body paragraphs untouched;
    // only the last paragraph's emoji changes. Body-level representation
    // uses a single `\n` between every paragraph, and a `\n\n` between
    // paragraphs separated by an empty paragraph (blank line in markdown).
    const expectedBody =
      'Features\n' +
      'The \u{1F916} reply is posted immediately.\n' +
      '\n' +
      'When session forking is supported, the comment is processed concurrently.\n' +
      '\n' +
      'The \u{1F914} reply is deleted and replaced with the agent\u2019s text reply.\n';
    expect(result).toBe(expectedBody);

    // The test name promises "no unchanged-text deletion" — verify that
    // directly by checking that every delete range stays strictly inside
    // the last paragraph (the only one being edited). The unchanged
    // paragraphs ("Features" heading + first two body lines + the blank
    // paragraph between them) must never overlap any delete range, or
    // Google Docs comments anchored to those ranges would get clobbered
    // even though the text is unchanged.
    const lastPara = document.body!.content!.find(
      (el) => el.paragraph?.elements?.[0]?.textRun?.content?.startsWith('The \u{1F916} reply is deleted'),
    );
    expect(lastPara).toBeDefined();
    const lastParaStart = lastPara!.startIndex!;
    const deleteReqs = requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs.length).toBeGreaterThan(0);
    for (const req of deleteReqs) {
      const r = req.deleteContentRange!.range!;
      expect(r.startIndex).toBeGreaterThanOrEqual(lastParaStart);
    }
  });

  it('handles emoji at the very end of a line without truncation', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Trailing emoji \u{1F916}' },
    ]);
    const ours = 'Trailing emoji \u{1F914}\n';

    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe('Trailing emoji \u{1F914}\n');
  });

  it('handles emoji at the very start of a line without leading garbage', async () => {
    const { document, bodyText } = makeDoc([
      { text: '\u{1F916} leading emoji' },
    ]);
    const ours = '\u{1F914} leading emoji\n';

    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe('\u{1F914} leading emoji\n');
  });

  it('handles a surrogate pair at the split boundary (line-level diff3)', async () => {
    // Force diff3 to operate on lines where the only change straddles
    // an emoji surrogate boundary.
    const { document, bodyText } = makeDoc([
      { text: 'Line one.' },
      { text: 'Change \u{1F916} here.' },
      { text: 'Line three.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('Change \u{1F916} here.', 'Change \u{1F914} here.');
    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe('Line one.\nChange \u{1F914} here.\nLine three.\n');
    // No orphan surrogate halves (complementary check).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
  });

  it('replaces a heading\u2019s body line (heading preserved, no heading marker in doc)', async () => {
    // Regression for the "inserted text merges into heading" pattern.
    const { document, bodyText } = makeDoc([
      { text: 'A haiku about fruit', heading: 1 },
      { text: 'Summer\u2019s watermelon' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('Summer\u2019s watermelon', 'Summer\u2019s melon treat');
    const { result } = await runPipeline(document, bodyText, ours);

    // Exact body: heading text (no "# " marker in doc) + replaced body line.
    expect(result).toBe('A haiku about fruit\nSummer\u2019s melon treat\n');
  });

  it('appending a new line to a section containing emoji preserves existing emoji', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Features', heading: 1 },
      { text: 'Existing \u{1F916} line.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    // Agent appends a new line under the section.
    const ours = base.trimEnd() + '\n\nAnother \u{1F914} line.\n';

    const { result } = await runPipeline(document, bodyText, ours);

    // Expected body: heading + existing line + empty paragraph (blank line)
    // + newly appended line. At the body level the blank line between
    // paragraphs is an empty paragraph, i.e. `\n\n`.
    const expectedBody =
      'Features\n' +
      'Existing \u{1F916} line.\n' +
      '\n' +
      'Another \u{1F914} line.\n';
    expect(result).toBe(expectedBody);
  });

  it('does not leave residual characters when the old and new lines share a prefix containing emoji', async () => {
    // Diff3 may skip a common prefix that ends mid-surrogate-pair.
    // If the implementation splits at UTF-16 units, this could leave
    // a lone high surrogate in the output.
    const { document, bodyText } = makeDoc([
      { text: 'Prefix \u{1F916} stable and then old tail.' },
    ]);

    const ours = 'Prefix \u{1F916} stable and then new tail.\n';
    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe('Prefix \u{1F916} stable and then new tail.\n');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
  });

  it('round-trips an unchanged doc (no requests, no changes)', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Title', heading: 1 },
      { text: 'With a \u{1F916} and a \u{1F914}.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const { result, requests } = await runPipeline(document, bodyText, base);
    expect(requests).toHaveLength(0);
    expect(result).toBe(bodyText);
  });

  it('introduces a new emoji into plain text without leaving orphan surrogates', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Hello world.' },
    ]);
    const ours = 'Hello world \u{1F389}.\n';

    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe('Hello world \u{1F389}.\n');
    // No orphan surrogate halves (the newly inserted emoji must remain paired).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
  });

  it('strips an existing emoji from text without leaving orphan surrogates', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Hello \u{1F389} world.' },
    ]);
    const ours = 'Hello world.\n';

    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe('Hello world.\n');
    // No half of the removed surrogate pair may survive in the body.
    expect(result).not.toContain('\u{1F389}');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
  });
});

describe('pipeline: agent edit → applied doc (multi-line edits)', () => {
  it('replaces a single line with two lines without fusing into the next heading', async () => {
    // Matches the shape of e2e test A11: take a plain three-section doc
    // with headings, replace the middle section's single body paragraph
    // with a two-paragraph body. The second new paragraph must not fuse
    // into the following heading's text run.
    //
    // An extra blank paragraph between the second new paragraph and the
    // next heading is acceptable (it renders as an empty paragraph which
    // docsToMarkdown skips, so the markdown round-trip is unchanged).
    const { document, bodyText } = makeDoc([
      { text: 'Alpha', heading: 1 },
      { text: 'First paragraph of Alpha.' },
      { text: 'Beta', heading: 1 },
      { text: 'Second paragraph of Beta.' },
      { text: 'Gamma', heading: 1 },
      { text: 'Third paragraph of Gamma.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace(
      'Second paragraph of Beta.',
      'Second paragraph of Beta line one.\n\nSecond paragraph of Beta line two.',
    );
    const { result } = await runPipeline(document, bodyText, ours);

    // All six original paragraph terminators plus exactly one extra
    // blank-paragraph \n between line two and Gamma. The key property:
    // "Second paragraph of Beta line two." and "Gamma" are NOT in the
    // same doc paragraph (there is at least one \n between them).
    expect(result).toContain(
      'Beta\nSecond paragraph of Beta line one.\nSecond paragraph of Beta line two.\n',
    );
    expect(result).not.toContain('line two.Gamma');
    expect(result).toMatch(/Beta line two\.\n+Gamma\n/);
    // No stray old content.
    expect(result).not.toContain('Second paragraph of Beta.');
  });

  it('replaces a paragraph in the middle of a section cleanly', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Intro', heading: 1 },
      { text: 'Paragraph one stays.' },
      { text: '' },
      { text: 'Paragraph two changes.' },
      { text: '' },
      { text: 'Paragraph three stays.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('Paragraph two changes.', 'Paragraph two has been rewritten.');
    const { result } = await runPipeline(document, bodyText, ours);

    const expectedBody =
      'Intro\n' +
      'Paragraph one stays.\n' +
      '\n' +
      'Paragraph two has been rewritten.\n' +
      '\n' +
      'Paragraph three stays.\n';
    expect(result).toBe(expectedBody);
  });

  it('deletes a paragraph without touching its neighbors', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Intro', heading: 1 },
      { text: 'Keep me.' },
      { text: '' },
      { text: 'Delete me entirely.' },
      { text: '' },
      { text: 'Keep me too.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('\n\nDelete me entirely.', '');
    const { result } = await runPipeline(document, bodyText, ours);

    // Exact body: the deleted paragraph and its leading empty-paragraph
    // separator are both gone; the surrounding paragraphs are still
    // separated by a single empty paragraph (rendered as `\n\n`).
    expect(result).toBe('Intro\nKeep me.\n\nKeep me too.\n');
  });

  it('inserts a new paragraph between existing ones', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Intro', heading: 1 },
      { text: 'First.' },
      { text: '' },
      { text: 'Third.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('First.\n\nThird.', 'First.\n\nSecond \u{1F914} inserted.\n\nThird.');
    const { result } = await runPipeline(document, bodyText, ours);

    const expectedBody =
      'Intro\n' +
      'First.\n' +
      '\n' +
      'Second \u{1F914} inserted.\n' +
      '\n' +
      'Third.\n';
    expect(result).toBe(expectedBody);
  });

  it('edits two non-adjacent paragraphs in the same section (multi-hunk)', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Section', heading: 1 },
      { text: 'First \u{1F916} line.' },
      { text: '' },
      { text: 'Second stays.' },
      { text: '' },
      { text: 'Third \u{1F916} line.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    let ours = base.replace('First \u{1F916} line.', 'First \u{1F914} line.');
    ours = ours.replace('Third \u{1F916} line.', 'Third \u{1F914} line.');

    const { result, requests } = await runPipeline(document, bodyText, ours);

    // Should produce at least two delete+insert pairs (one per edited paragraph).
    const deleteReqs = requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs.length).toBeGreaterThanOrEqual(2);

    expect(result).toContain('First \u{1F914} line.');
    expect(result).toContain('Second stays.');
    expect(result).toContain('Third \u{1F914} line.');
    expect(result).not.toContain('\u{1F916}');
    // Paragraph boundaries intact — no two contiguous contents fused.
    expect(result).not.toMatch(/\u{1F914} line\.Second/u);
    expect(result).not.toMatch(/stays\.Third/u);
  });

  it('replacing the last paragraph (adjacent to body end) keeps exactly one trailing newline', async () => {
    // This is the regression for the "Summer's watermelon\n" bug:
    // when the replaced line sits at the end of the body, the delete
    // range gets clamped and the trailing \n is NOT consumed. The code
    // must notice this and NOT re-insert its own trailing \n.
    const { document, bodyText } = makeDoc([
      { text: 'Keep this heading.', heading: 1 },
      { text: 'Old last line \u{1F916}.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('Old last line \u{1F916}.', 'New last line \u{1F914}.');
    const { result } = await runPipeline(document, bodyText, ours);

    // Final body ends with exactly one \n — not zero, not two.
    expect(result.endsWith('\n')).toBe(true);
    expect(result.endsWith('\n\n')).toBe(false);
    expect(result).toBe('Keep this heading.\nNew last line \u{1F914}.\n');
  });

  it('replacing a middle paragraph (delete not clamped) restores the consumed newline', async () => {
    // Companion to the above: when the replaced line is NOT at body end,
    // the delete range INCLUDES the trailing \n, and the code must
    // re-insert it or adjacent paragraphs fuse.
    const { document, bodyText } = makeDoc([
      { text: 'Keep first.' },
      { text: 'Change me \u{1F916}.' },
      { text: 'Keep last.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('Change me \u{1F916}.', 'Changed \u{1F914}.');
    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe('Keep first.\nChanged \u{1F914}.\nKeep last.\n');
    // No paragraph fusion: the replacement and the next paragraph stay
    // on separate lines (there is a \n between them, not just text).
    expect(result).not.toMatch(/Changed \u{1F914}\.Keep last/u);
  });

  it('does not split a surrogate pair when text after emoji changes', async () => {
    // If the diff picks a common-prefix boundary that falls between the
    // high and low surrogate of an emoji, replacing the suffix would
    // leave a lone high-surrogate in the doc and render as U+FFFD.
    const { document, bodyText } = makeDoc([
      { text: 'Prefix \u{1F916} old suffix content.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('old suffix content.', 'NEW suffix content.');
    const { result } = await runPipeline(document, bodyText, ours);

    expect(result).toBe('Prefix \u{1F916} NEW suffix content.\n');
    // Assert no orphan surrogates anywhere.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
  });
});

// ── Targeted unit tests for the regressions uncovered by the e2e tests ──

describe('buildLineDocIndices: 1:1 extrapolation past the last indexMap entry', () => {
  // Regression: interpolateDocIndex's local-ratio extrapolation undershoots
  // past the last paragraph (the heading-drift ratio no longer applies).
  // buildLineDocIndices must extrapolate 1:1 from the last entry, clamped
  // to sectionDocEnd, or delete ranges truncate a char short and leave
  // residual letters like "on" → "n".
  //
  // This is an integration-style check via computeDocDiff; we don't export
  // buildLineDocIndices directly.
  it('delete range covers the full last paragraph when replaced', async () => {
    const { document, bodyText } = makeDoc([
      { text: 'Heading', heading: 1 },
      { text: 'Some intro text.' },
      { text: '' },
      { text: 'Old final line.' },
    ]);
    const { markdown: base } = docsToMarkdownWithMapping(document);

    const ours = base.replace('Old final line.', 'New final line rewritten.');
    const { result } = await runPipeline(document, bodyText, ours);

    // The full "Old final line." is gone — no single-char residue.
    expect(result).not.toContain('Old');
    expect(result).not.toMatch(/\b[a-z]\bfinal/);
    expect(result.trimEnd().endsWith('New final line rewritten.')).toBe(true);
  });
});

// ── Helper sanity check (apply/extract buffer math is correct) ──

describe('applyRequests (test helper)', () => {
  it('applies insert and delete at the expected positions', () => {
    // Not testing production code — just ensuring the simulator in this
    // file doesn't itself have an off-by-one that would invalidate the
    // tests above.
    const buf = 'abcdef'; // positions 1..6
    const after = [
      { insertText: { location: { index: 4 }, text: 'XY' } },
      { deleteContentRange: { range: { startIndex: 2, endIndex: 3 } } },
    ].reduce<string>((acc, req: docs_v1.Schema$Request) => {
      if (req.insertText) {
        const at = req.insertText.location!.index! - 1;
        return acc.slice(0, at) + (req.insertText.text ?? '') + acc.slice(at);
      }
      if (req.deleteContentRange) {
        const s = req.deleteContentRange.range!.startIndex! - 1;
        const e = req.deleteContentRange.range!.endIndex! - 1;
        return acc.slice(0, s) + acc.slice(e);
      }
      return acc;
    }, buf);

    // "abcdef" → insert "XY" at pos 4 → "abcXYdef" → delete [2,3) → "aXYdef"
    //                                     ^^^                         Actually:
    // Let's verify step by step:
    //   start: "abcdef"
    //   insert at index 4 (before 'd'): "abcXYdef"
    //   delete [2,3) removes 'b': "acXYdef"
    expect(after).toBe('acXYdef');
  });
});

describe('pipeline: agent edit → applied doc (bullet list edits)', () => {
  it('appends a bullet next to an existing bulleted paragraph without creating a new list', async () => {
    // Build a doc whose paragraphs are bullets — the .bullet field on
    // each paragraph signals to the diff engine that the surrounding
    // context is a list. Matches the shape of e2e test B9: apple /
    // banana / cherry are all in the same list; the agent appends
    // "- date" and expects it to join that list, not start a new one.
    const listId = 'L1';
    const body: docs_v1.Schema$StructuralElement[] = [];
    let pos = 1;
    const makeBullet = (text: string) => {
      const content = text + '\n';
      body.push({
        startIndex: pos,
        endIndex: pos + content.length,
        paragraph: {
          elements: [
            { startIndex: pos, endIndex: pos + content.length, textRun: { content, textStyle: {} } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          bullet: { listId, nestingLevel: 0 },
        },
      });
      pos += content.length;
    };
    makeBullet('apple');
    makeBullet('banana');
    makeBullet('cherry');
    const document: docs_v1.Schema$Document = {
      documentId: 'fake',
      title: 'fake',
      body: { content: body },
      namedRanges: {},
      lists: {
        [listId]: {
          listProperties: {
            nestingLevels: [
              { glyphType: 'GLYPH_TYPE_UNSPECIFIED', glyphSymbol: '●' },
            ],
          },
        },
      },
      inlineObjects: {},
    };
    const { markdown: base, indexMap } = docsToMarkdownWithMapping(document);
    const ours = base.replace('- cherry', '- cherry\n- date');

    const diff = await computeDocDiff(base, ours, base, document, indexMap, 'test-agent');

    // The new bullet must be inserted adjacent to cherry. Critically,
    // the diff must NOT emit a createParagraphBullets for the new item
    // — that would start a fresh list with its own listId and render
    // as a separate block. Instead the paragraph-split should let the
    // new paragraph inherit cherry's listId.
    const bulletCreates = diff.requests.filter((r) => r.createParagraphBullets);
    expect(bulletCreates).toEqual([]);

    // And the new content must be inserted somewhere: either as a
    // standalone insertText of "date" or as part of a larger text
    // insert that happens to contain "date".
    const insertedText = diff.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('|');
    expect(insertedText).toContain('date');

    // The inserted paragraph must also NOT be reset to NORMAL_TEXT:
    // updateParagraphStyle with namedStyleType cascades through the
    // paragraph's entire style template, which in Docs overrides the
    // inherited list formatting even though `bullet` sits on a
    // separate field. Drop that request too, and the split-inherited
    // listId survives unchanged.
    const paraStyleUpdates = diff.requests.filter((r) => r.updateParagraphStyle);
    expect(paraStyleUpdates).toEqual([]);

    // The insert must land at cherry's terminating '\n'. Layout:
    //   apple   [1, 7)    (apple\n, 6 chars)
    //   banana  [7, 14)   (banana\n, 7 chars)
    //   cherry  [14, 21)  (cherry\n, 7 chars) — '\n' at index 20
    // So insertPosition = cherry.endIndex - 1 = 20 with text "\ndate".
    // That places the new \n inside cherry's paragraph, making the
    // split-right paragraph inherit cherry's listId. Inserting at
    // cherry.endIndex (21) would split the following paragraph instead.
    const textInserts = diff.requests.filter((r) => r.insertText);
    expect(textInserts.length).toBe(1);
    expect(textInserts[0].insertText!.location!.index).toBe(20);
    expect(textInserts[0].insertText!.text).toBe('\ndate');
  });
});

describe('pipeline: agent edit → applied doc (table edits)', () => {
  // These tests inspect the emitted request shapes directly instead of
  // applying them via applyRequests: the simulator doesn't know how to
  // reshape a Schema$Table under insertTableRow / deleteTableRow, and
  // modelling that faithfully here would re-implement a big chunk of
  // the Docs API. Validating the request shapes plus the target cell
  // paragraph ranges is sufficient — the e2e round-trip test exercises
  // the actual Docs application.

  it('edits a table cell via a cell-paragraph text replacement', async () => {
    const { document } = makeDocWithParts([
      { kind: 'para', para: { text: 'Heading', heading: 1 } },
      {
        kind: 'table',
        table: {
          rows: [
            ['Col1', 'Col2'],
            ['a', 'b'],
            ['c', 'd'],
          ],
        },
      },
    ]);
    const { markdown: base, indexMap } = docsToMarkdownWithMapping(document);
    const ours = base.replace('| a | b |', '| A | b |');

    const theirs = base;
    const diff = await computeDocDiff(base, ours, theirs, document, indexMap, 'test-agent');

    // No structural row ops — it's a cell edit.
    expect(diff.requests.some((r) => r.insertTableRow)).toBe(false);
    expect(diff.requests.some((r) => r.deleteTableRow)).toBe(false);

    // There should be a text replacement scoped to the "a" cell's
    // paragraph range. The doc has: heading (Heading\n at [1, 9)),
    // then table starting at 9. Row 0 (header): row structural at 10,
    // col 0 cell at 11, paragraph at 12 ("Col1\n"), endIndex 17,
    // col 1 cell at 17, paragraph at 18 ("Col2\n"), endIndex 23.
    // Row 1: row at 23, col 0 cell at 24, paragraph at 25 ("a\n"),
    // endIndex 27, col 1 cell at 27, paragraph at 28 ("b\n"), endIndex 30.
    // So the "a" paragraph is at [25, 27).
    const deletes = diff.requests.filter((r) => r.deleteContentRange);
    const inserts = diff.requests.filter((r) => r.insertText);

    const aDelete = deletes.find(
      (r) => r.deleteContentRange?.range?.startIndex === 25,
    );
    expect(aDelete).toBeDefined();
    // Paragraph is "a\n" at [25, 27); the delete drops just "a" (keeps \n),
    // i.e. endIndex === 26.
    expect(aDelete!.deleteContentRange?.range?.endIndex).toBe(26);

    const aInsert = inserts.find(
      (r) => r.insertText?.location?.index === 25 && r.insertText?.text === 'A',
    );
    expect(aInsert).toBeDefined();

    // The "b" cell is untouched — no delete or insert at that range.
    expect(deletes.find((r) => r.deleteContentRange?.range?.startIndex === 28)).toBeUndefined();
    expect(inserts.find((r) => r.insertText?.location?.index === 28 && r.insertText?.text === 'b')).toBeUndefined();

    // And the header row (doc row 0) is NOT touched.
    expect(deletes.find((r) => r.deleteContentRange?.range?.startIndex === 12)).toBeUndefined();
    expect(deletes.find((r) => r.deleteContentRange?.range?.startIndex === 18)).toBeUndefined();
  });

  it('adds a table row via insertTableRow + per-cell insertText', async () => {
    const { document } = makeDocWithParts([
      { kind: 'para', para: { text: 'Heading', heading: 1 } },
      {
        kind: 'table',
        table: {
          rows: [
            ['Col1', 'Col2'],
            ['a', 'b'],
            ['c', 'd'],
          ],
        },
      },
    ]);
    const { markdown: base, indexMap } = docsToMarkdownWithMapping(document);
    const ours = base.replace('| c | d |', '| c | d |\n| e | f |');

    const diff = await computeDocDiff(base, ours, base, document, indexMap, 'test-agent');

    const rowInserts = diff.requests.filter((r) => r.insertTableRow);
    expect(rowInserts.length).toBe(1);
    const loc = rowInserts[0].insertTableRow!.tableCellLocation!;
    // Table starts at index 9, and the new row is inserted below
    // doc row 2 ("c | d"). rowIndex must be 2 and insertBelow true.
    expect(loc.tableStartLocation?.index).toBe(9);
    expect(loc.rowIndex).toBe(2);
    expect(rowInserts[0].insertTableRow!.insertBelow).toBe(true);

    // The per-cell inserts land at positions computed from the anchor
    // row's endIndex. Row 2 (['c', 'd']) cells lay out:
    //   table at 9, row 2 at [30, 37): row structure at 30, cell(2,0)
    //   at 31, paragraph "c\n" at [32, 34), cell(2,1) at 34,
    //   paragraph "d\n" at [35, 37). So row 2 endIndex = 37.
    // After insertTableRow below row 2, the new row starts at 37 and
    // its cell paragraphs are at newRowStart + 2 + 2c: 39 (col 0),
    // 41 (col 1).
    const cellInserts = diff.requests.filter(
      (r) => r.insertText && (r.insertText.text === 'e' || r.insertText.text === 'f'),
    );
    expect(cellInserts.length).toBe(2);
    const fInsert = cellInserts.find((r) => r.insertText?.text === 'f');
    const eInsert = cellInserts.find((r) => r.insertText?.text === 'e');
    expect(fInsert?.insertText?.location?.index).toBe(41);
    expect(eInsert?.insertText?.location?.index).toBe(39);
    // 'f' must be emitted BEFORE 'e' in the request stream, so that
    // inserting 'e' doesn't shift 'f's target index.
    const fIdx = diff.requests.indexOf(fInsert!);
    const eIdx = diff.requests.indexOf(eInsert!);
    expect(fIdx).toBeLessThan(eIdx);
  });

  it('deletes a table row via deleteTableRow, not text-delete', async () => {
    const { document } = makeDocWithParts([
      { kind: 'para', para: { text: 'Heading', heading: 1 } },
      {
        kind: 'table',
        table: {
          rows: [
            ['Col1', 'Col2'],
            ['a', 'b'],
            ['c', 'd'],
          ],
        },
      },
    ]);
    const { markdown: base, indexMap } = docsToMarkdownWithMapping(document);
    const ours = base.replace('| a | b |\n', '');

    const diff = await computeDocDiff(base, ours, base, document, indexMap, 'test-agent');

    const rowDeletes = diff.requests.filter((r) => r.deleteTableRow);
    expect(rowDeletes.length).toBe(1);
    const loc = rowDeletes[0].deleteTableRow!.tableCellLocation!;
    expect(loc.tableStartLocation?.index).toBe(9);
    expect(loc.rowIndex).toBe(1); // row [a, b] is doc row 1

    // No text-deletes should target the cell paragraphs of that row —
    // the structural row delete already removes them. Specifically,
    // nothing should delete into the "a" or "b" cell ranges ([25, 27)
    // and [28, 30)).
    const textDeletes = diff.requests.filter((r) => r.deleteContentRange);
    for (const d of textDeletes) {
      const start = d.deleteContentRange!.range!.startIndex!;
      expect(start < 23 || start >= 30).toBe(true);
    }
  });
});
