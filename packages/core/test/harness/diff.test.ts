import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import {
  parseSections,
  mergeDocuments,
  computeDocDiff,
  interpolateDocIndex,
  type MdSection,
} from '../../src/harness/diff.js';
import type { IndexMapEntry } from '../../src/converter/element-parser.js';

// ── Index map test helpers ────────────────────────────────────────
//
// NOTE TO FUTURE CLAUDE (and humans): Whenever a new test in this file
// needs an IndexMapEntry[], build it with buildDocAndMap() (or validate
// a hand-rolled map via validateIndexMap()) so mismatches between
// markdown offsets and doc paragraph content fail loudly rather than
// silently producing misleading diff output. Do NOT go back to ad-hoc
// `makeDocument(bodyEndIndex)` + literal index maps — they claim
// mappings the fake doc can't actually back up.

/**
 * Build a fake Google Docs document whose body contains real paragraphs,
 * plus an index map that is validated against the resulting doc before
 * it is returned. `paragraphs` lists the non-empty paragraphs the test
 * wants in the doc body, in order; each entry's `text` is the paragraph
 * content as it appears in the doc (no trailing newline, no markdown
 * markers) and `mdOffset` is where the corresponding markdown line
 * starts in `md`. If `mdOffset` is omitted the paragraph still lands
 * in the doc body but does not contribute an index map entry (useful
 * for tests that want a sparse index).
 */
function buildDocAndMap(
  md: string,
  paragraphs: Array<{ text: string; mdOffset?: number }>,
): {
  doc: docs_v1.Schema$Document;
  indexMap: IndexMapEntry[];
  bodyEndIndex: number;
} {
  const content: docs_v1.Schema$StructuralElement[] = [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
  ];
  const indexMap: IndexMapEntry[] = [];
  let idx = 1;

  for (const { text, mdOffset } of paragraphs) {
    const docText = text + '\n';
    const start = idx;
    const end = idx + docText.length;
    content.push({
      startIndex: start,
      endIndex: end,
      paragraph: {
        elements: [
          {
            startIndex: start,
            endIndex: end,
            textRun: { content: docText },
          },
        ],
      },
    });
    if (mdOffset !== undefined) {
      indexMap.push({ mdOffset, docIndex: start });
    }
    idx = end;
  }

  const doc: docs_v1.Schema$Document = { body: { content } };
  const bodyEndIndex = idx;
  validateIndexMap(md, doc, indexMap);
  return { doc, indexMap, bodyEndIndex };
}

/**
 * Strip the markdown markers that don't appear in the rendered doc text
 * (heading/bullet/numbered prefixes, bold/italic wrappers, inline code,
 * links). Used when comparing a raw markdown line against the text of
 * the paragraph it represents in the Google Doc.
 */
function stripMdMarkers(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:-|\*|\+|\d+\.)\s+\[[ xX]\]\s+/, '')
    .replace(/^(?:-|\*|\+|\d+\.)\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');
}

/**
 * Verify every IndexMapEntry matches the underlying doc + markdown.
 *
 * For each `{ mdOffset, docIndex }`:
 *   - The doc must have a paragraph whose startIndex === docIndex.
 *   - The markdown line starting at `mdOffset` (up to the next '\n'),
 *     with common markdown markers stripped (heading prefixes, bullets,
 *     bold/italic/link wrappers, inline code), must equal the
 *     paragraph's text (without its trailing '\n').
 *
 * Throws a descriptive Error on any mismatch. Call this from tests
 * that construct index maps by hand so typos in offsets or doc indices
 * surface as test failures rather than weird diff behaviour.
 */
function validateIndexMap(
  md: string,
  doc: docs_v1.Schema$Document,
  indexMap: IndexMapEntry[],
): void {
  const paragraphsByStart = new Map<number, string>();
  for (const el of doc.body?.content ?? []) {
    if (el.paragraph && el.startIndex != null) {
      let t = '';
      for (const e of el.paragraph.elements ?? []) {
        if (e.textRun?.content) t += e.textRun.content;
      }
      paragraphsByStart.set(el.startIndex, t.replace(/\n$/, ''));
    }
  }

  for (const entry of indexMap) {
    const docText = paragraphsByStart.get(entry.docIndex);
    if (docText === undefined) {
      const starts = Array.from(paragraphsByStart.keys()).join(', ');
      throw new Error(
        `Index map entry { mdOffset: ${entry.mdOffset}, docIndex: ${entry.docIndex} }: ` +
          `no paragraph starts at docIndex ${entry.docIndex}. ` +
          `Paragraph start indices in doc: [${starts}]`,
      );
    }
    const nl = md.indexOf('\n', entry.mdOffset);
    const mdLine =
      nl === -1 ? md.substring(entry.mdOffset) : md.substring(entry.mdOffset, nl);
    const stripped = stripMdMarkers(mdLine);
    if (stripped !== docText) {
      throw new Error(
        `Index map entry { mdOffset: ${entry.mdOffset}, docIndex: ${entry.docIndex} }: ` +
          `markdown line is ${JSON.stringify(mdLine)} ` +
          `(stripped: ${JSON.stringify(stripped)}) ` +
          `but doc paragraph has text ${JSON.stringify(docText)}`,
      );
    }
  }
}

describe('index map validation helpers', () => {
  it('validateIndexMap accepts a correctly built map', () => {
    const md = `# Title\n\nBody line.\n`;
    const { doc, indexMap } = buildDocAndMap(md, [
      { text: 'Title', mdOffset: 0 },
      { text: 'Body line.', mdOffset: 9 },
    ]);
    expect(() => validateIndexMap(md, doc, indexMap)).not.toThrow();
  });

  it('validateIndexMap throws when mdOffset points to the wrong text', () => {
    const md = `# Title\n\nBody line.\n`;
    const { doc } = buildDocAndMap(md, [
      { text: 'Title', mdOffset: 0 },
      { text: 'Body line.', mdOffset: 9 },
    ]);
    // Swap mdOffsets so the first entry now points at the body line.
    const bogus: IndexMapEntry[] = [
      { mdOffset: 9, docIndex: 1 },
      { mdOffset: 0, docIndex: 9 },
    ];
    expect(() => validateIndexMap(md, doc, bogus)).toThrow(/markdown line is/);
  });

  it('validateIndexMap throws when docIndex has no paragraph', () => {
    const md = `# Title\n\nBody.\n`;
    const { doc } = buildDocAndMap(md, [{ text: 'Title', mdOffset: 0 }]);
    expect(() =>
      validateIndexMap(md, doc, [{ mdOffset: 0, docIndex: 999 }]),
    ).toThrow(/no paragraph starts at docIndex 999/);
  });
});

describe('parseSections', () => {
  it('parses a document with no headings as a single section', () => {
    const md = 'Hello world\nSecond line\n';
    const sections = parseSections(md);

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBeNull();
    expect(sections[0].content).toBe('Hello world\nSecond line\n');
  });

  it('parses sections split by headings', () => {
    const md = `# Intro

Some text.

## Details

More text here.

## Conclusion

Final thoughts.
`;
    const sections = parseSections(md);

    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe('Intro');
    expect(sections[0].content).toContain('Some text.');
    expect(sections[1].heading).toBe('Details');
    expect(sections[1].content).toContain('More text here.');
    expect(sections[2].heading).toBe('Conclusion');
    expect(sections[2].content).toContain('Final thoughts.');
  });

  it('handles content before the first heading', () => {
    const md = `Preamble text.

# First Section

Content.
`;
    const sections = parseSections(md);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBeNull();
    expect(sections[0].content).toContain('Preamble text.');
    expect(sections[1].heading).toBe('First Section');
  });

  it('preserves heading line in section content', () => {
    const md = `# Title

Body.
`;
    const sections = parseSections(md);
    expect(sections[0].content).toContain('# Title');
  });

  it('handles various heading levels', () => {
    const md = `# H1

## H2

### H3
`;
    const sections = parseSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe('H1');
    expect(sections[1].heading).toBe('H2');
    expect(sections[2].heading).toBe('H3');
  });
});

describe('mergeDocuments', () => {
  it('returns theirs when agent made no changes', () => {
    const base = `# Intro

Hello.

# Details

Old details.
`;
    const ours = base; // agent didn't change anything
    const theirs = `# Intro

Hello updated by someone.

# Details

Old details.
`;
    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('Hello updated by someone.');
    expect(result.mergedMarkdown).not.toContain('Hello.');
  });

  it('returns ours when no one else changed the doc', () => {
    const base = `# Intro

Hello.

# Details

Old details.
`;
    const ours = `# Intro

Hello.

# Details

New details from agent.
`;
    const theirs = base; // no concurrent changes

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('New details from agent.');
  });

  it('merges non-overlapping changes from both sides', () => {
    const base = `# Intro

Hello.

# Details

Old details.
`;
    const ours = `# Intro

Hello.

# Details

Agent updated details.
`;
    const theirs = `# Intro

Someone updated intro.

# Details

Old details.
`;
    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('Someone updated intro.');
    expect(result.mergedMarkdown).toContain('Agent updated details.');
  });

  it('detects conflicts when both sides edit the same section', () => {
    const base = `# Intro

Original text.
`;
    const ours = `# Intro

Agent version of text.
`;
    const theirs = `# Intro

Human version of text.
`;
    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(true);
    expect(result.conflictSections.length).toBeGreaterThan(0);
    expect(result.conflictSections[0].heading).toBe('Intro');
  });

  it('includes conflict markers in merged output for conflicting sections', () => {
    const base = `# Section

Original.
`;
    const ours = `# Section

Ours.
`;
    const theirs = `# Section

Theirs.
`;
    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(true);
    expect(result.mergedMarkdown).toContain('<<<<<<<');
    expect(result.mergedMarkdown).toContain('=======');
    expect(result.mergedMarkdown).toContain('>>>>>>>');
  });

  it('handles section added by agent', () => {
    const base = `# Intro

Hello.
`;
    const ours = `# Intro

Hello.

# New Section

Added by agent.
`;
    const theirs = base;

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('# New Section');
    expect(result.mergedMarkdown).toContain('Added by agent.');
  });

  it('handles section added by others', () => {
    const base = `# Intro

Hello.
`;
    const ours = base;
    const theirs = `# Intro

Hello.

# Other Section

Added by human.
`;
    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('# Other Section');
    expect(result.mergedMarkdown).toContain('Added by human.');
  });

  it('handles section deleted by agent', () => {
    const base = `# Keep

Stays.

# Remove

Goes away.
`;
    const ours = `# Keep

Stays.
`;
    const theirs = base;

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('Stays.');
    expect(result.mergedMarkdown).not.toContain('Goes away.');
  });

  it('handles document with no headings (single section merge)', () => {
    const base = 'Original text.\n';
    const ours = 'Agent text.\n';
    const theirs = base;

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('Agent text.');
  });

  it('handles conflict in document with no headings', () => {
    const base = 'Original.\n';
    const ours = 'Agent version.\n';
    const theirs = 'Human version.\n';

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(true);
    expect(result.mergedMarkdown).toContain('<<<<<<<');
  });

  it('resolves conflicts via callback', async () => {
    const base = `# Section

Original.
`;
    const ours = `# Section

Ours.
`;
    const theirs = `# Section

Theirs.
`;
    const result = mergeDocuments(base, ours, theirs);
    expect(result.hasConflicts).toBe(true);

    // Simulate conflict resolution by stripping markers and choosing
    const resolved = result.mergedMarkdown
      .replace(/<<<<<<<\n/g, '')
      .replace(/=======\n/g, '')
      .replace(/>>>>>>>\n/g, '')
      .replace('Ours.\n', 'Combined resolution.\n')
      .replace('Theirs.\n', '');

    expect(resolved).toContain('Combined resolution.');
    expect(resolved).not.toContain('<<<<<<<');
  });

  it('correctly identifies which sections changed', () => {
    const base = `# A

Alpha.

# B

Beta.

# C

Charlie.
`;
    // Agent changes B only
    const ours = `# A

Alpha.

# B

Beta updated by agent.

# C

Charlie.
`;
    // Others change A and C
    const theirs = `# A

Alpha updated by human.

# B

Beta.

# C

Charlie updated by human.
`;
    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('Alpha updated by human.');
    expect(result.mergedMarkdown).toContain('Beta updated by agent.');
    expect(result.mergedMarkdown).toContain('Charlie updated by human.');
  });

  it('keeps agent changes when the same section was deleted by others', () => {
    // Agent modified section A. Concurrently, others deleted section A.
    // Current policy: agent's work survives (the edit "wins" over the delete).
    const base = `# A

Original.
`;
    const ours = `# A

Agent modified.
`;
    const theirs = ``;

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toContain('Agent modified.');
  });

  it('conflicts when both sides add a new section with the same heading', () => {
    const base = `# A

A body.
`;
    const ours = `# A

A body.

# B

B by agent.
`;
    const theirs = `# A

A body.

# B

B by human.
`;

    const result = mergeDocuments(base, ours, theirs);

    // Same heading added by both with different content — must conflict.
    expect(result.hasConflicts).toBe(true);
    expect(result.mergedMarkdown).toContain('<<<<<<<');
    expect(result.mergedMarkdown).toContain('>>>>>>>');
  });

  it('keeps conflict markers when the resolver callback leaves them in place', async () => {
    const base = `# S

Original.
`;
    const ours = `# S

Ours.
`;
    const theirs = `# S

Theirs.
`;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'S', mdOffset: 0 },
      { text: 'Original.', mdOffset: base.indexOf('Original.') },
    ]);

    // Resolver returns text that still includes the conflict markers — the
    // diff engine must treat this as unresolved and not silently accept it.
    const badResolver = async (conflictText: string) => conflictText;

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent', badResolver);

    expect(result.conflictsResolved).toBe(0);
  });

  it('section reordering by others alone is lost (merged keeps base order)', () => {
    // Current behaviour: alignSections walks base, then ours, then theirs,
    // so the first-seen order wins. When only `theirs` reorders, the
    // merged output still follows the base ordering.
    const base = `# A

A.

# B

B.
`;
    const ours = base;
    const theirs = `# B

B.

# A

A.
`;

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    const aIdx = result.mergedMarkdown.indexOf('# A');
    const bIdx = result.mergedMarkdown.indexOf('# B');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(bIdx);
  });
});

describe('computeDocDiff', () => {
  it('clamps deleteContentRange endIndex when changed line extends to body end', async () => {
    // Single paragraph that occupies the entire body — the delete range
    // for the changed line extends right up to bodyEndIndex and must be
    // clamped to bodyEndIndex - 1.
    const base = `Original.\n`;
    const ours = `Updated.\n`;
    const theirs = base;

    const { doc, indexMap, bodyEndIndex } = buildDocAndMap(base, [
      { text: 'Original.', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');

    expect(result.hasChanges).toBe(true);

    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();
    expect(deleteReq!.deleteContentRange!.range!.endIndex).toBeLessThanOrEqual(bodyEndIndex - 1);
  });

  it('does not clamp endIndex when section is not at body end', async () => {
    const base = `# First

Content A.

# Second

Content B.

# Third

Content C.
`;
    const ours = `# First

Updated A.

# Second

Content B.

# Third

Content C.
`;
    const theirs = base;

    const { doc, indexMap, bodyEndIndex } = buildDocAndMap(base, [
      { text: 'First', mdOffset: 0 },
      { text: 'Content A.', mdOffset: base.indexOf('Content A.') },
      { text: 'Second', mdOffset: base.indexOf('# Second') },
      { text: 'Content B.', mdOffset: base.indexOf('Content B.') },
      { text: 'Third', mdOffset: base.indexOf('# Third') },
      { text: 'Content C.', mdOffset: base.indexOf('Content C.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');

    expect(result.hasChanges).toBe(true);

    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();

    // The delete is in the First section, nowhere near body end, so no clamping.
    const endIndex = deleteReq!.deleteContentRange!.range!.endIndex!;
    expect(endIndex).toBeLessThan(bodyEndIndex - 1);
  });

  it('skips delete request when clamped range would be empty', async () => {
    // Doc body consists of just the trailing newline — a single empty
    // paragraph at indices [1, 2). When the delete is clamped down to
    // bodyEndIndex - 1, startIndex === endIndex and the delete is skipped.
    const base = `\n`;
    const ours = `New text.\n`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: '', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');

    // Should still have changes (insert requests), but no delete request.
    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeUndefined();
  });

  // ── Comment preservation tests ────────────────────────────────
  //
  // Principle: unchanged lines should never be deleted and re-inserted.
  // Google Docs comments are anchored to text ranges. If we delete text
  // that a comment is anchored to, the comment shows "Original content
  // deleted" even if we immediately re-insert identical text. The diff
  // engine must produce minimal deletes that only touch changed lines.

  it('does not delete unchanged heading when body is added beneath it', async () => {
    // Base doc has only the heading; ours adds content beneath it.
    // The heading paragraph should not be deleted — we expect a pure
    // append with no deleteContentRange requests at all.
    const base = `# A haiku about fruit\n`;
    const ours = `# A haiku about fruit

Green rind hides the sweet
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A haiku about fruit', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(0);
  });

  it('does not delete unchanged body when only one paragraph in the section changes', async () => {
    const base = `# Section

Paragraph one stays the same.

Paragraph two will change.

Paragraph three stays the same.
`;
    const ours = `# Section

Paragraph one stays the same.

Paragraph two has been updated by the agent.

Paragraph three stays the same.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Section', mdOffset: 0 },
      { text: 'Paragraph one stays the same.', mdOffset: base.indexOf('Paragraph one') },
      { text: 'Paragraph two will change.', mdOffset: base.indexOf('Paragraph two') },
      { text: 'Paragraph three stays the same.', mdOffset: base.indexOf('Paragraph three') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // Verify the delete SIZE matches only the changed paragraph, not the whole section.
    // "Paragraph two will change.\n" is 27 chars in the doc.
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(1);
    const delRange = deleteReqs[0].deleteContentRange!.range!;
    const deleteSize = delRange.endIndex! - delRange.startIndex!;
    expect(deleteSize).toBeLessThanOrEqual(30);
    expect(deleteSize).toBeGreaterThan(0);
  });

  it('does not delete any text when agent only appends to end of section', async () => {
    const base = `# Title

Existing content.
`;
    const ours = `# Title

Existing content.

New content added by agent.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Title', mdOffset: 0 },
      { text: 'Existing content.', mdOffset: base.indexOf('Existing content.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // Should have NO delete requests — only inserts.
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(0);
  });

  it('preserves text in other sections entirely', async () => {
    const base = `# Section A

Content A.

# Section B

Content B.
`;
    const ours = `# Section A

Content A.

# Section B

Updated content B.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Section A', mdOffset: 0 },
      { text: 'Content A.', mdOffset: base.indexOf('Content A.') },
      { text: 'Section B', mdOffset: base.indexOf('# Section B') },
      { text: 'Content B.', mdOffset: base.indexOf('Content B.') },
    ]);

    // Any delete must fall inside Section B (which starts at the doc
    // index of the Section B heading paragraph).
    const sectionBStart = indexMap.find((e) => e.mdOffset === base.indexOf('# Section B'))!.docIndex;

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    for (const req of result.requests) {
      if (req.deleteContentRange) {
        expect(req.deleteContentRange.range!.startIndex!).toBeGreaterThanOrEqual(sectionBStart);
      }
    }
  });

  it('inserts new content AFTER the heading, not before it', async () => {
    // Reproduces the bug: agent adds a haiku under an empty heading.
    // The insert must go after the heading paragraph, not at doc index 1.
    const base = `# A haiku about fruit\n`;
    const ours = `# A haiku about fruit

Green rind hides the prize
Sweet red flesh and scattered seeds
Summer's watermelon
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A haiku about fruit', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // The insert should go AFTER the heading (not at the section start, doc index 1).
    const insertReqs = result.requests.filter((r) => r.insertText);
    expect(insertReqs.length).toBeGreaterThan(0);
    for (const req of insertReqs) {
      expect(req.insertText!.location!.index).toBeGreaterThan(1);
    }

    // No delete should touch the heading.
    for (const req of result.requests) {
      if (req.deleteContentRange) {
        expect(req.deleteContentRange.range!.startIndex!).toBeGreaterThan(1);
      }
    }
  });

  it('inserted text starts on a new line, not merged into previous paragraph', async () => {
    // Bug: when appending after a heading, the inserted text had no leading
    // newline, causing it to merge into the heading paragraph.
    const base = `# A haiku about fruit\n`;
    const ours = `# A haiku about fruit

Green rind hides the sweet
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A haiku about fruit', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // The first insert must start with a newline to create a new paragraph.
    const insertReqs = result.requests.filter((r) => r.insertText);
    expect(insertReqs.length).toBeGreaterThan(0);
    const firstInsertText = insertReqs[0].insertText!.text!;
    expect(firstInsertText.startsWith('\n')).toBe(true);
  });

  it('deletes the full old line when replacing (no leftover characters)', async () => {
    // Bug: "Summer's watermelon" → "Summer's melon treat" left a stray "S".
    // The doc here mirrors how Google Docs stores a haiku-style block: the
    // heading and each verse land in their own paragraphs even though the
    // markdown separates the verses with single newlines.
    const base = `# A haiku about fruit

Green rind hides the sweet
Red flesh bursting
Summer's watermelon
`;
    const ours = `# A haiku about fruit

Green rind hides the sweet
Red flesh bursting
Summer's melon treat
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A haiku about fruit', mdOffset: 0 },
      { text: 'Green rind hides the sweet', mdOffset: base.indexOf('Green rind') },
      { text: 'Red flesh bursting', mdOffset: base.indexOf('Red flesh') },
      { text: "Summer's watermelon", mdOffset: base.indexOf("Summer's watermelon") },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // The delete SIZE should cover exactly the old line (~20 chars).
    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();
    const delSize =
      deleteReq!.deleteContentRange!.range!.endIndex! -
      deleteReq!.deleteContentRange!.range!.startIndex!;
    expect(delSize).toBeGreaterThanOrEqual(19);
    expect(delSize).toBeLessThanOrEqual(30);

    // The insert must contain the new text and start at the old line's position.
    const insertReqs = result.requests.filter((r) => r.insertText);
    const insertTexts = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertTexts).toContain("Summer's melon treat");
    const oldLineDocIndex = indexMap.find((e) => e.mdOffset === base.indexOf("Summer's watermelon"))!.docIndex;
    expect(insertReqs[0].insertText!.location!.index).toBe(oldLineDocIndex);
  });

  it('insert indices are valid after preceding deletes (no out-of-bounds)', async () => {
    // Bug: when the diff has multiple hunks, deletes shift indices and
    // subsequent inserts can reference positions that no longer exist.
    // Google Docs returns: "insertion index must be inside the bounds
    // of an existing paragraph."
    const base = `# Section

Line one.
Line two.
Line three.
`;
    const ours = `# Section

Line one MODIFIED.
Line two.
Line three MODIFIED.
New line four.
New line five.
`;
    const theirs = base;

    const { doc, indexMap, bodyEndIndex } = buildDocAndMap(base, [
      { text: 'Section', mdOffset: 0 },
      { text: 'Line one.', mdOffset: base.indexOf('Line one.') },
      { text: 'Line two.', mdOffset: base.indexOf('Line two.') },
      { text: 'Line three.', mdOffset: base.indexOf('Line three.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    for (const req of result.requests) {
      if (req.insertText) {
        const idx = req.insertText.location!.index!;
        expect(idx).toBeGreaterThanOrEqual(1);
        expect(idx).toBeLessThan(bodyEndIndex);
      }
      if (req.deleteContentRange) {
        const start = req.deleteContentRange.range!.startIndex!;
        const end = req.deleteContentRange.range!.endIndex!;
        expect(start).toBeGreaterThanOrEqual(1);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThan(bodyEndIndex);
      }
    }
  });
});

describe('computeDocDiff › structural edits', () => {
  it('deletes an entire section when the agent drops it', async () => {
    const base = `# A

A body.

# B

B body.
`;
    const ours = `# A

A body.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A', mdOffset: 0 },
      { text: 'A body.', mdOffset: base.indexOf('A body.') },
      { text: 'B', mdOffset: base.indexOf('# B') },
      { text: 'B body.', mdOffset: base.indexOf('B body.') },
    ]);

    const sectionBStart = indexMap.find((e) => e.mdOffset === base.indexOf('# B'))!.docIndex;

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs.length).toBeGreaterThan(0);
    // Delete must start inside section B (or on the separator paragraph
    // immediately preceding it), not inside section A's body.
    for (const req of deleteReqs) {
      expect(req.deleteContentRange!.range!.startIndex!).toBeGreaterThanOrEqual(sectionBStart - 2);
    }

    // No B-body text should be re-inserted (pure deletion, not a rewrite).
    const insertReqs = result.requests.filter((r) => r.insertText);
    const insertedText = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertedText).not.toContain('B body.');
  });

  it('inserts a new mid-doc section between its neighbours, not at the tail', async () => {
    const base = `# A

A.

# C

C.
`;
    const ours = `# A

A.

# B

B inserted.

# C

C.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A', mdOffset: 0 },
      { text: 'A.', mdOffset: base.indexOf('A.') },
      { text: 'C', mdOffset: base.indexOf('# C') },
      { text: 'C.', mdOffset: base.indexOf('C.') },
    ]);

    // `C` heading starts at this doc index in the fake doc. The new section B
    // must be inserted at or before that position.
    const sectionCStart = indexMap.find((e) => e.mdOffset === base.indexOf('# C'))!.docIndex;

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const insertReqs = result.requests.filter((r) => r.insertText);
    const insertedText = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertedText).toContain('B inserted.');

    // The primary insertion anchor is at or before Section C's start.
    // (Follow-up inserts in the same batch chain off that anchor, so
    // their raw indices are allowed to shift forward.)
    const firstInsertIdx = insertReqs[0].insertText!.location!.index!;
    expect(firstInsertIdx).toBeLessThanOrEqual(sectionCStart);
    // And no insert is at the body-end tail.
    const bodyEndIndex = doc.body!.content![doc.body!.content!.length - 1].endIndex!;
    for (const req of insertReqs) {
      expect(req.insertText!.location!.index!).toBeLessThan(bodyEndIndex - 1);
    }
  });

  it('detects a heading-level change as a content edit', async () => {
    // alignSections keys on heading TEXT, so `# A` → `## A` is treated as
    // "same section, content changed". Expect the diff to rewrite the
    // heading line.
    const base = `# A

Content.
`;
    const ours = `## A

Content.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A', mdOffset: 0 },
      { text: 'Content.', mdOffset: base.indexOf('Content.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    const insertReqs = result.requests.filter((r) => r.insertText);
    expect(deleteReqs.length).toBeGreaterThan(0);
    expect(insertReqs.length).toBeGreaterThan(0);

    // The heading text (plain "A") was not deleted — only the '#' marker
    // changed in markdown, but the diff still reissues the heading line.
    const insertedText = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertedText.toLowerCase()).toContain('a');
  });

  it('edits a null-heading preamble without touching the following section', async () => {
    const base = `Preamble.

# Section

Content.
`;
    const ours = `Updated preamble.

# Section

Content.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Preamble.', mdOffset: 0 },
      { text: 'Section', mdOffset: base.indexOf('# Section') },
      { text: 'Content.', mdOffset: base.indexOf('Content.') },
    ]);

    const sectionDocStart = indexMap.find((e) => e.mdOffset === base.indexOf('# Section'))!.docIndex;

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // Any delete must stay inside the preamble range [1, sectionDocStart).
    for (const req of result.requests) {
      if (req.deleteContentRange) {
        expect(req.deleteContentRange.range!.endIndex!).toBeLessThanOrEqual(sectionDocStart);
      }
    }

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Updated preamble.');
  });

  it('preserves both occurrences when duplicate heading text is present', () => {
    const base = `# Notes

First.

# Notes

Second.
`;
    const ours = `# Notes

First updated.

# Notes

Second.
`;
    const theirs = base;

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    // The first section's body was updated.
    expect(result.mergedMarkdown).toContain('First updated.');
    // The second section must survive — it must not be silently dropped.
    expect(result.mergedMarkdown).toContain('Second.');
    // Both heading occurrences preserved, in original order.
    const firstIdx = result.mergedMarkdown.indexOf('First updated.');
    const secondIdx = result.mergedMarkdown.indexOf('Second.');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('adds a body to an empty (heading-only) section', async () => {
    const base = `# A

# B

Body B.
`;
    const ours = `# A

Content A.

# B

Body B.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A', mdOffset: 0 },
      { text: 'B', mdOffset: base.indexOf('# B') },
      { text: 'Body B.', mdOffset: base.indexOf('Body B.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Content A.');

    // Body B. must not get deleted along the way.
    const bodyBDocIndex = indexMap.find((e) => e.mdOffset === base.indexOf('Body B.'))!.docIndex;
    for (const req of result.requests) {
      if (req.deleteContentRange) {
        const r = req.deleteContentRange.range!;
        // The delete shouldn't swallow Body B (which starts at bodyBDocIndex).
        expect(r.endIndex!).toBeLessThanOrEqual(bodyBDocIndex + 7 /* len("Body B.") */);
      }
    }
  });
});

describe('computeDocDiff › content shape', () => {
  it('edits one item in a bullet list without touching the others', async () => {
    const base = `- Item 1
- Item 2
- Item 3
`;
    const ours = `- Item 1
- Item 2 updated
- Item 3
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Item 1', mdOffset: 0 },
      { text: 'Item 2', mdOffset: base.indexOf('- Item 2') },
      { text: 'Item 3', mdOffset: base.indexOf('- Item 3') },
    ]);

    const item2Start = indexMap[1].docIndex;

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    // Exactly one delete — the Item 2 line.
    expect(deleteReqs).toHaveLength(1);
    const delStart = deleteReqs[0].deleteContentRange!.range!.startIndex!;
    const delEnd = deleteReqs[0].deleteContentRange!.range!.endIndex!;
    expect(delStart).toBe(item2Start);
    expect(delEnd - delStart).toBeLessThanOrEqual(10); // ~"Item 2\n"

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Item 2 updated');
  });

  it('parseSections does NOT split on "#" lines that are inside a fenced code block', () => {
    const md = `# Real heading

\`\`\`
# Not a heading
print('hi')
\`\`\`
`;
    const sections = parseSections(md);
    // Exactly one section: the fenced-code-block line is body content,
    // not a heading.
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Real heading');
    expect(sections.some((s) => s.heading === 'Not a heading')).toBe(false);
    // The fence content is preserved inside the single section.
    expect(sections[0].content).toContain('# Not a heading');
    expect(sections[0].content).toContain("print('hi')");
  });

  it('rewrites a changed row in a markdown table (line-level diff)', async () => {
    // The diff engine treats every markdown line as independent, so editing
    // a single cell rewrites the whole row. This test just confirms the
    // machinery survives the table characters.
    const base = `| col1 | col2 |
|------|------|
| a    | b    |
| c    | d    |
`;
    const ours = `| col1 | col2 |
|------|------|
| a    | b    |
| c    | D!   |
`;
    const theirs = base;

    // `base.indexOf('| c')` would wrongly match `| col1`, so compute
    // offsets from line boundaries directly.
    const lineStart = (line: string) => {
      const idx = base.indexOf(line);
      if (idx === -1) throw new Error(`line not found: ${line}`);
      return idx;
    };
    const { doc, indexMap } = buildDocAndMap(base, [
      { text: '| col1 | col2 |', mdOffset: lineStart('| col1') },
      { text: '|------|------|', mdOffset: lineStart('|------') },
      { text: '| a    | b    |', mdOffset: lineStart('| a    |') },
      { text: '| c    | d    |', mdOffset: lineStart('| c    |') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('D!');
  });

  it('handles inline formatting where markdown length ≠ rendered length', async () => {
    // Doc text has "This is bold text." while markdown has "**bold**".
    // The index map is validated against the rendered text (the validator
    // strips `**…**`), and the diff still produces sensible requests.
    const base = `This is **bold** text.\n`;
    const ours = `This is **extremely bold** text.\n`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'This is bold text.', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('extremely');
  });

  it('handles CJK (Japanese) text without offset corruption', async () => {
    const base = `# 日本語

内容。
`;
    const ours = `# 日本語

新しい内容。
`;
    const theirs = base;

    const { doc, indexMap, bodyEndIndex } = buildDocAndMap(base, [
      { text: '日本語', mdOffset: 0 },
      { text: '内容。', mdOffset: base.indexOf('内容。') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // All requests must reference valid doc indices.
    for (const req of result.requests) {
      if (req.insertText) {
        expect(req.insertText.location!.index!).toBeGreaterThanOrEqual(1);
        expect(req.insertText.location!.index!).toBeLessThanOrEqual(bodyEndIndex);
      }
      if (req.deleteContentRange) {
        expect(req.deleteContentRange.range!.endIndex!).toBeLessThanOrEqual(bodyEndIndex);
      }
    }

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('新しい内容');
  });
});

describe('computeDocDiff › whitespace edge cases', () => {
  it('treats a trailing-newline-only change as no-op', async () => {
    const base = `# A

Content.
`;
    const ours = `# A

Content.

`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A', mdOffset: 0 },
      { text: 'Content.', mdOffset: base.indexOf('Content.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(false);
    expect(result.requests).toHaveLength(0);
  });

  it('inserts a new blank line when agent spaces paragraphs apart', async () => {
    const base = `Line 1.
Line 2.
`;
    const ours = `Line 1.

Line 2.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Line 1.', mdOffset: 0 },
      { text: 'Line 2.', mdOffset: base.indexOf('Line 2.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // Exactly one insert, issuing a '\n' to break Line 1 and Line 2 apart.
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(0);
    const insertReqs = result.requests.filter((r) => r.insertText);
    expect(insertReqs.length).toBeGreaterThan(0);
    // The inserted text must include a newline (paragraph break).
    const insertedText = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertedText).toContain('\n');
  });

  it('diff survives markdown with no trailing newline', async () => {
    const base = `# A

Content.`; // no trailing \n
    const ours = `# A

Updated.`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base + '\n', [
      // Pad the md with '\n' for buildDocAndMap's validator, but feed the
      // actual unterminated string to computeDocDiff below.
      { text: 'A', mdOffset: 0 },
      { text: 'Content.', mdOffset: base.indexOf('Content.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Updated.');
  });
});

describe('computeDocDiff › diff hunk boundaries', () => {
  it('adjacent hunks do not produce overlapping delete ranges', async () => {
    const base = `Line 1.
Line 2.
Line 3.
`;
    const ours = `New1.
New2.
Line 3.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Line 1.', mdOffset: 0 },
      { text: 'Line 2.', mdOffset: base.indexOf('Line 2.') },
      { text: 'Line 3.', mdOffset: base.indexOf('Line 3.') },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');

    // Collect all delete ranges and confirm none overlap.
    const ranges = result.requests
      .filter((r) => r.deleteContentRange)
      .map((r) => r.deleteContentRange!.range!);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i];
        const b = ranges[j];
        const overlap = a.startIndex! < b.endIndex! && b.startIndex! < a.endIndex!;
        expect(overlap).toBe(false);
      }
    }
  });

  it('pure prepend at document start inserts before existing content', async () => {
    const base = `Existing.\n`;
    const ours = `Prepended.

Existing.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Existing.', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // No delete — existing content stays put; only inserts are issued.
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(0);

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Prepended.');
  });

  it('shorter replacement: long line becomes short', async () => {
    const base = `This is a very long line that should become short.\n`;
    const ours = `Short.\n`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'This is a very long line that should become short.', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs.length).toBeGreaterThan(0);
    const delSize =
      deleteReqs[0].deleteContentRange!.range!.endIndex! -
      deleteReqs[0].deleteContentRange!.range!.startIndex!;
    expect(delSize).toBeGreaterThanOrEqual(50); // long line + '\n' ≈ 51 chars

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Short.');
  });

  it('longer replacement: short line becomes long', async () => {
    const base = `Short.\n`;
    const ours = `This is a much longer line than before.\n`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Short.', mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs.length).toBeGreaterThan(0);
    const delSize =
      deleteReqs[0].deleteContentRange!.range!.endIndex! -
      deleteReqs[0].deleteContentRange!.range!.startIndex!;
    expect(delSize).toBeLessThanOrEqual(10); // "Short.\n" is 7 chars, allow a little slack

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('much longer');
  });
});

describe('computeDocDiff › sparse index map', () => {
  it('handles a doc with many paragraphs but few index map entries', async () => {
    // The real-world index map has one entry per paragraph, but Google
    // Docs' /batchUpdate path only stores the index map from the last
    // doc fetch, so we occasionally end up interpolating across many
    // un-indexed paragraphs. This test mimics that sparse scenario.
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i}.`);
    const base = paras.join('\n\n') + '\n';
    const ours = base.replace('Paragraph number 7.', 'Paragraph seven modified.');
    const theirs = base;

    // Only index paragraphs 0, 5, and 9 — let interpolation carry the rest.
    const { doc, indexMap, bodyEndIndex } = buildDocAndMap(
      base,
      paras.map((text, i) => {
        const indexed = i === 0 || i === 5 || i === 9;
        return indexed ? { text, mdOffset: base.indexOf(text) } : { text };
      }),
    );

    expect(indexMap).toHaveLength(3); // sparse by construction

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // All requests must reference valid doc indices.
    for (const req of result.requests) {
      if (req.insertText) {
        const idx = req.insertText.location!.index!;
        expect(idx).toBeGreaterThanOrEqual(1);
        expect(idx).toBeLessThan(bodyEndIndex);
      }
      if (req.deleteContentRange) {
        const start = req.deleteContentRange.range!.startIndex!;
        const end = req.deleteContentRange.range!.endIndex!;
        expect(start).toBeGreaterThanOrEqual(1);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThan(bodyEndIndex);
      }
    }

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Paragraph seven modified.');
  });
});

describe('interpolateDocIndex', () => {
  it('returns fallback when index map is empty', () => {
    expect(interpolateDocIndex(100, [], 999)).toBe(999);
  });

  it('returns exact match when mdOffset matches an entry exactly', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 50, docIndex: 40 },
      { mdOffset: 100, docIndex: 80 },
    ];
    expect(interpolateDocIndex(50, indexMap, 999)).toBe(40);
  });

  it('returns near match when within 5 chars of an entry', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 50, docIndex: 40 },
      { mdOffset: 100, docIndex: 80 },
    ];
    // 3 chars away from entry at mdOffset=50 — should snap to docIndex=40
    expect(interpolateDocIndex(53, indexMap, 999)).toBe(40);
    expect(interpolateDocIndex(47, indexMap, 999)).toBe(40);
  });

  it('interpolates between two bracketing entries', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 100, docIndex: 80 },
    ];
    // mdOffset 50 is halfway between 0 and 100
    // Expected: 1 + 0.5 * (80 - 1) = 1 + 39.5 = 40.5 → 41 (rounded)
    expect(interpolateDocIndex(50, indexMap, 999)).toBe(41);
  });

  it('interpolates correctly with high formatting drift', () => {
    // Simulates a doc with lots of markdown formatting:
    // markdown is 2x the doc content due to ** , ## , links, etc.
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 200, docIndex: 100 },  // drift = 100
      { mdOffset: 400, docIndex: 200 },  // drift = 200
      { mdOffset: 600, docIndex: 300 },  // drift = 300
    ];

    // Between entries at 200 and 400:
    // mdOffset 300 is halfway, expected: 100 + 0.5 * (200-100) = 150
    expect(interpolateDocIndex(300, indexMap, 999)).toBe(150);

    // mdOffset 500 is between 400 and 600:
    // expected: 200 + 0.5 * (300-200) = 250
    expect(interpolateDocIndex(500, indexMap, 999)).toBe(250);
  });

  it('does NOT use 1:1 mapping (the old bug)', () => {
    // This is the exact scenario that caused the original crash.
    // With 1:1 interpolation: preceding.docIndex + (mdOffset - preceding.mdOffset)
    // = 300 + (600 - 400) = 500, which would exceed bodyEndIndex of 350.
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 200, docIndex: 100 },
      { mdOffset: 400, docIndex: 200 },
      { mdOffset: 600, docIndex: 300 },
    ];
    const bodyEnd = 350;

    // mdOffset 590 is between 400 and 600
    // Old (broken): 200 + (590 - 400) = 390 > 350 ← OUT OF BOUNDS
    // New (correct): 200 + (590-400)/(600-400) * (300-200) = 200 + 95 = 295
    const result = interpolateDocIndex(590, indexMap, bodyEnd);
    expect(result).toBeLessThanOrEqual(bodyEnd);
    expect(result).toBe(295);
  });

  it('extrapolates past the last entry using local ratio', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 100, docIndex: 80 },
      { mdOffset: 200, docIndex: 160 },
    ];
    // Past last entry: ratio from last two entries = (160-80)/(200-100) = 0.8
    // Expected: 160 + (250 - 200) * 0.8 = 160 + 40 = 200
    expect(interpolateDocIndex(250, indexMap, 999)).toBe(200);
  });

  it('clamps extrapolation to fallback (bodyEndIndex)', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 100, docIndex: 80 },
      { mdOffset: 200, docIndex: 160 },
    ];
    const bodyEnd = 180;
    // Expected: 160 + (250 - 200) * 0.8 = 200, clamped to 180
    expect(interpolateDocIndex(250, indexMap, bodyEnd)).toBe(bodyEnd);
  });

  it('handles single entry — extrapolation before', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 100, docIndex: 80 },
    ];
    // Before the only entry: 80 - (100 - 50) = 30
    expect(interpolateDocIndex(50, indexMap, 999)).toBe(30);
  });

  it('handles single entry — extrapolation after', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 100, docIndex: 80 },
    ];
    // After the only entry with no second entry for ratio:
    // Falls back to 1:1 offset from preceding, clamped to fallback
    // 80 + (150 - 100) = 130
    expect(interpolateDocIndex(150, indexMap, 999)).toBe(130);
  });

  it('clamps backward extrapolation to minimum of 1', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 100, docIndex: 10 },
    ];
    // 10 - (100 - 0) = -90, clamped to 1
    expect(interpolateDocIndex(0, indexMap, 999)).toBe(1);
  });

  it('quarter-point interpolation is accurate', () => {
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 100, docIndex: 51 },  // ratio = 0.5
    ];
    // At mdOffset 25: 1 + 0.25 * (51-1) = 1 + 12.5 = 13.5 → 14
    expect(interpolateDocIndex(25, indexMap, 999)).toBe(14);
    // At mdOffset 75: 1 + 0.75 * (51-1) = 1 + 37.5 = 38.5 → 39
    expect(interpolateDocIndex(75, indexMap, 999)).toBe(39);
  });

  it('handles entries with varying drift rates', () => {
    // First region: heavy formatting (3:1 ratio), second region: light (1.2:1)
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 300, docIndex: 100 },   // heavy formatting region
      { mdOffset: 420, docIndex: 200 },   // light formatting region
    ];
    // In heavy region (0-300): mdOffset 150 → 1 + 0.5 * (100-1) = 50.5 → 51
    expect(interpolateDocIndex(150, indexMap, 999)).toBe(51);
    // In light region (300-420): mdOffset 360 → 100 + 0.5 * (200-100) = 150
    expect(interpolateDocIndex(360, indexMap, 999)).toBe(150);
  });

  it('regression: real-world doc drift produces valid indices', () => {
    // Simulates the actual production scenario from the bug report:
    // Document body ends at 28629, markdown is ~30K+ chars, drift ~1764
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 5000, docIndex: 4500 },
      { mdOffset: 10000, docIndex: 8800 },
      { mdOffset: 15000, docIndex: 13000 },
      { mdOffset: 20000, docIndex: 17000 },
      { mdOffset: 25000, docIndex: 21000 },
      { mdOffset: 30000, docIndex: 25000 },
      { mdOffset: 31800, docIndex: 26400 },
    ];
    const bodyEnd = 28629;

    // At mdOffset 33000 (past all entries), should not exceed bodyEnd
    const result = interpolateDocIndex(33000, indexMap, bodyEnd);
    expect(result).toBeLessThanOrEqual(bodyEnd);

    // At mdOffset 31000, between last two entries:
    // ratio from 30000→31800: (26400-25000)/(31800-30000) = 1400/1800 ≈ 0.778
    // 25000 + (31000-30000) * 0.778 = 25000 + 778 = 25778
    const mid = interpolateDocIndex(31000, indexMap, bodyEnd);
    expect(mid).toBe(25778);
    expect(mid).toBeLessThan(bodyEnd);
  });
});
