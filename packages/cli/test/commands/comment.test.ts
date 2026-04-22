import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Mock util.js BEFORE importing the command so registerCommentCommand picks
// up the mocked createClient/spin/withErrorHandler.
const mockClient = {
  readMarkdown: vi.fn(),
  addComment: vi.fn(),
};
const mockSpin = { succeed: vi.fn(), fail: vi.fn(), update: vi.fn(), stop: vi.fn() };

vi.mock('../../src/util.js', () => ({
  createClient: vi.fn(() => mockClient),
  spin: vi.fn(() => mockSpin),
  // Pass-through so command exceptions surface in tests as rejected promises.
  withErrorHandler: (fn: any) => fn,
}));

const { countOccurrences, extractDocId, registerCommentCommand } = await import(
  '../../src/commands/comment.js'
);

describe('countOccurrences', () => {
  it('returns 0 for no matches', () => {
    expect(countOccurrences('hello world', 'xyz')).toBe(0);
  });

  it('returns 1 for a single match', () => {
    expect(countOccurrences('hello world', 'world')).toBe(1);
  });

  it('returns count for multiple matches', () => {
    expect(countOccurrences('the cat sat on the mat', 'the')).toBe(2);
  });

  it('does not double-count overlapping occurrences', () => {
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
  });

  it('handles exact full string match', () => {
    expect(countOccurrences('hello', 'hello')).toBe(1);
  });

  it('returns 0 for needle longer than haystack', () => {
    expect(countOccurrences('abc', 'abcdef')).toBe(0);
  });

  it('returns 0 when haystack is empty and needle is not', () => {
    expect(countOccurrences('', 'x')).toBe(0);
  });
});

describe('extractDocId', () => {
  it('returns input unchanged when not a URL', () => {
    expect(extractDocId('1aBc-xyz_123')).toBe('1aBc-xyz_123');
  });

  it('extracts ID from a full /document/d/<id>/edit URL', () => {
    const url = 'https://docs.google.com/document/d/1aBc-xyz_123/edit';
    expect(extractDocId(url)).toBe('1aBc-xyz_123');
  });

  it('extracts ID from a URL with no trailing path', () => {
    expect(extractDocId('https://docs.google.com/document/d/abc123')).toBe('abc123');
  });

  it('preserves hyphens and underscores in the ID', () => {
    const url = 'https://docs.google.com/document/d/a_b-c_d/edit?tab=t.0';
    expect(extractDocId(url)).toBe('a_b-c_d');
  });
});

describe('registerCommentCommand', () => {
  beforeEach(() => {
    mockClient.readMarkdown.mockReset();
    mockClient.addComment.mockReset();
    mockSpin.succeed.mockReset();
    mockSpin.fail.mockReset();
    mockClient.addComment.mockResolvedValue('new-comment-id');
  });

  function run(argv: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerCommentCommand(program);
    return program.parseAsync(['node', 'codocs', 'comment', ...argv]);
  }

  it('calls addComment with raw docId, text, and no anchor when no options', async () => {
    await run(['doc-abc', 'Hello there']);

    expect(mockClient.readMarkdown).not.toHaveBeenCalled();
    expect(mockClient.addComment).toHaveBeenCalledTimes(1);
    expect(mockClient.addComment).toHaveBeenCalledWith('doc-abc', {
      content: 'Hello there',
      quotedText: undefined,
      agent: undefined,
    });
  });

  it('extracts doc ID from a full URL', async () => {
    await run([
      'https://docs.google.com/document/d/extracted-id/edit',
      'Hello',
    ]);

    expect(mockClient.addComment).toHaveBeenCalledWith(
      'extracted-id',
      expect.objectContaining({ content: 'Hello' }),
    );
  });

  it('passes agent name through to addComment', async () => {
    await run(['doc-1', 'Review this', '--agent', 'reviewer']);

    expect(mockClient.addComment).toHaveBeenCalledWith('doc-1', {
      content: 'Review this',
      quotedText: undefined,
      agent: { name: 'reviewer' },
    });
  });

  it('validates quote against the doc and reports ok when found once', async () => {
    mockClient.readMarkdown.mockResolvedValue('Some quoted text appears here.');
    await run(['doc-1', 'Comment', '--quote', 'quoted text']);

    expect(mockClient.readMarkdown).toHaveBeenCalledWith('doc-1');
    expect(mockSpin.succeed).toHaveBeenCalledWith('Quoted text found');
    expect(mockClient.addComment).toHaveBeenCalledWith('doc-1', {
      content: 'Comment',
      quotedText: 'quoted text',
      agent: undefined,
    });
  });

  it('still posts the comment when the quote is not found (falls back to unanchored)', async () => {
    mockClient.readMarkdown.mockResolvedValue('no match here');
    await run(['doc-1', 'Comment', '--quote', 'missing']);

    expect(mockSpin.fail).toHaveBeenCalledWith(
      expect.stringContaining('Quoted text not found'),
    );
    // The command still posts — it just warns the anchor won't attach.
    expect(mockClient.addComment).toHaveBeenCalledTimes(1);
    expect(mockClient.addComment).toHaveBeenCalledWith(
      'doc-1',
      expect.objectContaining({ quotedText: 'missing' }),
    );
  });

  it('reports multiple occurrences and anchors to the first', async () => {
    mockClient.readMarkdown.mockResolvedValue('foo foo foo');
    await run(['doc-1', 'Comment', '--quote', 'foo']);

    const calls = mockSpin.succeed.mock.calls.map((c) => c[0]);
    expect(calls.some((m: string) => m.includes('3 occurrences'))).toBe(true);
    expect(mockClient.addComment).toHaveBeenCalledTimes(1);
  });
});
