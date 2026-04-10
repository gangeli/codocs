import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import {
  parseSections,
  mergeDocuments,
  computeDocDiff,
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

    // Deletes should only cover the range around paragraph two (line 4, doc ~43),
    // not paragraph one (doc 12-41) or paragraph three (doc 71+) or the heading (doc 1-10)
    for (const req of result.requests) {
      if (req.deleteContentRange) {
        const start = req.deleteContentRange.range!.startIndex!;
        const end = req.deleteContentRange.range!.endIndex!;
        // Should not overlap with heading or paragraph one
        expect(start).toBeGreaterThanOrEqual(42);
        // Should not extend into paragraph three
        expect(end).toBeLessThanOrEqual(71);
      }
    }
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
});
