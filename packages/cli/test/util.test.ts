import { describe, it, expect } from 'vitest';
import { truncate } from '../src/util.js';

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long text with ellipsis', () => {
    expect(truncate('hello world foo bar', 10)).toBe('hello worl...');
  });

  it('replaces newlines with \\n', () => {
    expect(truncate('line1\nline2\nline3', 50)).toBe(
      'line1\\nline2\\nline3',
    );
  });

  it('handles exact boundary', () => {
    expect(truncate('12345', 5)).toBe('12345');
    expect(truncate('123456', 5)).toBe('12345...');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });

  it('handles newlines before truncation', () => {
    // Newlines are replaced before length check
    expect(truncate('a\nb', 4)).toBe('a\\nb');
    // After replacement 'a\\nb' is 4 chars, fits in maxLen 4
  });
});
