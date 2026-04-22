import { describe, it, expect } from 'vitest';
import { countOccurrences } from '../../src/commands/comment.js';

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
});
