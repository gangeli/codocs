import { describe, it, expect } from 'vitest';

// Test the countOccurrences logic extracted from comment command
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

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

  it('handles overlapping needle positions correctly', () => {
    expect(countOccurrences('aaa', 'aa')).toBe(1);
  });

  it('handles exact full string match', () => {
    expect(countOccurrences('hello', 'hello')).toBe(1);
  });
});
