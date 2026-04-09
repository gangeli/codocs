import { describe, it, expect } from 'vitest';
import {
  parseSections,
  mergeDocuments,
  type MdSection,
} from '../../src/harness/diff.js';

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
