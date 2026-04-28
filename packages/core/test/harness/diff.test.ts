import { describe, it, test, expect } from 'vitest';
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
 * Flatten the body text of a doc built via buildDocAndMap — concatenate
 * each paragraph's textRun content in order. Doc-index 1 maps to
 * bodyText[0]; this matches how applyRequests models the buffer.
 */
function docBodyText(doc: docs_v1.Schema$Document): string {
  let text = '';
  for (const el of doc.body?.content ?? []) {
    if (!el.paragraph) continue;
    for (const e of el.paragraph.elements ?? []) {
      if (e.textRun?.content) text += e.textRun.content;
    }
  }
  return text;
}

/**
 * Apply a sequence of Google Docs batchUpdate requests to a flat text
 * buffer that models the doc body (doc-index 1 maps to bodyText[0]).
 * Mirrors the simulator in diff-pipeline.test.ts. Supports insertText
 * and deleteContentRange; style/named-range/etc. requests are ignored
 * because they don't change text content.
 *
 * Use to verify the FINAL STATE of the doc after a diff's requests are
 * applied — a complement to the request-shape checks above. Bugs in
 * request sequencing (inserts that reference already-deleted indices,
 * overlapping deletes, missing newlines between paragraphs) surface
 * here even when the shape assertions pass.
 */
function applyRequests(bodyText: string, requests: docs_v1.Schema$Request[]): string {
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
  }
  return buf;
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
    expect(sections[0].startLine).toBe(0);
    expect(sections[0].endLine).toBe(3);
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

  it('flattens heading hierarchy into peer sections', () => {
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
    // Full pin: when ours === base the merge must emit exactly theirs,
    // with no section dropped, duplicated, or reordered.
    expect(result.mergedMarkdown).toBe(theirs);
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
    // Full pin: when theirs === base the merge must emit exactly ours.
    expect(result.mergedMarkdown).toBe(ours);
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
    // Full pin: both non-overlapping edits survive in their original
    // section positions, no duplication, no reordering.
    expect(result.mergedMarkdown).toBe(
      '# Intro\n\nSomeone updated intro.\n\n# Details\n\nAgent updated details.\n',
    );
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

    // The "ours" block (between <<<<<<< and =======) must contain
    // "Ours." and the "theirs" block (between ======= and >>>>>>>)
    // must contain "Theirs.".
    const md = result.mergedMarkdown;
    const startMarker = md.indexOf('<<<<<<<');
    const midMarker = md.indexOf('=======', startMarker);
    const endMarker = md.indexOf('>>>>>>>', midMarker);
    expect(startMarker).toBeGreaterThan(-1);
    expect(midMarker).toBeGreaterThan(startMarker);
    expect(endMarker).toBeGreaterThan(midMarker);
    const oursBlock = md.slice(startMarker, midMarker);
    const theirsBlock = md.slice(midMarker, endMarker);
    expect(oursBlock).toContain('Ours.');
    expect(theirsBlock).toContain('Theirs.');
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
    // When theirs === base the merge must emit exactly ours — the new
    // section lands in its original position with no reordering.
    expect(result.mergedMarkdown).toBe(ours);
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
    // Mirror of the previous test: when ours === base the merge must
    // emit exactly theirs.
    expect(result.mergedMarkdown).toBe(theirs);
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
    // Deletion survives: when theirs === base the merge must emit
    // exactly ours, with the "# Remove" section fully gone.
    expect(result.mergedMarkdown).toBe(ours);
  });

  it('handles document with no headings (single section merge)', () => {
    const base = 'Original text.\n';
    const ours = 'Agent text.\n';
    const theirs = base;

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.mergedMarkdown).toBe(ours);
  });

  it('handles conflict in document with no headings', () => {
    const base = 'Original.\n';
    const ours = 'Agent version.\n';
    const theirs = 'Human version.\n';

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(true);
    expect(result.mergedMarkdown).toContain('<<<<<<<');
  });

  it('resolves conflicts via resolver callback passed to computeDocDiff', async () => {
    // mergeDocuments itself has no resolver parameter; the resolver
    // callback lives on computeDocDiff. This test verifies that when a
    // resolver returns text free of conflict markers, computeDocDiff
    // treats the conflict as resolved (conflictsResolved > 0 in effect,
    // and the resulting batchUpdate requests emit the resolver's text).
    const base = `# Section

Original.
`;
    const ours = `# Section

Ours.
`;
    const theirs = `# Section

Theirs.
`;

    const { doc, indexMap } = buildDocAndMap(theirs, [
      { text: 'Section', mdOffset: 0 },
      { text: 'Theirs.', mdOffset: theirs.indexOf('Theirs.') },
    ]);

    // Resolver chooses "ours" and strips all conflict markers.
    const resolver = async (conflictText: string) =>
      conflictText
        .replace(/<<<<<<<[^\n]*\n/g, '')
        .replace(/=======[^\n]*\n/g, '')
        .replace(/>>>>>>>[^\n]*\n/g, '')
        .replace('Theirs.\n', '');

    const result = await computeDocDiff(
      base,
      ours,
      theirs,
      doc,
      indexMap,
      'test-agent',
      resolver,
    );

    // The resolver successfully produced marker-free text, so the
    // engine should emit inserts that carry "Ours." (agent's chosen
    // side) and no raw marker strings.
    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Ours.');
    expect(insertedText).not.toContain('<<<<<<<');
    expect(insertedText).not.toContain('>>>>>>>');
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
    // Three-way merge with non-overlapping edits: A and C from theirs,
    // B from ours. Pin the full output so a regression that drops a
    // section or reorders them would fail here.
    expect(result.mergedMarkdown).toBe(
      '# A\n\nAlpha updated by human.\n\n# B\n\nBeta updated by agent.\n\n# C\n\nCharlie updated by human.\n',
    );
  });

  // KNOWN BUG — wrapped in it.fails so this test asserts user-expected
  // behavior (CONFLICT on edit/delete race) and flips to green once the
  // merge engine surfaces the race. Remove it.fails at that point.
  //
  // The scenario: agent modified section A while another party deleted
  // section A concurrently. A human should be asked to decide whether
  // the edit or the delete should win. Currently the merge engine
  // resurrects the section silently, which is wrong.
  it.fails('reports a conflict when the agent edits a section the other side deleted', () => {
    const base = `# A

Original.
`;
    const ours = `# A

Agent modified.
`;
    const theirs = ``;

    const result = mergeDocuments(base, ours, theirs);

    // User-expected: this is an edit/delete race, must surface as a
    // conflict so a human picks a winner.
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictSections.length).toBeGreaterThan(0);
  });

  // Companion to the it.fails above. Locks in the CURRENT (buggy) behavior
  // so that when the edit/delete race is eventually surfaced as a conflict
  // BOTH tests break and someone must come update this pair together.
  it('CURRENT-BUG: silently keeps the agent edit when other side deleted the section', () => {
    const base = `# A

Original.
`;
    const ours = `# A

Agent modified.
`;
    const theirs = ``;

    const result = mergeDocuments(base, ours, theirs);

    expect(result.hasConflicts).toBe(false);
    expect(result.conflictSections).toHaveLength(0);
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

  // KNOWN BUG — wrapped in it.fails so this test acts as a TODO pin. The
  // test asserts the user-expected behavior: when the resolver refuses to
  // strip conflict markers, every marker should survive through into the
  // emitted insertText requests (so the agent can see the conflict it
  // needs to resolve). Today the diff engine silently drops the middle
  // `=======` separator from the request stream even though
  // mergeDocuments produces it. Remove it.fails once that is fixed.
  it.fails('keeps conflict markers when the resolver callback leaves them in place', async () => {
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

    // The markers must survive through into the emitted batchUpdate:
    // concatenate every insertText payload and verify all three markers
    // still appear, along with both conflict bodies. A regression that
    // silently stripped the markers in the diff engine would fail here
    // even though the separate mergeDocuments probe below would still
    // pass.
    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('<<<<<<<');
    expect(insertedText).toContain('=======');
    expect(insertedText).toContain('>>>>>>>');
    expect(insertedText).toContain('Ours.');
    expect(insertedText).toContain('Theirs.');
    // And markers must appear in the canonical order: start, mid, end.
    const startIdx = insertedText.indexOf('<<<<<<<');
    const midIdx = insertedText.indexOf('=======', startIdx);
    const endIdx = insertedText.indexOf('>>>>>>>', midIdx);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(midIdx).toBeGreaterThan(startIdx);
    expect(endIdx).toBeGreaterThan(midIdx);

    // Belt-and-braces: the underlying merge's serialized markdown still
    // carries the markers too, so nothing upstream stripped them.
    const mergeResult = mergeDocuments(base, ours, theirs);
    expect(mergeResult.mergedMarkdown).toContain('<<<<<<<');
    expect(mergeResult.mergedMarkdown).toContain('=======');
    expect(mergeResult.mergedMarkdown).toContain('>>>>>>>');
  });

  // Companion to the it.fails above. Locks in CURRENT (buggy) behavior:
  // the middle `=======` separator is dropped from the emitted insertText
  // requests even though mergeDocuments produces it. When the bug is
  // fixed BOTH this test and its it.fails sibling must be updated together.
  it('CURRENT-BUG: drops the ======= separator from insertText when resolver is a no-op', async () => {
    const base = `# S

Original.
`;
    const ours = `# S

Ours.
`;
    const theirs = `# S

Theirs.
`;

    const { doc, indexMap } = buildDocAndMap(theirs, [
      { text: 'S', mdOffset: 0 },
      { text: 'Theirs.', mdOffset: theirs.indexOf('Theirs.') },
    ]);

    const noopResolver = async (conflictText: string) => conflictText;

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent', noopResolver);

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');

    expect(insertedText).toContain('<<<<<<<');
    expect(insertedText).not.toContain('=======');

    const mergeResult = mergeDocuments(base, ours, theirs);
    expect(mergeResult.mergedMarkdown).toContain('=======');
  });

  test('preserves section reordering from theirs when ours is unchanged', () => {
    // base has [A, B]; ours === base (agent made no changes); theirs
    // reorders to [B, A]. The merge should follow theirs' ordering.
    const base = '# A\n\nBase content A.\n\n# B\n\nBase content B.\n';
    const ours = base;
    const theirs = '# B\n\nBase content B.\n\n# A\n\nBase content A.\n';

    const result = mergeDocuments(base, ours, theirs);
    expect(result.hasConflicts).toBe(false);

    const aIdx = result.mergedMarkdown.indexOf('# A');
    const bIdx = result.mergedMarkdown.indexOf('# B');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeLessThan(aIdx);
  });

  test('preserves section reordering from ours when theirs is unchanged', () => {
    // Mirror: agent reorders, human made no changes.
    const base = '# A\n\nBase content A.\n\n# B\n\nBase content B.\n';
    const ours = '# B\n\nBase content B.\n\n# A\n\nBase content A.\n';
    const theirs = base;

    const result = mergeDocuments(base, ours, theirs);
    expect(result.hasConflicts).toBe(false);

    const aIdx = result.mergedMarkdown.indexOf('# A');
    const bIdx = result.mergedMarkdown.indexOf('# B');
    expect(bIdx).toBeLessThan(aIdx);
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

    // Tighter assertion: the delete endIndex should equal exactly the
    // paragraph-end of the target line "Content A." — i.e., the doc
    // index where the NEXT paragraph ("Second" heading) starts. Deriving
    // from the input ensures the engine stops precisely at the line
    // boundary rather than over-deleting into neighbouring paragraphs.
    const secondHeadingStart = indexMap.find(
      (e) => e.mdOffset === base.indexOf('# Second'),
    )!.docIndex;
    expect(endIndex).toBe(secondHeadingStart);
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

    // Verify the delete covers exactly "Paragraph two will change.\n" —
    // the changed paragraph plus its trailing newline. Any larger delete
    // would wipe unchanged paragraphs and strip their comment anchors.
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(1);
    const delRange = deleteReqs[0].deleteContentRange!.range!;
    const deleteSize = delRange.endIndex! - delRange.startIndex!;
    expect(deleteSize).toBe('Paragraph two will change.\n'.length);
    // And the delete starts at the changed paragraph's doc index.
    const paraTwoStart = indexMap.find((e) => e.mdOffset === base.indexOf('Paragraph two'))!.docIndex;
    expect(delRange.startIndex).toBe(paraTwoStart);
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

    // The delete must cover the entire old line "Summer's watermelon"
    // (19 UTF-16 units). The trailing '\n' is clamped off because this
    // paragraph sits at body end — so the expected delete size is
    // exactly the line length, no more, no less.
    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();
    const delSize =
      deleteReq!.deleteContentRange!.range!.endIndex! -
      deleteReq!.deleteContentRange!.range!.startIndex!;
    expect(delSize).toBe("Summer's watermelon".length);

    // The insert must contain the new text and start at the old line's position.
    const insertReqs = result.requests.filter((r) => r.insertText);
    const insertTexts = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertTexts).toContain("Summer's melon treat");
    const oldLineDocIndex = indexMap.find((e) => e.mdOffset === base.indexOf("Summer's watermelon"))!.docIndex;
    expect(insertReqs[0].insertText!.location!.index).toBe(oldLineDocIndex);

    // Apply the requests to the body buffer and verify the final state:
    // the old "Summer's watermelon" line is replaced by "Summer's melon
    // treat", with the three preceding paragraphs untouched and a
    // single trailing newline. A sequencing bug (insert landing at the
    // wrong index, delete overshooting, leftover "S" from the old line)
    // would surface here even though the request-shape assertions pass.
    const applied = applyRequests(docBodyText(doc), result.requests);
    expect(applied).toBe(
      "A haiku about fruit\nGreen rind hides the sweet\nRed flesh bursting\nSummer's melon treat\n",
    );
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

    // Apply the requests and verify the final buffer matches the doc
    // shape of `ours`. This is the stricter check the old comment here
    // flagged as missing: it catches bugs where an insert's index is
    // still valid in the BASE doc but invalid after preceding deletes
    // shift the buffer.
    const applied = applyRequests(docBodyText(doc), result.requests);
    expect(applied).toBe(
      'Section\nLine one MODIFIED.\nLine two.\nLine three MODIFIED.\nNew line four.\nNew line five.\n',
    );
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
    // `A.` paragraph lives immediately before C in the fake doc. Its
    // trailing '\n' lands at (aBodyStart + "A.".length), so the earliest
    // valid insert for B is right after A's body paragraph ends.
    const aBodyStart = indexMap.find((e) => e.mdOffset === base.indexOf('A.'))!.docIndex;
    const aBodyEnd = aBodyStart + 'A.\n'.length; // 4

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const insertReqs = result.requests.filter((r) => r.insertText);
    const insertedText = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertedText).toContain('B inserted.');

    // Positional check: the "B inserted." insert must land in the gap
    // between A's body and C's heading. This is tighter than the prior
    // bodyEndIndex-only check, which would pass even if B landed inside
    // Section A. When a new section is inserted mid-doc the engine
    // first emits a `\n` at sectionCStart and then issues the
    // markdown-derived inserts at actualInsertAt = sectionCStart + 1
    // (and chains from there). Allow a small slack above sectionCStart
    // for that leading-newline shift; it must still be far from aBodyEnd
    // downwards and nowhere near bodyEnd upwards.
    const bInsertReq = insertReqs.find((r) =>
      (r.insertText!.text ?? '').includes('B inserted.'),
    );
    expect(bInsertReq).toBeDefined();
    const bInsertIdx = bInsertReq!.insertText!.location!.index!;
    expect(bInsertIdx).toBeGreaterThanOrEqual(aBodyEnd);
    // The chain of inserts for "# B\n\nB inserted.\n" stays near the
    // anchor — allow at most the content's markdown length of slack.
    expect(bInsertIdx).toBeLessThanOrEqual(sectionCStart + '# B\n\nB inserted.\n'.length);

    // The primary insertion anchor is at or before Section C's start.
    // (Follow-up inserts in the same batch chain off that anchor, so
    // their raw indices are allowed to shift forward.)
    const firstInsertIdx = insertReqs[0].insertText!.location!.index!;
    expect(firstInsertIdx).toBeLessThanOrEqual(sectionCStart);
    // No CONTENT insert lands at or past the body-end tail. A bare '\n'
    // separator that runs after the content inserts is allowed to point
    // past pre-edit bodyEndIndex — batchUpdate processes requests
    // sequentially, so the content has already shifted the doc by the
    // time the separator executes. Exclude single-newline inserts.
    const bodyEndIndex = doc.body!.content![doc.body!.content!.length - 1].endIndex!;
    for (const req of insertReqs) {
      if (req.insertText!.text === '\n') continue;
      expect(req.insertText!.location!.index!).toBeLessThan(bodyEndIndex - 1);
    }

    // Apply the requests and verify the final buffer: heading+body for
    // A, the new B section fully inserted between A and C, and C kept
    // intact. This catches sequencing bugs (e.g., B's content landing
    // after C's heading) that the positional checks above miss.
    const applied = applyRequests(docBodyText(doc), result.requests);
    expect(applied).toBe('A\nA.\nB\nB inserted.\nC\nC.\n');
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
    // Google Docs doesn't store "## " as literal text; heading levels are
    // encoded as updateParagraphStyle(namedStyleType=HEADING_N) requests.
    // So assert a HEADING_2 style request was emitted (confirming the
    // level change was detected and applied), not that "## " appears in
    // the raw insertText payload.
    const styledAsH2 = result.requests.some(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_2',
    );
    expect(styledAsH2).toBe(true);
    // And the heading text "A" must still be reissued as inserted text.
    const insertedText = insertReqs.map((r) => r.insertText!.text).join('');
    expect(insertedText).toContain('A');
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

  it('preserves both occurrences when duplicate heading text is present', async () => {
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

    const mergeResult = mergeDocuments(base, ours, theirs);

    expect(mergeResult.hasConflicts).toBe(false);
    // Pin the full merged markdown, not substrings. Both `# Notes`
    // occurrences must survive in original order; the first body is
    // updated, the second is untouched.
    expect(mergeResult.mergedMarkdown).toBe(
      '# Notes\n\nFirst updated.\n\n# Notes\n\nSecond.\n',
    );

    // The diff engine (not just the merge layer) must also handle the
    // duplicate headings correctly: the "Second." body must NOT end up
    // inside any delete range, and the inserted text must include
    // "First updated." exactly once.
    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Notes', mdOffset: 0 },
      { text: 'First.', mdOffset: base.indexOf('First.') },
      { text: 'Notes', mdOffset: base.indexOf('# Notes', 1) },
      { text: 'Second.', mdOffset: base.indexOf('Second.') },
    ]);
    const secondBodyStart = indexMap.find((e) => e.mdOffset === base.indexOf('Second.'))!.docIndex;
    const secondBodyEnd = secondBodyStart + 'Second.'.length;

    const diff = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(diff.hasChanges).toBe(true);
    for (const req of diff.requests) {
      if (req.deleteContentRange) {
        const r = req.deleteContentRange.range!;
        const overlapsSecondBody = r.startIndex! < secondBodyEnd && secondBodyStart < r.endIndex!;
        expect(overlapsSecondBody).toBe(false);
      }
    }
    const insertedText = diff.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText.match(/First updated\./g) ?? []).toHaveLength(1);
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
        // The delete must stop BEFORE Body B starts — any endIndex past
        // bodyBDocIndex would eat into the preserved paragraph.
        expect(r.endIndex!).toBeLessThanOrEqual(bodyBDocIndex);
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
    // Exactly one delete — the Item 2 line. Size is exactly
    // "Item 2\n".length (7): the fake doc stores the bullet as a
    // paragraph whose text is "Item 2\n" — the "- " marker is not
    // stored, it's encoded via the bullet property.
    expect(deleteReqs).toHaveLength(1);
    const delStart = deleteReqs[0].deleteContentRange!.range!.startIndex!;
    const delEnd = deleteReqs[0].deleteContentRange!.range!.endIndex!;
    expect(delStart).toBe(item2Start);
    expect(delEnd - delStart).toBe('Item 2\n'.length);

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

    // The header row and the unchanged body rows must NOT be inside any
    // delete range — only the `| c | d |` row gets rewritten.
    const headerStart = indexMap[0].docIndex;
    const separatorStart = indexMap[1].docIndex;
    const unchangedRowStart = indexMap[2].docIndex;
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    for (const req of deleteReqs) {
      const r = req.deleteContentRange!.range!;
      for (const paraStart of [headerStart, separatorStart, unchangedRowStart]) {
        const paraInside = paraStart >= r.startIndex! && paraStart < r.endIndex!;
        expect(paraInside).toBe(false);
      }
    }
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
    // The `**` markers are stripped from the inserted text (Google Docs
    // doesn't keep them as literal characters) and re-encoded as an
    // updateTextStyle(bold=true) request. Locate that request and verify
    // its range maps to exactly the "extremely bold" substring of the
    // inserted plain-text line — a bug that bolded the wrong slice (e.g.
    // just "bold", or the entire line) would fail here.
    const boldReq = result.requests.find(
      (r) =>
        r.updateTextStyle?.textStyle?.bold === true &&
        r.updateTextStyle?.fields?.includes('bold'),
    );
    expect(boldReq).toBeDefined();
    // Reconstruct the plain-text inserted line, find where "extremely
    // bold" lives inside it, and derive the expected doc-index range.
    const insertReq = result.requests.find((r) => r.insertText);
    expect(insertReq).toBeDefined();
    const insertStart = insertReq!.insertText!.location!.index!;
    const insertedLine = insertReq!.insertText!.text!;
    const boldStart = insertedLine.indexOf('extremely bold');
    expect(boldStart).toBeGreaterThanOrEqual(0);
    const range = boldReq!.updateTextStyle!.range!;
    expect(range.startIndex).toBe(insertStart + boldStart);
    expect(range.endIndex).toBe(insertStart + boldStart + 'extremely bold'.length);
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

    // The delete range must fully cover the old "内容。" paragraph.
    // In the fake doc, that paragraph holds "内容。\n" (4 UTF-16 code
    // units: 3 glyphs + '\n'). Clamping may chop the trailing '\n'
    // because the paragraph sits at body end, but the three old-content
    // code units must all be inside the delete range.
    const oldContentStart = indexMap.find(
      (e) => e.mdOffset === base.indexOf('内容。'),
    )!.docIndex;
    const oldContentLen = '内容。'.length; // 3 UTF-16 units
    const deleteReq = result.requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();
    const r = deleteReq!.deleteContentRange!.range!;
    expect(r.startIndex!).toBeLessThanOrEqual(oldContentStart);
    expect(r.endIndex!).toBeGreaterThanOrEqual(oldContentStart + oldContentLen);
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
    const oldLine = 'This is a very long line that should become short.';
    const base = `${oldLine}\n`;
    const ours = `Short.\n`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: oldLine, mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(1);
    const delSize =
      deleteReqs[0].deleteContentRange!.range!.endIndex! -
      deleteReqs[0].deleteContentRange!.range!.startIndex!;
    // Exactly the old line's length — trailing '\n' is clamped off at
    // body end (single-paragraph doc, delete extends to body end).
    expect(delSize).toBe(oldLine.length);

    const insertedText = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text)
      .join('');
    expect(insertedText).toContain('Short.');
  });

  it('longer replacement: short line becomes long', async () => {
    const oldLine = 'Short.';
    const base = `${oldLine}\n`;
    const ours = `This is a much longer line than before.\n`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: oldLine, mdOffset: 0 },
    ]);

    const result = await computeDocDiff(base, ours, theirs, doc, indexMap, 'test-agent');
    expect(result.hasChanges).toBe(true);

    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(1);
    const delSize =
      deleteReqs[0].deleteContentRange!.range!.endIndex! -
      deleteReqs[0].deleteContentRange!.range!.startIndex!;
    // Exactly the old line's length — trailing '\n' is clamped off at
    // body end (single-paragraph doc, delete extends to body end).
    expect(delSize).toBe(oldLine.length);

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

    // Paragraphs 6 and 8 are unchanged neighbours of paragraph 7. Their
    // text MUST NOT fall inside any delete range — otherwise they'd be
    // destroyed and re-inserted, losing any comments anchored to them.
    // Compute each unchanged paragraph's doc start by walking the fake
    // doc's content list (all paragraphs are "Paragraph number N.\n").
    const bodyContent = doc.body!.content!;
    const paraDocStart = (n: number) => {
      const para = bodyContent.find(
        (el) =>
          el.paragraph?.elements?.[0]?.textRun?.content ===
          `Paragraph number ${n}.\n`,
      );
      if (!para) throw new Error(`paragraph ${n} not found in fake doc`);
      return para.startIndex!;
    };
    const p6Start = paraDocStart(6);
    const p8Start = paraDocStart(8);
    const p6Len = 'Paragraph number 6.'.length;
    const p8Len = 'Paragraph number 8.'.length;
    const deleteReqs = result.requests.filter((r) => r.deleteContentRange);
    for (const req of deleteReqs) {
      const r = req.deleteContentRange!.range!;
      // Check the paragraphs' text ranges don't intersect this delete.
      const p6Overlap = r.startIndex! < p6Start + p6Len && p6Start < r.endIndex!;
      const p8Overlap = r.startIndex! < p8Start + p8Len && p8Start < r.endIndex!;
      expect(p6Overlap).toBe(false);
      expect(p8Overlap).toBe(false);
    }
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

  it('single entry at the exact offset returns the entry docIndex', () => {
    // Spot-check: the single-entry path agrees with the multi-entry path at
    // the fixed point, so the fallback is a true extrapolation from the
    // known anchor and not an off-by-one.
    expect(
      interpolateDocIndex(100, [{ mdOffset: 100, docIndex: 80 }], 999),
    ).toBe(80);
  });

  it('handles single entry — extrapolation before', () => {
    // NOTE: With a single index map entry there is no second point to
    // derive a drift ratio from, so interpolateDocIndex falls back to a
    // 1:1 md-to-doc mapping. This is distinct from the multi-entry case
    // covered by the L1724 regression test ("does NOT use 1:1 mapping"),
    // where a real ratio IS available and must be used. For the
    // single-entry case 1:1 is the best we can do.
    const indexMap: IndexMapEntry[] = [
      { mdOffset: 100, docIndex: 80 },
    ];
    // Before the only entry: 80 - (100 - 50) = 30
    expect(interpolateDocIndex(50, indexMap, 999)).toBe(30);
  });

  it('handles single entry — extrapolation after', () => {
    // NOTE: Same 1:1 fallback rationale as the previous test — a single
    // entry gives us no ratio, so we extrapolate 1:1 from the entry and
    // clamp to the fallback. Contrast with the L1724 regression test,
    // which pins that 1:1 is NOT used when a real ratio is available.
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

// ── Comment-anchor preservation ────────────────────────────────────
//
// Google Docs comments are anchored to a quoted span of text. A
// batchUpdate that deletes the bytes the anchor covers detaches the
// comment ("the original content has been deleted"). The safeguards
// below ensure that an agent edit which would erase a comment's anchor
// text is reverted at the section level so the comment stays alive.
// (Direct unit tests for `preserveCommentAnchors` live in
// `diff-anchor-splice.test.ts`; this block tests the integration
// through `computeDocDiff`.)

describe('computeDocDiff › comment anchor preservation', () => {
  it('does not delete an anchor line the agent rewrote', async () => {
    const base = `# Intro

Keep me, I am quoted.

# Other

Untouched.
`;
    // Agent's edit rewrites the anchor line.
    const ours = `# Intro

Rewritten line.

# Other

Untouched.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Intro', mdOffset: 0 },
      { text: 'Keep me, I am quoted.', mdOffset: base.indexOf('Keep me') },
      { text: 'Other', mdOffset: base.indexOf('# Other') },
      { text: 'Untouched.', mdOffset: base.indexOf('Untouched.') },
    ]);

    const result = await computeDocDiff(
      base, ours, theirs, doc, indexMap, 'test-agent',
      undefined,
      { commentAnchors: [{ commentId: 'c1', quotedText: 'Keep me, I am quoted.' }] },
    );

    // The anchor's containing section was reverted, so this edit
    // collapses to a no-op (Intro reverted, Other unchanged).
    expect(result.preservedAnchors.map((p) => p.quotedText)).toEqual(['Keep me, I am quoted.']);
    expect(result.hasChanges).toBe(false);
    // No deleteContentRange should target the anchor's doc range.
    const anchorStart = indexMap.find((e) => e.mdOffset === base.indexOf('Keep me'))!.docIndex;
    for (const r of result.requests) {
      if (r.deleteContentRange) {
        const start = r.deleteContentRange.range!.startIndex!;
        const end = r.deleteContentRange.range!.endIndex!;
        expect(anchorStart < start || anchorStart >= end).toBe(true);
      }
    }
  });

  it('keeps unrelated edits when one section has an anchor that must survive', async () => {
    const base = `# Intro

Keep me, I am quoted.

# Other

Old line.
`;
    // Agent edits BOTH the anchor section and an unrelated section.
    const ours = `# Intro

Replaced intro body.

# Other

New line.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'Intro', mdOffset: 0 },
      { text: 'Keep me, I am quoted.', mdOffset: base.indexOf('Keep me') },
      { text: 'Other', mdOffset: base.indexOf('# Other') },
      { text: 'Old line.', mdOffset: base.indexOf('Old line.') },
    ]);

    const result = await computeDocDiff(
      base, ours, theirs, doc, indexMap, 'test-agent',
      undefined,
      { commentAnchors: [{ commentId: 'c1', quotedText: 'Keep me, I am quoted.' }] },
    );

    expect(result.preservedAnchors.map((p) => p.quotedText)).toEqual(['Keep me, I am quoted.']);
    expect(result.hasChanges).toBe(true);

    // Apply the requests and verify the resulting doc body still
    // contains the anchor and reflects the unrelated edit.
    const initialBody = docBodyText(doc);
    const finalBody = applyRequests(initialBody, result.requests);
    expect(finalBody).toContain('Keep me, I am quoted.');
    expect(finalBody).toContain('New line.');
    expect(finalBody).not.toContain('Old line.');
  });

  it('restores a section the agent deleted entirely when it held an anchor', async () => {
    const base = `# A

A-body.

# B

Critical anchor in B.

# C

C-body.
`;
    // Agent removed the entire B section.
    const ours = `# A

A-body.

# C

C-body.
`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A', mdOffset: 0 },
      { text: 'A-body.', mdOffset: base.indexOf('A-body.') },
      { text: 'B', mdOffset: base.indexOf('# B') },
      { text: 'Critical anchor in B.', mdOffset: base.indexOf('Critical') },
      { text: 'C', mdOffset: base.indexOf('# C') },
      { text: 'C-body.', mdOffset: base.indexOf('C-body.') },
    ]);

    const result = await computeDocDiff(
      base, ours, theirs, doc, indexMap, 'test-agent',
      undefined,
      { commentAnchors: [{ commentId: 'c1', quotedText: 'Critical anchor in B.' }] },
    );

    expect(result.preservedAnchors.map((p) => p.quotedText)).toEqual(['Critical anchor in B.']);
    // Either no changes are emitted (B is restored to identical), or
    // the requests don't actually delete the anchor's text. Verify the
    // latter by simulating the request stream.
    const initialBody = docBodyText(doc);
    const finalBody = applyRequests(initialBody, result.requests);
    expect(finalBody).toContain('Critical anchor in B.');
  });

  it('proceeds normally when no anchors would be lost', async () => {
    const base = `# A\n\nUnchanged anchor.\n\nOther text.\n`;
    const ours = `# A\n\nUnchanged anchor.\n\nDifferent other text.\n`;
    const theirs = base;

    const { doc, indexMap } = buildDocAndMap(base, [
      { text: 'A', mdOffset: 0 },
      { text: 'Unchanged anchor.', mdOffset: base.indexOf('Unchanged anchor.') },
      { text: 'Other text.', mdOffset: base.indexOf('Other text.') },
    ]);

    const result = await computeDocDiff(
      base, ours, theirs, doc, indexMap, 'test-agent',
      undefined,
      { commentAnchors: [{ commentId: 'c1', quotedText: 'Unchanged anchor.' }] },
    );

    // Anchor is on an unchanged line, so nothing was preserved; the
    // edit goes through normally.
    expect(result.preservedAnchors).toEqual([]);
    expect(result.hasChanges).toBe(true);
    const initialBody = docBodyText(doc);
    const finalBody = applyRequests(initialBody, result.requests);
    expect(finalBody).toContain('Unchanged anchor.');
    expect(finalBody).toContain('Different other text.');
  });
});
