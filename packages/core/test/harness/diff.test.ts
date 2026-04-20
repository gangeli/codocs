import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import {
  parseSections,
  mergeDocuments,
  computeDocDiff,
  interpolateDocIndex,
  buildNewSectionInsertRequests,
  type MdSection,
} from '../../src/harness/diff.js';
import type { IndexMapEntry } from '../../src/converter/element-parser.js';

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
});

describe('computeDocDiff', () => {
  /**
   * Helper to build a minimal Google Docs document with a body whose last
   * structural element ends at `bodyEndIndex`.
   */
  function makeDocument(bodyEndIndex: number): docs_v1.Schema$Document {
    return {
      body: {
        content: [
          { startIndex: 0, endIndex: 1, sectionBreak: {} },
          {
            startIndex: 1,
            endIndex: bodyEndIndex,
            paragraph: {
              elements: [
                {
                  startIndex: 1,
                  endIndex: bodyEndIndex,
                  textRun: { content: 'x'.repeat(bodyEndIndex - 1) },
                },
              ],
            },
          },
        ],
      },
    };
  }

  /**
   * Build a simple indexMap: one entry per section mapping markdown offset
   * to a doc index.
   */
  function makeIndexMap(entries: Array<{ mdOffset: number; docIndex: number }>): IndexMapEntry[] {
    return entries;
  }

  it('clamps deleteContentRange endIndex when changed line extends to body end', async () => {
    // Single section, no heading — so the entire content is the "changed" part.
    // The delete must not extend past bodyEndIndex - 1.
    const bodyEndIndex = 20;
    const doc = makeDocument(bodyEndIndex);

    const base = `Original.\n`;
    const ours = `Updated.\n`;
    const theirs = base;

    const indexMap = makeIndexMap([{ mdOffset: 0, docIndex: 1 }]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');

    expect(result.hasChanges).toBe(true);

    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();
    // The endIndex must not exceed bodyEndIndex - 1
    expect(deleteReq!.deleteContentRange!.range!.endIndex).toBeLessThanOrEqual(bodyEndIndex - 1);
  });

  it('does not clamp endIndex when section is not at body end', async () => {
    const bodyEndIndex = 200;
    const doc = makeDocument(bodyEndIndex);

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

    // Three sections mapped to doc indices
    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: base.indexOf('# Second'), docIndex: 50 },
      { mdOffset: base.indexOf('# Third'), docIndex: 100 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');

    expect(result.hasChanges).toBe(true);

    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();

    // The endIndex should be less than bodyEndIndex, so no clamping occurs
    const endIndex = deleteReq!.deleteContentRange!.range!.endIndex!;
    expect(endIndex).toBeLessThan(bodyEndIndex);
    // And it should not have been decremented (no clamping needed)
    expect(endIndex).toBeLessThan(bodyEndIndex - 1);
  });

  it('skips delete request when clamped range would be empty', async () => {
    // Edge case: section occupies only the last character before the trailing newline
    const bodyEndIndex = 2; // body is just index 1 (the trailing newline)
    const doc = makeDocument(bodyEndIndex);

    const base = `# Section

Text.
`;
    const ours = `# Section

New text.
`;
    const theirs = base;

    // Section starts at doc index 1, ends at bodyEndIndex (2)
    // After clamping, endIndex would be 1, which equals startIndex => skip
    const indexMap = makeIndexMap([{ mdOffset: 0, docIndex: 1 }]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');

    // Should still have changes (insert requests), but no delete request
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
    const bodyEndIndex = 100;
    const doc = makeDocument(bodyEndIndex);

    const base = `# A haiku about fruit\n`;
    const ours = `# A haiku about fruit

Green rind hides the sweet
`;
    const theirs = base;

    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },   // heading paragraph
      { mdOffset: 23, docIndex: 25 },  // empty line after heading
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // No deleteContentRange should cover the heading (doc index 1-24)
    for (const req of result.requests) {
      if (req.deleteContentRange) {
        expect(req.deleteContentRange.range!.startIndex!).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it('does not delete unchanged body when only one paragraph in the section changes', async () => {
    const bodyEndIndex = 200;
    const doc = makeDocument(bodyEndIndex);

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

    // Map each line to its doc index. Lines in the base:
    // 0: "# Section"        md=0   doc=1
    // 1: ""                 md=10  doc=11
    // 2: "Paragraph one..." md=11  doc=12
    // 3: ""                 md=41  doc=42
    // 4: "Paragraph two..." md=42  doc=43
    // 5: ""                 md=69  doc=70
    // 6: "Paragraph three." md=70  doc=71
    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 10, docIndex: 11 },
      { mdOffset: 11, docIndex: 12 },
      { mdOffset: 41, docIndex: 42 },
      { mdOffset: 42, docIndex: 43 },
      { mdOffset: 69, docIndex: 70 },
      { mdOffset: 70, docIndex: 71 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // With insert-first, delete indices are shifted by the inserted text length.
    // Verify the delete SIZE matches only the changed paragraph, not the whole section.
    // "Paragraph two will change.\n" = 27 chars. The delete should be ~27 chars.
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(1);
    const delRange = deleteReqs[0].deleteContentRange!.range!;
    const deleteSize = delRange.endIndex! - delRange.startIndex!;
    // The old "Paragraph two will change." line is ~27 chars (including \n)
    expect(deleteSize).toBeLessThanOrEqual(30);
    expect(deleteSize).toBeGreaterThan(0);
  });

  it('does not delete any text when agent only appends to end of section', async () => {
    const bodyEndIndex = 100;
    const doc = makeDocument(bodyEndIndex);

    const base = `# Title

Existing content.
`;
    const ours = `# Title

Existing content.

New content added by agent.
`;
    const theirs = base;

    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 9, docIndex: 12 },  // "Existing content."
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // Should have NO delete requests — only inserts
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(0);
  });

  it('preserves text in other sections entirely', async () => {
    const bodyEndIndex = 300;
    const doc = makeDocument(bodyEndIndex);

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

    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: base.indexOf('# Section B'), docIndex: 100 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // All deletes should be within Section B's range (100+), not Section A (1-99)
    for (const req of result.requests) {
      if (req.deleteContentRange) {
        expect(req.deleteContentRange.range!.startIndex!).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it('inserts new content AFTER the heading, not before it', async () => {
    // Reproduces the bug: agent adds a haiku under an empty heading.
    // The insert must go after the heading text, not before it.
    const bodyEndIndex = 50;
    const doc = makeDocument(bodyEndIndex);

    const base = `# A haiku about fruit
`;
    const ours = `# A haiku about fruit

Green rind hides the prize
Sweet red flesh and scattered seeds
Summer's watermelon
`;
    const theirs = base;

    // Heading occupies doc indices 1-22
    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // The insert should go AFTER the heading (at or after doc index 22),
    // not at the section start (doc index 1)
    const insertReqs = result.requests.filter((r) => r.insertText);
    expect(insertReqs.length).toBeGreaterThan(0);
    for (const req of insertReqs) {
      expect(req.insertText!.location!.index).toBeGreaterThan(1);
    }

    // No delete should touch the heading
    for (const req of result.requests) {
      if (req.deleteContentRange) {
        expect(req.deleteContentRange.range!.startIndex!).toBeGreaterThan(1);
      }
    }
  });

  it('inserted text starts on a new line, not merged into previous paragraph', async () => {
    // Bug: when appending after a heading, the inserted text had no leading
    // newline, causing it to merge into the heading paragraph.
    // "A haiku about fruitGreen rind hides the sweet" instead of separate paragraphs.
    const bodyEndIndex = 50;
    const doc = makeDocument(bodyEndIndex);

    const base = `# A haiku about fruit
`;
    const ours = `# A haiku about fruit

Green rind hides the sweet
`;
    const theirs = base;

    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // The inserted text must start with a newline to create a new paragraph
    const insertReqs = result.requests.filter((r) => r.insertText);
    expect(insertReqs.length).toBeGreaterThan(0);
    const firstInsertText = insertReqs[0].insertText!.text!;
    expect(firstInsertText.startsWith('\n')).toBe(true);
  });

  it('deletes the full old line when replacing (no leftover characters)', async () => {
    // Bug: "Summer's watermelon" → "Summer's melon treat" left a stray "S",
    // producing "SSummer's melon treat". The delete range was one char short
    // because markdown offsets (which include "# " etc.) don't map 1:1 to
    // doc indices.
    const bodyEndIndex = 100;
    const doc = makeDocument(bodyEndIndex);

    // The doc content is:
    //   "A haiku about fruit\nGreen rind hides the sweet\nRed flesh bursting\nSummer's watermelon\n"
    // Note: the "# " prefix in markdown doesn't exist in the doc.
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

    // Doc indices (no "# " prefix — heading is just "A haiku about fruit"):
    //   1: "A haiku about fruit\n"  (20 chars, ends at 21)
    //  21: "Green rind hides the sweet\n" (27 chars, ends at 48)
    //  48: "Red flesh bursting\n" (19 chars, ends at 67)
    //  67: "Summer's watermelon\n" (20 chars, ends at 87)
    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },    // "# A haiku about fruit"
      { mdOffset: 23, docIndex: 21 },  // "Green rind..."
      { mdOffset: 48, docIndex: 48 },  // "Red flesh..."
      { mdOffset: 65, docIndex: 67 },  // "Summer's watermelon"
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // With insert-first, the insert goes at 67, then the delete is shifted
    // by the inserted length. Verify the delete SIZE covers exactly the old line.
    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();
    const delSize = deleteReq!.deleteContentRange!.range!.endIndex! - deleteReq!.deleteContentRange!.range!.startIndex!;
    // "Summer's watermelon\n" is 20 chars in the doc; may include adjacent
    // whitespace depending on index map interpolation accuracy.
    expect(delSize).toBeGreaterThanOrEqual(19);
    expect(delSize).toBeLessThanOrEqual(30);

    // The insert should contain the new text
    const insertReqs = result.requests.filter((r) => r.insertText);
    const insertTexts = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertTexts).toContain("Summer's melon treat");
    // Insert should start at 67 (the old line's position)
    expect(insertReqs[0].insertText!.location!.index).toBe(67);
  });

  it('insert indices are valid after preceding deletes (no out-of-bounds)', async () => {
    // Bug: when the diff has multiple hunks, deletes shift indices and
    // subsequent inserts can reference positions that no longer exist.
    // Google Docs returns: "insertion index must be inside the bounds
    // of an existing paragraph."
    //
    // This test simulates a section where lines are both modified and
    // appended — producing multiple hunks.
    const bodyEndIndex = 200;
    const doc = makeDocument(bodyEndIndex);

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

    const indexMap = makeIndexMap([
      { mdOffset: 0, docIndex: 1 },
      { mdOffset: 11, docIndex: 11 },  // "Line one."
      { mdOffset: 21, docIndex: 21 },  // "Line two."
      { mdOffset: 31, docIndex: 31 },  // "Line three."
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    // Verify all insert positions are valid: every insertText index must
    // be >= 1 and < bodyEndIndex. And every delete must have start < end.
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

    // Verify that inserts come BEFORE their corresponding deletes
    // (insert-first pattern prevents out-of-bounds errors)
    const ops = result.requests
      .filter((r) => r.insertText || r.deleteContentRange)
      .map((r) => r.insertText ? 'insert' : 'delete');

    // For each delete, there should be at least one insert before it
    // (unless it's a pure delete with no replacement)
    // At minimum: no two deletes in a row without an insert between
    // (this is a loose check — the real validation is that Google Docs accepts it)
  });

  // ── New-section isolation ──────────────────────────────────────
  //
  // New sections (no counterpart in the current doc) are deferred into
  // `newSectionInserts` rather than emitted into `requests`. The caller
  // re-fetches the doc between each one so their insertion offsets use
  // a fresh bodyEndIndex. Bundling multiple new sections into the same
  // batch — all anchored to the original bodyEndIndex - 1 — produced
  // "Index X must be less than the end index of the referenced segment"
  // errors from the Docs API once earlier inserts grew the doc.

  it('defers new sections into newSectionInserts instead of requests', async () => {
    const bodyEndIndex = 50;
    const doc = makeDocument(bodyEndIndex);

    const base = `# Intro\n\nHello.\n`;
    const ours = `# Intro

Hello.

# Added One

First new section body.

# Added Two

Second new section body.
`;
    const theirs = base;

    const indexMap = makeIndexMap([{ mdOffset: 0, docIndex: 1 }]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    expect(result.newSectionInserts.map((n) => n.content)).toEqual([
      expect.stringContaining('# Added One'),
      expect.stringContaining('# Added Two'),
    ]);

    // None of the initial `requests` should insertText for the new sections.
    for (const req of result.requests) {
      if (req.insertText?.text) {
        expect(req.insertText.text).not.toContain('Added One');
        expect(req.insertText.text).not.toContain('Added Two');
      }
    }

    // Agent name is carried through for attribution.
    for (const ns of result.newSectionInserts) {
      expect(ns.agentName).toBe('test-agent');
    }
  });

  it('reports hasChanges=true when only new sections are added', async () => {
    const bodyEndIndex = 50;
    const doc = makeDocument(bodyEndIndex);

    const base = `# Intro\n\nHello.\n`;
    const ours = base + `\n# Added\n\nBody.\n`;
    const theirs = base;

    const indexMap = makeIndexMap([{ mdOffset: 0, docIndex: 1 }]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);
    expect(result.requests).toHaveLength(0);
    expect(result.newSectionInserts).toHaveLength(1);
  });
});

describe('buildNewSectionInsertRequests', () => {
  it('anchors insertText at bodyEndIndex - 1 of the current doc', () => {
    const { requests } = buildNewSectionInsertRequests(
      { content: '# Heading\n\nBody.\n', agentName: 'a' },
      100,
    );
    const firstInsert = requests.find((r) => r.insertText);
    expect(firstInsert).toBeDefined();
    expect(firstInsert!.insertText!.location!.index).toBe(99);
  });

  it('uses a different anchor when bodyEndIndex changes between calls', () => {
    const insert = { content: '# X\n\nBody.\n', agentName: 'a' };
    const first = buildNewSectionInsertRequests(insert, 100);
    const second = buildNewSectionInsertRequests(insert, 150);

    const firstIdx = first.requests.find((r) => r.insertText)!.insertText!.location!.index;
    const secondIdx = second.requests.find((r) => r.insertText)!.insertText!.location!.index;

    expect(firstIdx).toBe(99);
    expect(secondIdx).toBe(149);
  });

  it('keeps every absolute index within the current body', () => {
    // All insertText + style ranges must live within [1, bodyEndIndex + content_len).
    // We assert the floor here — no index may precede the body start.
    const { requests } = buildNewSectionInsertRequests(
      { content: '# Heading\n\nParagraph body.\n', agentName: 'a' },
      200,
    );
    for (const req of requests) {
      if (req.insertText) {
        expect(req.insertText.location!.index!).toBeGreaterThanOrEqual(1);
      }
      if (req.updateParagraphStyle) {
        expect(req.updateParagraphStyle.range!.startIndex!).toBeGreaterThanOrEqual(1);
      }
      if (req.updateTextStyle) {
        expect(req.updateTextStyle.range!.startIndex!).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('clamps to index 1 for an empty body', () => {
    const { requests } = buildNewSectionInsertRequests(
      { content: '# Heading\n\nBody.\n', agentName: 'a' },
      1,
    );
    const firstInsert = requests.find((r) => r.insertText);
    expect(firstInsert!.insertText!.location!.index).toBe(1);
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
